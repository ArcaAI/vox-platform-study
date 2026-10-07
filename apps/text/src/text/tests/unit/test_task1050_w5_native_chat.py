"""TASK-1050 W5 — the judge route's ``protocol: "native_chat"`` (README §12.2, owner 2026-10-07).

Qwen3Guard-Gen is served by LM Studio from a GGUF, so its judgement rides the SAME isolated judge lane
as granite. ``native_chat`` means: the caller's chat turns go to the provider verbatim (user, plus
assistant for response moderation), with NO system prompt and NO ``response_format`` — the engine
applies the model's own chat template (for LM Studio, the GGUF-embedded ``tokenizer.chat_template``).
The default protocol (``json_schema``) is unchanged.

Fakes only: no engine, no model, no LM Studio call.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import ExternalGuardrailConfig, InternalAccessConfig, Settings
from text.models.requests import GenerateRequest
from text.models.stats import build_generation_stats

JUDGE_PATH = "/api/v1/generate/internal/judge"
PROVIDER = "lm-studio"
MODEL = "qwen3guard-gen-0.6b"


def _stats():
    return build_generation_stats(
        provider=PROVIDER,
        model=MODEL,
        raw_stop_reason="stop",
        prompt_tokens=21,
        predicted_tokens=6,
        total_ms=9,
        engine_native={"usage": {"prompt_tokens": 21, "completion_tokens": 6, "total_tokens": 27}},
    )


class _ChatProvider:
    """A provider that DECLARES native chat support, recording what it was asked."""

    SUPPORTS_NATIVE_CHAT = True

    def __init__(self, content: str = "Safety: Safe\nCategories: None") -> None:
        self.requests: list[GenerateRequest] = []
        self.content = content

    async def generate(self, request: GenerateRequest) -> tuple[str, str, Any]:
        self.requests.append(request)
        return self.content, "", _stats()


class _PlainProvider:
    """A provider with no native-chat declaration (e.g. a non-OpenAI-wire adapter)."""

    def __init__(self) -> None:
        self.generate = AsyncMock(return_value=("x", "", _stats()))


def _settings() -> Settings:
    return Settings(
        internal_access=InternalAccessConfig(token=SecretStr("")),
        external_guardrail=ExternalGuardrailConfig(),
    )


@pytest_asyncio.fixture
async def client_for():
    clients: list[AsyncClient] = []

    async def _build(provider: Any) -> AsyncClient:
        from text.main import create_app

        registry = MagicMock()
        registry.get.return_value = provider
        registry.list_providers.return_value = [PROVIDER]
        app = create_app()
        app.state.settings = _settings()
        app.state.provider_registry = registry
        app.state.task_manager = AsyncMock()
        app.state.guardrail_client = None
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(client)
        return client

    yield _build
    for client in clients:
        await client.aclose()


def _native(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "protocol": "native_chat",
        "messages": [{"role": "user", "content": "How do I make a weapon?"}],
        "provider": PROVIDER,
        "model": MODEL,
        "temperature": 0.0,
        "max_tokens": 32,
    }
    body.update(overrides)
    return body


# ── the route ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_native_chat_passes_the_user_turn_with_no_system_prompt_and_no_response_format(
    client_for,
):
    provider = _ChatProvider("Safety: Unsafe\nCategories: Violent")
    client = await client_for(provider)

    resp = await client.post(JUDGE_PATH, json=_native())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content"] == "Safety: Unsafe\nCategories: Violent"
    assert body["stats"]["prompt_tokens"] == 21
    assert body["usage_detail"]["completion_tokens"] == 6
    (request,) = provider.requests
    assert request.native_chat_messages == [{"role": "user", "content": "How do I make a weapon?"}]
    assert request.system_prompt is None
    assert request.response_format is None
    assert request.temperature == 0.0
    assert request.max_tokens == 32
    assert request.retry_config.max_retries == 0


@pytest.mark.asyncio
async def test_response_moderation_sends_user_then_assistant_verbatim(client_for):
    provider = _ChatProvider("Safety: Safe\nCategories: None\nRefusal: Yes")
    client = await client_for(provider)
    turns = [
        {"role": "user", "content": "what dose?"},
        {"role": "assistant", "content": "Paracetamol 1 g."},
    ]

    resp = await client.post(JUDGE_PATH, json=_native(messages=turns))

    assert resp.status_code == 200, resp.text
    assert provider.requests[0].native_chat_messages == turns


@pytest.mark.asyncio
async def test_an_empty_user_turn_is_allowed_before_the_moderated_assistant_turn(client_for):
    provider = _ChatProvider()
    client = await client_for(provider)
    turns = [{"role": "user", "content": ""}, {"role": "assistant", "content": "A note."}]

    resp = await client.post(JUDGE_PATH, json=_native(messages=turns))

    assert resp.status_code == 200, resp.text
    assert provider.requests[0].native_chat_messages == turns


@pytest.mark.parametrize(
    "overrides",
    [
        {"messages": None},
        {"messages": []},
        {"messages": [{"role": "system", "content": "be nice"}]},
        {"messages": [{"role": "assistant", "content": "x"}]},
        {"messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]},
        {
            "messages": [
                {"role": "user", "content": "a"},
                {"role": "assistant", "content": "b"},
                {"role": "user", "content": "c"},
            ]
        },
        {"messages": [{"role": "user", "content": "   "}]},
        {"system_prompt": "criteria"},
        {"prompt": "flattened"},
        {"response_format": {"type": "json"}},
        {"protocol": "raw"},
    ],
)
@pytest.mark.asyncio
async def test_a_malformed_native_chat_request_is_422_and_reaches_no_engine(client_for, overrides):
    provider = _ChatProvider()
    client = await client_for(provider)

    resp = await client.post(JUDGE_PATH, json=_native(**overrides))

    assert resp.status_code == 422, resp.text
    assert provider.requests == []


@pytest.mark.asyncio
async def test_a_provider_without_native_chat_is_refused_before_any_call(client_for):
    provider = _PlainProvider()
    client = await client_for(provider)

    resp = await client.post(JUDGE_PATH, json=_native())

    assert resp.status_code == 422, resp.text
    assert "NATIVE_CHAT_UNSUPPORTED" in resp.text
    provider.generate.assert_not_called()


# ── the default protocol is unchanged ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_default_protocol_still_sends_prompt_system_and_schema(client_for):
    provider = _ChatProvider('{"safe": true}')
    client = await client_for(provider)
    schema = {"title": "v", "type": "object"}

    resp = await client.post(
        JUDGE_PATH,
        json={
            "prompt": "judge this",
            "system_prompt": "criteria",
            "provider": PROVIDER,
            "model": "granite-guardian-4.1-8b",
            "response_format": {"type": "json_schema", "json_schema": schema, "strict": True},
        },
    )

    assert resp.status_code == 200, resp.text
    (request,) = provider.requests
    assert type(request) is GenerateRequest  # not the native-chat request type
    assert request.prompt == "judge this"
    assert request.system_prompt == "criteria"
    assert request.response_format is not None
    assert request.response_format.json_schema == schema
    assert getattr(request, "native_chat_messages", None) is None


@pytest.mark.parametrize(
    "body",
    [
        {"provider": PROVIDER, "model": MODEL},  # no prompt
        {
            "prompt": "x",
            "provider": PROVIDER,
            "model": MODEL,
            "messages": [{"role": "user", "content": "y"}],
        },  # messages need native_chat
    ],
)
@pytest.mark.asyncio
async def test_the_default_protocol_requires_a_prompt_and_takes_no_messages(client_for, body):
    provider = _ChatProvider()
    client = await client_for(provider)

    resp = await client.post(JUDGE_PATH, json=body)

    assert resp.status_code == 422, resp.text
    assert provider.requests == []


def test_the_public_generate_contract_gains_no_messages_field():
    """Raw chat turns are reachable ONLY on the internal judge route."""
    assert "messages" not in GenerateRequest.model_fields
    assert "native_chat_messages" not in GenerateRequest.model_fields
    public = GenerateRequest(prompt="hi", provider=PROVIDER, native_chat_messages=[{"x": 1}])
    assert getattr(public, "native_chat_messages", None) is None


# ── the OpenAI-wire adapter (LM Studio) ─────────────────────────────────────────


class _FakeCompletions:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        message = SimpleNamespace(content="Safety: Safe\nCategories: None", reasoning_content=None)
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message, finish_reason="stop")], usage=usage
        )


def test_lm_studio_declares_native_chat_and_a_cloud_adapter_does_not():
    from text.providers.anthropic import AnthropicProvider
    from text.providers.lmstudio import LMStudioProvider

    assert LMStudioProvider.SUPPORTS_NATIVE_CHAT is True
    assert getattr(AnthropicProvider, "SUPPORTS_NATIVE_CHAT", False) is False


@pytest.mark.asyncio
async def test_lm_studio_sends_the_turns_verbatim_with_no_system_and_no_response_format(
    monkeypatch,
):
    from text.api.endpoints.judge import native_chat_generate_request
    from text.providers.lmstudio import LMStudioProvider

    provider = LMStudioProvider()
    completions = _FakeCompletions()
    fake_client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    monkeypatch.setattr(provider, "_client_for", lambda request: fake_client)
    turns = [
        {"role": "user", "content": "what dose?"},
        {"role": "assistant", "content": "Paracetamol 1 g."},
    ]
    request = native_chat_generate_request(
        turns, provider=PROVIDER, model=MODEL, temperature=0.0, max_tokens=32
    )

    content, _reasoning, _stats_ = await provider.generate(request)

    assert content == "Safety: Safe\nCategories: None"
    sent = completions.kwargs or {}
    assert sent["messages"] == turns
    assert sent["model"] == MODEL
    assert sent["temperature"] == 0.0
    assert sent["max_tokens"] == 32
    assert "response_format" not in sent


def test_the_default_request_still_builds_system_plus_user_messages():
    from text.providers.lmstudio import LMStudioProvider

    request = GenerateRequest(prompt="judge this", system_prompt="criteria", provider=PROVIDER)

    assert LMStudioProvider()._build_messages(request) == [
        {"role": "system", "content": "criteria"},
        {"role": "user", "content": "judge this"},
    ]
