"""Unit tests for apps/nlp's peer-service client to `text` (TASK-729).

httpx is fully mocked — this is apps/nlp's FIRST outbound call to a peer AI
service (every existing httpx call site targets the gateway; see §2.3 of the
ticket). Covers: the `/generate` request shape, service-token + tenant-header
propagation, label extraction from the response `content`, and the bounded
retry → raise (never a silently-guessed label) posture on a sustained outage —
mirroring `ExternalGuardrailClient`'s retry/backoff shape, but raising instead
of returning a fail-closed sentinel: there is no safe default *label* the way
there is a safe default *verdict* (`not allowed`).
"""

from __future__ import annotations

from typing import Any

import pytest

from nlp.core.config import ExternalTextConfig
from nlp.services.external_text_client import ExternalTextClient, ExternalTextUnavailableError


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
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
        raise RuntimeError("text service unreachable")


class _RaiseThenSucceedClient:
    def __init__(self, fail_times: int, payload: dict[str, Any]) -> None:
        self.fail_times = fail_times
        self.payload = payload
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("transient blip")
        return _FakeResponse(self.payload)


def _client(config: ExternalTextConfig, http_client: Any) -> ExternalTextClient:
    return ExternalTextClient(settings=config, http_client=http_client)


@pytest.mark.asyncio
async def test_posts_to_generate_with_prompt_and_returns_content() -> None:
    http = _RecordingClient({"content": "billing", "provider": "lm-studio", "model": "gemma"})
    client = _client(ExternalTextConfig(base_url="http://text.local"), http)

    label = await client.generate_label("Which topic does this note discuss?")

    assert label == "billing"
    assert http.calls[0]["url"] == "http://text.local/generate"
    assert http.calls[0]["json"]["prompt"] == "Which topic does this note discuss?"
    assert http.calls[0]["json"]["stream"] is False


@pytest.mark.asyncio
async def test_service_token_forwarded_as_header() -> None:
    http = _RecordingClient({"content": "billing"})
    client = _client(ExternalTextConfig(service_token="tok-123"), http)

    await client.generate_label("prompt")

    assert http.calls[0]["headers"]["X-Service-Token"] == "tok-123"


@pytest.mark.asyncio
async def test_no_service_token_header_when_unset() -> None:
    http = _RecordingClient({"content": "billing"})
    client = _client(ExternalTextConfig(service_token=""), http)

    await client.generate_label("prompt")

    assert "X-Service-Token" not in http.calls[0]["headers"]


@pytest.mark.asyncio
async def test_tenant_id_forwarded_as_header() -> None:
    http = _RecordingClient({"content": "billing"})
    client = _client(ExternalTextConfig(), http)

    await client.generate_label("prompt", tenant_id="tenant-abc")

    assert http.calls[0]["headers"]["X-Tenant-Id"] == "tenant-abc"


@pytest.mark.asyncio
async def test_tenant_header_absent_when_no_tenant() -> None:
    http = _RecordingClient({"content": "billing"})
    client = _client(ExternalTextConfig(), http)

    await client.generate_label("prompt")

    assert "X-Tenant-Id" not in http.calls[0]["headers"]


@pytest.mark.asyncio
async def test_transient_blip_absorbed_by_bounded_retry() -> None:
    http = _RaiseThenSucceedClient(fail_times=1, payload={"content": "billing"})
    client = _client(ExternalTextConfig(max_retries=2), http)

    label = await client.generate_label("prompt")

    assert label == "billing"
    assert http.calls == 2


@pytest.mark.asyncio
async def test_sustained_outage_raises_after_bounded_retries_never_guesses_a_label() -> None:
    http = _RaisingClient()
    client = _client(ExternalTextConfig(max_retries=1, retry_backoff_ms=0), http)

    with pytest.raises(ExternalTextUnavailableError):
        await client.generate_label("prompt")

    assert http.calls == 2  # max_retries=1 -> 2 total attempts


@pytest.mark.asyncio
async def test_empty_content_raises_rather_than_returning_blank_label() -> None:
    http = _RecordingClient({"content": ""})
    client = _client(ExternalTextConfig(max_retries=0), http)

    with pytest.raises(ExternalTextUnavailableError):
        await client.generate_label("prompt")
