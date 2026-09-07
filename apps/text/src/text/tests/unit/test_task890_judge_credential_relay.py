"""TASK-890 — the judge's connection must survive the hop into guardrail.

Every guardrail-enabled generation 502'd, and the cause was a credential that
stopped one hop short. The gateway resolves an `AiProviderConnection` and injects
it as `provider_overrides` on `POST /generate`; text's input gate then called
guardrail's `/api/medical/validate` with NO overrides at all, so guardrail's judge
posted back to `/generate/internal/judge` carrying none — and this service, which
holds no endpoint or credential of its own, answered 503
`PROVIDER_CREDENTIALS_MISSING`. Guardrail opened its breaker, text failed closed,
the gateway returned 502.

Two properties are asserted here, and only this service can assert them:

* the input gate FORWARDS the blob it was given (serialized so the secret is
  usable on the far side — a `SecretStr` that arrives masked is the same outage
  with a longer stack), and forwards nothing when there is nothing to forward;
* an ENGINE-SERVED override is accepted KEYLESS. `ProviderOverride.api_key` was
  REQUIRED, so an override carrying only a `base_url` — the only thing guardrail
  can honestly build for a self-hosted engine, since it cannot decrypt a Vault
  ciphertext — was rejected at the wire model with a 422. A cloud provider with
  no key still fails closed; that is `require_api_key`'s job, not the model's.

The OUTPUT gate is deliberately NOT part of this: guardrail's outbound screen
delegates to `apps/nlp` (TASK-878/G1), never to this service, so an override
forwarded there would reach no adapter. Adding one would be a dead field on a
safety-critical wire.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr

from text.core.connection import require_api_key, require_connection
from text.core.exceptions import ProviderCredentialsError
from text.core.guardrail_posture import GuardrailPosture
from text.models.requests import GenerateRequest, ProviderOverride, serialize_provider_overrides
from text.services.external_guardrail import ExternalGuardrailClient

_BASE_URL = "http://guardrail.test"
TENANT = "11111111-1111-1111-1111-111111111111"

#: Exactly what the gateway injects for the platform's own LM Studio row.
_LM_STUDIO_OVERRIDE = {
    "lm-studio": {"api_key": "not-needed", "base_url": "http://localhost:1234/v1"}
}


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return _FakeResponse(self.payload)


def _client(http_client: Any) -> ExternalGuardrailClient:
    return ExternalGuardrailClient(
        base_url=_BASE_URL,
        http_client=http_client,
        app_state=SimpleNamespace(guardrail_posture=GuardrailPosture(enabled=True)),
    )


# ---------------------------------------------------------------------------
# The forward
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_forwards_the_injected_connection_to_guardrail() -> None:
    http = _RecordingClient({"is_medical": True, "confidence": 0.99})

    await _client(http).validate(
        prompt="patient reports chest pain",
        tenant_id=TENANT,
        provider_overrides=_LM_STUDIO_OVERRIDE,
    )

    body = http.calls[0]["json"]
    assert body["provider_overrides"] == _LM_STUDIO_OVERRIDE


@pytest.mark.asyncio
async def test_validate_sends_no_overrides_key_when_the_request_carried_none() -> None:
    """Absent stays absent: guardrail's own fallback resolves the engine row."""
    http = _RecordingClient({"is_medical": True, "confidence": 0.99})

    await _client(http).validate(prompt="hello", tenant_id=TENANT)

    assert "provider_overrides" not in http.calls[0]["json"]


def test_serialization_unwraps_the_secret_so_the_far_side_can_use_it() -> None:
    """A masked key is the same outage with a longer stack trace."""
    overrides = {
        "azure": ProviderOverride(
            api_key=SecretStr("byo-secret-value"),
            base_url="https://x.openai.azure.com",
            funding="platform",
        )
    }

    wire = serialize_provider_overrides(overrides)

    assert wire == {
        "azure": {
            "api_key": "byo-secret-value",
            "base_url": "https://x.openai.azure.com",
            "funding": "platform",
        }
    }
    assert serialize_provider_overrides(None) is None
    assert serialize_provider_overrides({}) is None


@pytest.mark.asyncio
async def test_the_input_gate_hands_the_requests_overrides_to_the_client() -> None:
    from text.api.endpoints.generate import _apply_guardrail_gate

    client = AsyncMock()
    client.validate = AsyncMock(return_value={"allowed": True, "is_medical": True})
    request_body = GenerateRequest(
        prompt="patient reports chest pain",
        provider="lm-studio",
        model="granite-guardian-4.1-8b",
        provider_overrides=_LM_STUDIO_OVERRIDE,  # type: ignore[arg-type]
    )

    await _apply_guardrail_gate(
        client,
        request_body=request_body,
        tenant_id=TENANT,
        app_state=SimpleNamespace(),
    )

    # Serialized, so the far side gets the usable key plus the funding attribution
    # the gateway stamped (defaulting to "tenant" when it stamped none).
    assert client.validate.await_args.kwargs["provider_overrides"] == {
        "lm-studio": {**_LM_STUDIO_OVERRIDE["lm-studio"], "funding": "tenant"}
    }


# ---------------------------------------------------------------------------
# Keyless engine-served overrides
# ---------------------------------------------------------------------------


def test_an_engine_served_override_is_accepted_with_only_a_base_url() -> None:
    """Guardrail can honestly supply an endpoint and nothing else — the key is
    Vault ciphertext it cannot decrypt, and the engine needs none."""
    request = GenerateRequest(
        prompt="x",
        provider="lm-studio",
        model="granite-guardian-4.1-8b",
        provider_overrides={"lm-studio": {"base_url": "http://localhost:1234/v1"}},  # type: ignore[arg-type]
    )

    connection = require_connection(request, provider="lm-studio")

    assert connection.base_url == "http://localhost:1234/v1"
    assert connection.api_key.get_secret_value() == ""


def test_a_cloud_provider_with_no_key_still_fails_closed() -> None:
    """Making the wire field optional must not make a keyless cloud call legal."""
    request = GenerateRequest(
        prompt="x",
        provider="azure",
        model="gpt-4o",
        provider_overrides={"azure": {"base_url": "https://x.openai.azure.com"}},  # type: ignore[arg-type]
    )

    with pytest.raises(ProviderCredentialsError):
        require_api_key(request, provider="azure")
