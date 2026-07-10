"""Unit tests for the SMR ExternalGuardrailClient (TASK-338, Phase 4b).

httpx is fully mocked — covers tenant-header propagation, the medical verdict
mapping, and the degrade-safe → fail-CLOSED posture (TASK-478) when the guardrail
is unreachable: a transient blip is absorbed by a bounded retry, a sustained
outage fails closed, and an errored guardrail can NEVER return ``allowed: True``.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from smr_v2.core.config import ExternalGuardrailConfig
from smr_v2.services.external_guardrail import ExternalGuardrailClient


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    """Records the POST and returns a canned medical-validate body."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return _FakeResponse(self.payload)


class _RaisingClient:
    def __init__(self) -> None:
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any):
        self.calls += 1
        raise RuntimeError("guardrail unreachable")


class _RaiseThenSucceedClient:
    """Raises ``fail_times`` times, then returns a canned medical-validate body."""

    def __init__(self, fail_times: int, payload: dict[str, Any]) -> None:
        self.fail_times = fail_times
        self.payload = payload
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("guardrail blip")
        return _FakeResponse(self.payload)


def _client(config: ExternalGuardrailConfig, http_client: Any) -> ExternalGuardrailClient:
    return ExternalGuardrailClient(settings=config, http_client=http_client)


@pytest.mark.asyncio
async def test_disabled_short_circuits_without_http_call() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(ExternalGuardrailConfig(enabled=False), http)

    result = await client.validate("some prompt")

    assert result["allowed"] is True
    assert result["reason"] == "external_guardrail_disabled"
    assert http.calls == []


@pytest.mark.asyncio
async def test_medical_content_is_allowed() -> None:
    http = _RecordingClient({"is_medical": True, "confidence": 0.95})
    client = _client(ExternalGuardrailConfig(enabled=True, require_medical=True), http)

    result = await client.validate("patient chest pain")

    assert result["allowed"] is True
    assert result["is_medical"] is True
    assert result["confidence"] == 0.95


@pytest.mark.asyncio
async def test_non_medical_blocked_when_require_medical() -> None:
    http = _RecordingClient({"is_medical": False, "confidence": 0.1})
    client = _client(ExternalGuardrailConfig(enabled=True, require_medical=True), http)

    result = await client.validate("schedule a meeting")

    assert result["allowed"] is False
    assert result["is_medical"] is False


@pytest.mark.asyncio
async def test_non_medical_allowed_when_not_require_medical() -> None:
    http = _RecordingClient({"is_medical": False})
    client = _client(ExternalGuardrailConfig(enabled=True, require_medical=False), http)

    result = await client.validate("schedule a meeting")

    assert result["allowed"] is True


@pytest.mark.asyncio
async def test_tenant_id_forwarded_as_header() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(ExternalGuardrailConfig(enabled=True), http)

    await client.validate("patient note", tenant_id="tenant-xyz")

    assert http.calls[0]["headers"]["X-Tenant-Id"] == "tenant-xyz"


@pytest.mark.asyncio
async def test_tenant_header_absent_when_no_tenant() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(ExternalGuardrailConfig(enabled=True), http)

    await client.validate("patient note")

    assert "X-Tenant-Id" not in http.calls[0]["headers"]


@pytest.mark.asyncio
async def test_service_token_forwarded_as_header() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(ExternalGuardrailConfig(enabled=True, service_token="svc-token"), http)

    await client.validate("patient note")

    assert http.calls[0]["headers"]["X-Service-Token"] == "svc-token"


@pytest.mark.asyncio
async def test_system_prompt_is_prepended_to_text() -> None:
    http = _RecordingClient({"is_medical": True})
    client = _client(ExternalGuardrailConfig(enabled=True), http)

    await client.validate("the prompt", system_prompt="the system")

    assert http.calls[0]["json"]["text"] == "the system\n\nthe prompt"


@pytest.mark.asyncio
async def test_fail_closed_blocks_when_guardrail_unreachable() -> None:
    http = _RaisingClient()
    client = _client(ExternalGuardrailConfig(enabled=True, retry_backoff_ms=0), http)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert result["reason"] == "external_guardrail_unavailable"
    assert "error" in result


# --- TASK-478: degrade-safe → fail-CLOSED posture --------------------------------


@pytest.mark.asyncio
async def test_transient_blip_absorbed_by_bounded_retry() -> None:
    # AC-2: one transient error then success → the blip is absorbed by the bounded
    # retry and the (medical) verdict is returned. Degrade-safe, NOT a hard fail.
    http = _RaiseThenSucceedClient(fail_times=1, payload={"is_medical": True, "confidence": 0.9})
    client = _client(ExternalGuardrailConfig(enabled=True, require_medical=True), http)

    result = await client.validate("patient chest pain")

    assert result["allowed"] is True
    assert result["is_medical"] is True
    assert http.calls == 2  # 1 blip + 1 successful retry


@pytest.mark.asyncio
async def test_sustained_outage_fails_closed_after_bounded_retries() -> None:
    # AC-3 / AC-1: every attempt errors → after the bounded retry budget the client
    # fails CLOSED with a deterministic not-allowed verdict — never allowed=True.
    http = _RaisingClient()
    client = _client(ExternalGuardrailConfig(enabled=True), http)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert result["reason"] == "external_guardrail_unavailable"
    assert "error" in result
    assert http.calls == 3  # default max_retries=2 → 3 bounded attempts


@pytest.mark.asyncio
async def test_fail_open_option_removed_from_config() -> None:
    # AC-1: the fail-open foot-gun is retired — the config option no longer exists,
    # so it cannot be flipped to silently ship unmoderated PHI on an outage.
    with pytest.raises(ValidationError):
        ExternalGuardrailConfig(enabled=True, fail_open=True)


@pytest.mark.asyncio
async def test_retry_budget_is_config_driven_no_retry() -> None:
    # AC-2: max_retries=0 → exactly one attempt (no retry), then fail closed.
    http = _RaisingClient()
    client = _client(ExternalGuardrailConfig(enabled=True, max_retries=0, retry_backoff_ms=0), http)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert http.calls == 1


@pytest.mark.asyncio
async def test_retry_budget_is_config_driven_bounded() -> None:
    # AC-2/AC-3: max_retries=3 → exactly 4 bounded attempts, then fail closed
    # (bounded — never an unbounded retry loop that bricks a request).
    http = _RaisingClient()
    client = _client(ExternalGuardrailConfig(enabled=True, max_retries=3, retry_backoff_ms=0), http)

    result = await client.validate("patient note")

    assert result["allowed"] is False
    assert http.calls == 4
