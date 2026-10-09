"""TASK-1055 wave 3 — the LM Studio provider asks the residency agent to ensure the
model is loaded before every request it sends to LM Studio.

Contract: ``wave3.lmStudioOnDemand.textCaller``. No real LM Studio, no real agent —
the ensure transport is an ``httpx.MockTransport`` and the SDK client is a stub.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import structlog

from text.core.exceptions import ProviderUnavailableError
from text.models.requests import GenerateRequest
from text.providers import lmstudio
from text.providers.lmstudio import LMStudioProvider
from text.tests.conftest import connected, stub_client

AGENT_URL = "http://agent.test:8869"


def _completion() -> MagicMock:
    usage = MagicMock(prompt_tokens=3, completion_tokens=4, total_tokens=7)
    choice = MagicMock()
    choice.message.content = "ok"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


class _Stream:
    def __init__(self) -> None:
        usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
        delta = MagicMock(content="hi", reasoning_content=None, reasoning=None)
        c1 = MagicMock(choices=[MagicMock(delta=delta, finish_reason="stop")], usage=None)
        c2 = MagicMock(choices=[], usage=usage)
        self._chunks = [c1, c2]

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        for c in self._chunks:
            yield c


def _wire(monkeypatch, handler, *, url: str | None = AGENT_URL, order: list[str] | None = None):
    """A provider whose ensure transport is ``handler`` and whose SDK client records order."""
    seen: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if order is not None:
            order.append("ensure")
        return handler(request)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        lmstudio,
        "_ensure_client",
        lambda timeout_s: real(transport=httpx.MockTransport(_handler), timeout=timeout_s),
    )
    provider = LMStudioProvider()
    if url is not None:
        provider.configure_residency_ensure(agent_url=url, service_token="tok")
    client = AsyncMock()

    async def _create(**kwargs):
        if order is not None:
            order.append("lmstudio")
        return _Stream() if kwargs.get("stream") else _completion()

    client.chat.completions.create = AsyncMock(side_effect=_create)
    stub_client(provider, client)
    return provider, client, seen


def _req(model: str = "granite-guardian-4.1-8b") -> GenerateRequest:
    return connected(GenerateRequest(prompt="hi", model=model, provider="lm-studio"))


_OK = httpx.Response(200, json={"outcome": "already_loaded"})


@pytest.mark.asyncio
async def test_ensure_precedes_the_chat_call_with_model_and_token(monkeypatch):
    order: list[str] = []
    provider, client, seen = _wire(monkeypatch, lambda r: _OK, order=order)

    await provider.generate(_req())

    assert order == ["ensure", "lmstudio"]
    assert str(seen[0].url) == f"{AGENT_URL}/internal/residency/ensure"
    assert seen[0].headers["x-service-token"] == "tok"
    assert json.loads(seen[0].content) == {"model_ref": "granite-guardian-4.1-8b"}


@pytest.mark.asyncio
async def test_ensure_precedes_every_streaming_call(monkeypatch):
    order: list[str] = []
    provider, _client, seen = _wire(monkeypatch, lambda r: _OK, order=order)

    chunks = [c async for c in provider.generate_stream(_req())]

    assert chunks
    assert order == ["ensure", "lmstudio"]
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_load_failed_503_fails_the_request_with_the_cause(monkeypatch):
    provider, client, _seen = _wire(
        monkeypatch,
        lambda r: httpx.Response(503, json={"code": "LOAD_FAILED", "message": "out of VRAM"}),
    )

    with pytest.raises(ProviderUnavailableError) as exc:
        await provider.generate(_req())

    assert "out of VRAM" in str(exc.value)
    client.chat.completions.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_load_failed_503_fails_a_stream_before_any_chunk(monkeypatch):
    provider, client, _seen = _wire(
        monkeypatch,
        lambda r: httpx.Response(503, json={"code": "LOAD_FAILED", "message": "boom"}),
    )

    with pytest.raises(ProviderUnavailableError):
        async for _ in provider.generate_stream(_req()):
            pass
    client.chat.completions.create.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(404, json={"code": "MODEL_UNKNOWN", "message": "x"}),
        httpx.Response(401, json={"message": "no"}),
        httpx.Response(503, json={"message": "agent not ready"}),  # 503 but not LOAD_FAILED
    ],
)
async def test_skip_outcomes_log_a_warning_and_proceed(monkeypatch, response):
    provider, client, _seen = _wire(monkeypatch, lambda r: response)

    with structlog.testing.capture_logs() as logs:
        await provider.generate(_req())

    client.chat.completions.create.assert_awaited_once()
    skipped = [e for e in logs if e["event"] == "text.lmstudio.ensure_skipped"]
    assert skipped and skipped[0]["log_level"] == "warning"


@pytest.mark.asyncio
async def test_unreachable_agent_logs_and_proceeds(monkeypatch):
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    provider, client, _seen = _wire(monkeypatch, boom)

    with structlog.testing.capture_logs() as logs:
        await provider.generate(_req())

    client.chat.completions.create.assert_awaited_once()
    assert any(e["event"] == "text.lmstudio.ensure_skipped" for e in logs)


@pytest.mark.asyncio
async def test_timeout_logs_and_proceeds(monkeypatch):
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    provider, client, _seen = _wire(monkeypatch, slow)

    await provider.generate(_req())

    client.chat.completions.create.assert_awaited_once()


@pytest.mark.asyncio
async def test_empty_url_is_feature_off_and_silent(monkeypatch):
    provider, client, seen = _wire(monkeypatch, lambda r: _OK, url="")

    with structlog.testing.capture_logs() as logs:
        await provider.generate(_req())

    assert seen == []
    assert not [e for e in logs if e["event"].startswith("text.lmstudio")]
    client.chat.completions.create.assert_awaited_once()


@pytest.mark.asyncio
async def test_unconfigured_provider_never_calls_the_agent(monkeypatch):
    provider, _client, seen = _wire(monkeypatch, lambda r: _OK, url=None)

    await provider.generate(_req())

    assert seen == []


def test_settings_expose_the_agent_url_with_the_contract_default():
    from text.core.config import Settings

    assert Settings.model_fields["lmstudio_agent_url"].default == "http://localhost:8869"
