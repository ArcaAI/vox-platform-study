"""TASK-1016 — `/classify/topic` and `/classify/intent` must name text's provider AND model.

`apps/text` has no default model (`/generate` answers 422 without `model`) and, since
TASK-1012, no default provider either. `ExternalTextClient` posted only
`{prompt, stream, system_prompt}`, so every delegated topic/intent generation was refused
— and the 422 was retried as if it were an outage before surfacing as an opaque 503.

The selection is GATEWAY-INJECTED, like `model_name` on `/classify/text` (apps/nlp resolves no
config of its own): `text_provider` + `text_model` on the request body. Absent ⇒ fail closed
(503, named) BEFORE any call to `text`; never a default.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nlp.api.v1 import rest_api_router_v1
from nlp.core.config import ExternalTextConfig
from nlp.dependencies import get_external_text_client
from nlp.services.external_text_client import (
    ExternalTextClient,
    ExternalTextRejectedError,
    ExternalTextUnavailableError,
    GeneratedLabel,
)

#: The gateway-resolved connection entry `text` consumes as `provider_overrides[provider]`.
CONNECTION = {"api_key": "keyless-local", "base_url": "http://localhost:1234/v1"}


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingHttp:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json})
        return _FakeResponse({"content": "billing"})


class _FakeExternalTextClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.overrides: list[dict[str, Any] | None] = []

    async def generate_label_with_usage(
        self,
        prompt: str,
        system_prompt: str | None = None,
        *,
        tenant_id: str,
        provider: str,
        model: str,
        provider_override: dict[str, Any] | None = None,
    ) -> GeneratedLabel:
        self.calls.append({"tenant_id": tenant_id, "provider": provider, "model": model})
        self.overrides.append(provider_override)
        return GeneratedLabel(label="billing")


@pytest.fixture()
def route():
    app = FastAPI()
    app.include_router(rest_api_router_v1)
    fake = _FakeExternalTextClient()
    app.dependency_overrides[get_external_text_client] = lambda: fake
    return TestClient(app), fake


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "text": "I have a billing question",
        "instructions": ["billing", "appointments"],
        "tenant_id": "t1",
        "text_provider": "lm-studio",
        "text_model": "gemma-3-12b",
        "text_provider_overrides": CONNECTION,
    }
    body.update(overrides)
    return {k: v for k, v in body.items() if v is not None}


class TestClientNamesTheSelection:
    @pytest.mark.asyncio
    async def test_generate_body_carries_provider_and_model(self) -> None:
        http = _RecordingHttp()
        client = ExternalTextClient(
            settings=ExternalTextConfig(base_url="http://text.local"), http_client=http
        )

        await client.generate_label_with_usage(
            "Which topic?", tenant_id="t1", provider="lm-studio", model="gemma-3-12b"
        )

        body = http.calls[0]["json"]
        assert body["provider"] == "lm-studio"
        assert body["model"] == "gemma-3-12b"

    @pytest.mark.asyncio
    async def test_the_injected_connection_rides_as_provider_overrides(self) -> None:
        """`text` holds no endpoint or credential of its own: it reads ONLY
        `provider_overrides[provider]`. Without it every call is a 503
        PROVIDER_CREDENTIALS_MISSING (found by the TASK-1016 live proof)."""
        http = _RecordingHttp()
        client = ExternalTextClient(
            settings=ExternalTextConfig(base_url="http://text.local"), http_client=http
        )

        await client.generate_label_with_usage(
            "Which topic?",
            tenant_id="t1",
            provider="lm-studio",
            model="gemma-3-12b",
            provider_override=CONNECTION,
        )

        assert http.calls[0]["json"]["provider_overrides"] == {"lm-studio": CONNECTION}

    @pytest.mark.asyncio
    async def test_opts_out_of_the_medical_relevance_gate_only(self) -> None:
        """Owner decision (2026-09-29): open-taxonomy topic/intent labels are not clinical
        content (`billing`, `appointments`), so the input medical-relevance gate must not
        refuse them — `text` answered 422 CONTENT_BLOCKED_NOT_MEDICAL for a billing question.
        ONLY that gate: `enabled` stays unset, so platform screening (and the output gate)
        still run."""
        http = _RecordingHttp()
        client = ExternalTextClient(
            settings=ExternalTextConfig(base_url="http://text.local"), http_client=http
        )

        await client.generate_label_with_usage(
            "Which topic?", tenant_id="t1", provider="lm-studio", model="gemma-3-12b"
        )

        assert http.calls[0]["json"]["guardrail_policy"] == {"require_medical": False}

    @pytest.mark.asyncio
    async def test_posts_to_texts_versioned_generate_route(self) -> None:
        """`TEXT_URL` is the fleet-wide bare ORIGIN (guardrail and harness append `/api/v1/...`);
        text mounts `/generate` under `/api/v1`. The bare `/generate` path 404'd on every call
        (found by the TASK-1016 live proof)."""
        http = _RecordingHttp()
        client = ExternalTextClient(
            settings=ExternalTextConfig(base_url="http://localhost:8862"), http_client=http
        )

        await client.generate_label_with_usage(
            "Which topic?", tenant_id="t1", provider="lm-studio", model="gemma-3-12b"
        )

        assert http.calls[0]["url"] == "http://localhost:8862/api/v1/generate"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("provider", "model"), [("", "m"), ("p", ""), ("  ", "m")])
    async def test_blank_selection_raises_before_any_call(self, provider: str, model: str) -> None:
        http = _RecordingHttp()
        client = ExternalTextClient(
            settings=ExternalTextConfig(base_url="http://text.local"), http_client=http
        )

        with pytest.raises(ValueError, match="provider and model"):
            await client.generate_label_with_usage(
                "Which topic?", tenant_id="t1", provider=provider, model=model
            )
        assert http.calls == []


@pytest.mark.parametrize("path", ["/api/v1/classify/topic", "/api/v1/classify/intent"])
class TestRoutesForwardOrFailClosed:
    def test_injected_selection_is_forwarded(self, route, path: str) -> None:
        client, fake = route

        resp = client.post(path, json=_body())

        assert resp.status_code == 200
        assert fake.calls == [{"tenant_id": "t1", "provider": "lm-studio", "model": "gemma-3-12b"}]
        assert fake.overrides == [CONNECTION]

    @pytest.mark.parametrize(
        "missing",
        [
            {"text_provider": None},
            {"text_model": None},
            {"text_model": "  "},
            {"text_provider_overrides": None},
        ],
    )
    def test_missing_selection_fails_closed_503_without_calling_text(
        self, route, path: str, missing: dict[str, Any]
    ) -> None:
        client, fake = route

        resp = client.post(path, json=_body(**missing))

        assert resp.status_code == 503
        assert "model not selected" in resp.json()["detail"]
        assert fake.calls == []


class _StatusHttp:
    """Answers each POST with the next status in `statuses` (the last one repeats), as a REAL
    `httpx.Response`, so `raise_for_status()` raises the genuine `httpx.HTTPStatusError`."""

    def __init__(self, statuses: list[int], error_code: str | None = None) -> None:
        self.statuses = statuses
        self.error_code = error_code
        self.calls = 0

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        status = self.statuses[min(self.calls, len(self.statuses) - 1)]
        self.calls += 1
        payload: dict[str, Any] = (
            {"content": "billing"}
            if status < 400
            else {"detail": "refused", "error_code": self.error_code}
        )
        return httpx.Response(status, json=payload, request=httpx.Request("POST", url))


def _status_client(http: _StatusHttp) -> ExternalTextClient:
    return ExternalTextClient(
        settings=ExternalTextConfig(base_url="http://text.local", retry_backoff_ms=0),
        http_client=http,
    )


async def _label(client: ExternalTextClient) -> GeneratedLabel:
    return await client.generate_label_with_usage(
        "Which topic?", tenant_id="t1", provider="lm-studio", model="gemma"
    )


class TestNoRetryOnDeterministicRefusal:
    """A 4xx from `text` is a refusal of THIS request — the same request is refused again, so
    retrying only burns the budget and turns a named refusal into an opaque 503."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [400, 401, 404, 422])
    async def test_a_4xx_is_attempted_once_and_raised_as_a_rejection(self, status: int) -> None:
        http = _StatusHttp([status], error_code="CONTENT_BLOCKED_NOT_MEDICAL")

        with pytest.raises(ExternalTextRejectedError) as exc_info:
            await _label(_status_client(http))

        assert http.calls == 1
        assert exc_info.value.status_code == status
        assert exc_info.value.error_code == "CONTENT_BLOCKED_NOT_MEDICAL"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [408, 429])
    async def test_timeout_and_rate_limit_4xx_are_still_retried(self, status: int) -> None:
        http = _StatusHttp([status, 200])

        generated = await _label(_status_client(http))

        assert http.calls == 2
        assert generated.label == "billing"

    @pytest.mark.asyncio
    async def test_a_5xx_keeps_the_bounded_retry(self) -> None:
        http = _StatusHttp([503])

        with pytest.raises(ExternalTextUnavailableError):
            await _label(_status_client(http))

        assert http.calls == 3  # max_retries (2) + 1


class _RejectingClient:
    def __init__(self, status: int) -> None:
        self.status = status

    async def generate_label_with_usage(self, *args: Any, **kwargs: Any) -> GeneratedLabel:
        raise ExternalTextRejectedError(self.status, "CONTENT_BLOCKED_NOT_MEDICAL")


@pytest.mark.parametrize("path", ["/api/v1/classify/topic", "/api/v1/classify/intent"])
class TestRouteSurfacesTheRefusal:
    def _post(self, path: str, status: int):
        app = FastAPI()
        app.include_router(rest_api_router_v1)
        app.dependency_overrides[get_external_text_client] = lambda: _RejectingClient(status)
        return TestClient(app).post(path, json=_body())

    def test_a_content_refusal_is_422_naming_texts_code(self, path: str) -> None:
        resp = self._post(path, 422)

        assert resp.status_code == 422
        assert "CONTENT_BLOCKED_NOT_MEDICAL" in resp.json()["detail"]

    def test_any_other_4xx_is_an_integration_defect_502(self, path: str) -> None:
        resp = self._post(path, 400)

        assert resp.status_code == 502
