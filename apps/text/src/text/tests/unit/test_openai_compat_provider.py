"""Tests for the generic OpenAI-compatible provider (TDD — written before implementation)."""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.core.config import Settings
from text.models.requests import GenerateRequest, ResponseFormat
from text.models.stream import StreamChunk
from text.tests.conftest import stub_client

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_request(**overrides) -> GenerateRequest:
    defaults = {"prompt": "Hello", "provider": "openai_compat", "model": "test-model"}
    defaults.update(overrides)
    return GenerateRequest(**defaults)


def _mock_completion_response(
    content: str = "Hello world",
    finish_reason: str = "stop",
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    total_tokens: int = 15,
) -> MagicMock:
    usage = MagicMock(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )
    choice = MagicMock()
    choice.message.content = content
    choice.finish_reason = finish_reason
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


async def _async_stream_chunks(chunks):
    """Turn a list of MagicMock chunks into an async iterator."""
    for c in chunks:
        yield c


def _clear_text_env(monkeypatch):
    for key in list(os.environ):
        if key.startswith("TEXT_"):
            monkeypatch.delenv(key, raising=False)


# ---------------------------------------------------------------------------
# 1. Config tests
# ---------------------------------------------------------------------------


def _clear_text_env(monkeypatch):
    """Remove all TEXT_* env vars so pydantic-settings reads only code defaults."""
    import os

    for key in list(os.environ):
        if key.startswith("TEXT_"):
            monkeypatch.delenv(key, raising=False)


class TestOpenAICompatHasNoConfigOfItsOwn:
    """`OpenAICompatConfig` is gone — endpoint, key, model and capacity all
    arrive with the request.

    Its `default_model` is the clearest illustration of why. It had to be an id
    LM Studio actually SERVED, because it was sent verbatim as the wire `model`
    — and when it drifted (`google/gemma-4-e4b` vs the installed `-qat` build)
    every request that reached the default got a 400 "Failed to load model", and
    the same stale id had already propagated into the AiModel catalogue. An
    engine-specific string in a config file is a model SELECTION, and selection
    belongs to `AiTaskDefault`, fail-closed.
    """

    def test_the_config_class_is_gone(self):
        import text.core.config as config_module

        assert not hasattr(config_module, "OpenAICompatConfig")

    def test_no_env_var_can_configure_this_adapter(self, monkeypatch):
        """Every retired name, set at once, must leave the adapter unchanged."""
        from text.providers.openai_compat import OpenAICompatProvider

        for stale in (
            "TEXT_OPENAI_COMPAT_BASE_URL",
            "TEXT_OPENAI_COMPAT_API_KEY",
            "TEXT_OPENAI_COMPAT_DEFAULT_MODEL",
            "TEXT_OPENAI_COMPAT_TIMEOUT_S",
            "TEXT_OPENAI_COMPAT_MAX_CONCURRENT",
            "TEXT_OPENAI_COMPAT_ORGANIZATION",
        ):
            monkeypatch.setenv(stale, "definitely-set")

        assert "openai_compat" not in Settings.model_fields
        provider = OpenAICompatProvider()
        assert provider._probe_url() is None
        assert not hasattr(provider, "_default_model")


# ---------------------------------------------------------------------------
# 2. Provider tests (mock the openai client)
# ---------------------------------------------------------------------------


class TestOpenAICompatProvider:
    @pytest.fixture()
    def mock_client(self):
        client = AsyncMock()
        client.chat.completions.create = AsyncMock()
        client.models.list = AsyncMock()
        return client

    @pytest.fixture()
    def provider(self, mock_client):
        from text.providers.openai_compat import OpenAICompatProvider

        p = OpenAICompatProvider()
        p._client = stub_client(p, mock_client)
        return p

    # -- 3. generate returns content and AD-1 stats --
    @pytest.mark.asyncio
    async def test_generate_returns_content_and_usage(self, provider, mock_client):
        from text.models.stats import GenerationStats

        mock_client.chat.completions.create.return_value = _mock_completion_response()

        content, _reasoning, stats = await provider.generate(_make_request())

        assert content == "Hello world"
        assert isinstance(stats, GenerationStats)
        assert stats.prompt_tokens == 10
        assert stats.predicted_tokens == 5
        assert stats.total_tokens == 15
        assert stats.stop_reason == "stop"
        mock_client.chat.completions.create.assert_awaited_once()

    # -- 4. generate with system prompt --
    @pytest.mark.asyncio
    async def test_generate_with_system_prompt(self, provider, mock_client):
        mock_client.chat.completions.create.return_value = _mock_completion_response()

        await provider.generate(_make_request(system_prompt="You are helpful"))

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        messages = call_kwargs["messages"]
        assert messages[0] == {"role": "system", "content": "You are helpful"}
        assert messages[1] == {"role": "user", "content": "Hello"}

    # -- 5. generate with custom model --
    @pytest.mark.asyncio
    async def test_generate_with_custom_model(self, provider, mock_client):
        mock_client.chat.completions.create.return_value = _mock_completion_response()

        await provider.generate(_make_request(model="custom-llm"))

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        assert call_kwargs["model"] == "custom-llm"

    # -- 6. generate_stream yields chunks --
    @pytest.mark.asyncio
    async def test_generate_stream_yields_reasoning_then_content(self, provider, mock_client):
        chunk1 = MagicMock()
        chunk1.choices = [MagicMock()]
        chunk1.choices[0].delta.content = None
        chunk1.choices[0].delta.reasoning_content = "Let me think"
        chunk1.choices[0].finish_reason = None

        chunk2 = MagicMock()
        chunk2.choices = [MagicMock()]
        chunk2.choices[0].delta.content = "Answer"
        chunk2.choices[0].delta.reasoning_content = None
        chunk2.choices[0].finish_reason = "stop"

        mock_client.chat.completions.create.return_value = _async_stream_chunks([chunk1, chunk2])

        results: list[StreamChunk] = []
        async for sc in provider.generate_stream(_make_request(stream=True)):
            results.append(sc)

        assert results[0].type == "reasoning"
        assert results[0].content == "Let me think"
        assert results[1].type == "chunk"
        assert results[1].content == "Answer"

    @pytest.mark.asyncio
    async def test_generate_stream_yields_chunks(self, provider, mock_client):
        chunk1 = MagicMock()
        chunk1.choices = [MagicMock()]
        chunk1.choices[0].delta.content = "Hello"
        chunk1.choices[0].finish_reason = None

        chunk2 = MagicMock()
        chunk2.choices = [MagicMock()]
        chunk2.choices[0].delta.content = " world"
        chunk2.choices[0].finish_reason = "stop"

        mock_client.chat.completions.create.return_value = _async_stream_chunks([chunk1, chunk2])

        results: list[StreamChunk] = []
        async for sc in provider.generate_stream(_make_request(stream=True)):
            results.append(sc)

        assert results[0].type == "chunk"
        assert results[0].content == "Hello"
        assert results[1].type == "chunk"
        assert results[1].content == " world"
        # drain contract: a usage chunk (full AD-1 stats) then done, done last.
        assert results[-1].type == "done"
        assert results[-1].data == {"finish_reason": "stop"}
        assert [r.type for r in results].count("usage") == 1
        assert [r.type for r in results].index("usage") < len(results) - 1

    # -- 7. generate_stream drains the trailing usage-only chunk --
    @pytest.mark.asyncio
    async def test_generate_stream_handles_empty_choices(self, provider, mock_client):
        # REAL OpenAI-wire ordering: the finish chunk arrives BEFORE the
        # ``stream_options`` usage-only chunk (choices == []). The provider must
        # drain to completion and still surface that trailing usage.
        content_chunk = MagicMock()
        content_chunk.choices = [MagicMock()]
        content_chunk.choices[0].delta.content = "Hi"
        content_chunk.choices[0].delta.reasoning_content = None
        content_chunk.choices[0].delta.reasoning = None
        content_chunk.choices[0].finish_reason = "stop"

        usage_chunk = MagicMock()
        usage_chunk.choices = []
        usage_chunk.usage = MagicMock(prompt_tokens=10, completion_tokens=5, total_tokens=15)

        mock_client.chat.completions.create.return_value = _async_stream_chunks(
            [content_chunk, usage_chunk]
        )

        results: list[StreamChunk] = []
        async for sc in provider.generate_stream(_make_request(stream=True)):
            results.append(sc)

        usage_chunks = [r for r in results if r.type == "usage"]
        assert len(usage_chunks) == 1
        assert usage_chunks[0].data["total_tokens"] == 15
        assert usage_chunks[0].data["predicted_tokens"] == 5
        # usage precedes done, done is last (drained past finish)
        types = [r.type for r in results]
        assert types.index("usage") < types.index("done")
        assert types[-1] == "done"

    # -- 8. health_check returns True when healthy --
    @pytest.mark.asyncio
    async def test_health_check_returns_true_when_healthy(self, provider, mock_client):
        mock_client.models.list.return_value = MagicMock(data=[])

        result = await provider.health_check()

        assert result is True
        mock_client.models.list.assert_awaited_once()

    # -- 9. health_check returns False on connection error --
    @pytest.mark.asyncio
    async def test_health_check_returns_false_on_connection_error(self, provider, mock_client):
        from openai import APIConnectionError

        mock_client.models.list.side_effect = APIConnectionError(request=MagicMock())

        result = await provider.health_check()

        assert result is False

    # -- 10. get_info returns ProviderInfo --
    @pytest.mark.asyncio
    async def test_get_info_returns_provider_info(self, provider, mock_client):
        model_obj = MagicMock()
        model_obj.id = "my-model"
        mock_client.models.list.return_value = MagicMock(data=[model_obj])

        info = await provider.get_info()

        assert info.name == "openai_compat"
        assert info.display_name == "OpenAI Compatible"
        assert info.status == "available"
        # The catalogue is `AiModel` on the gateway; the adapter advertises none.
        assert info.default_model == ""
        assert len(info.models) == 1
        assert info.models[0].name == "my-model"
        assert info.supports_streaming is True

    # -- 11. get_info returns unavailable on error --
    @pytest.mark.asyncio
    async def test_get_info_returns_unavailable_on_error(self, provider, mock_client):
        mock_client.models.list.side_effect = Exception("connection refused")

        info = await provider.get_info()

        assert info.status == "unavailable"
        assert info.models == []

    # -- 12. generate with json response format --
    @pytest.mark.asyncio
    async def test_generate_with_json_response_format(self, provider, mock_client):
        mock_client.chat.completions.create.return_value = _mock_completion_response(
            content='{"key": "value"}'
        )

        req = _make_request(response_format=ResponseFormat(type="json"))
        await provider.generate(req)

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        assert call_kwargs["response_format"] == {"type": "json_object"}

    # -- 13. generate with json_schema format --
    @pytest.mark.asyncio
    async def test_generate_with_json_schema_format(self, provider, mock_client):
        mock_client.chat.completions.create.return_value = _mock_completion_response(
            content='{"name": "test"}'
        )

        schema = {"title": "MySchema", "type": "object", "properties": {"name": {"type": "string"}}}
        req = _make_request(
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True)
        )
        await provider.generate(req)

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["name"] == "MySchema"
        assert rf["json_schema"]["strict"] is True

    # -- 14. generate_stream with json response format --
    @pytest.mark.asyncio
    async def test_generate_stream_with_json_response_format(self, provider, mock_client):
        chunk1 = MagicMock()
        chunk1.choices = [MagicMock()]
        chunk1.choices[0].delta.content = '{"key":'
        chunk1.choices[0].finish_reason = None

        chunk2 = MagicMock()
        chunk2.choices = [MagicMock()]
        chunk2.choices[0].delta.content = '"value"}'
        chunk2.choices[0].finish_reason = "stop"

        mock_client.chat.completions.create.return_value = _async_stream_chunks([chunk1, chunk2])

        req = _make_request(stream=True, response_format=ResponseFormat(type="json"))
        results: list[StreamChunk] = []
        async for sc in provider.generate_stream(req):
            results.append(sc)

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        assert call_kwargs["response_format"] == {"type": "json_object"}
        assert call_kwargs["stream"] is True

    # -- 15. generate_stream with json_schema format --
    @pytest.mark.asyncio
    async def test_generate_stream_with_json_schema_format(self, provider, mock_client):
        chunk1 = MagicMock()
        chunk1.choices = [MagicMock()]
        chunk1.choices[0].delta.content = '{"name":'
        chunk1.choices[0].finish_reason = None

        chunk2 = MagicMock()
        chunk2.choices = [MagicMock()]
        chunk2.choices[0].delta.content = '"test"}'
        chunk2.choices[0].finish_reason = "stop"

        mock_client.chat.completions.create.return_value = _async_stream_chunks([chunk1, chunk2])

        schema = {"title": "MySchema", "type": "object", "properties": {"name": {"type": "string"}}}
        req = _make_request(
            stream=True,
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
        )
        results: list[StreamChunk] = []
        async for sc in provider.generate_stream(req):
            results.append(sc)

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["name"] == "MySchema"
        assert rf["json_schema"]["strict"] is True
        assert call_kwargs["stream"] is True

    # -- 16. generate_stream without response_format omits it --
    @pytest.mark.asyncio
    async def test_generate_stream_without_response_format(self, provider, mock_client):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Hello"
        chunk.choices[0].finish_reason = "stop"

        mock_client.chat.completions.create.return_value = _async_stream_chunks([chunk])

        req = _make_request(stream=True)
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        assert "response_format" not in call_kwargs

    # -- 17. generate sets OTEL span attributes --
    @pytest.mark.asyncio
    async def test_generate_sets_otel_span_attributes(self, provider, mock_client):
        mock_client.chat.completions.create.return_value = _mock_completion_response()

        mock_span = MagicMock()
        mock_tracer = MagicMock()
        mock_tracer.start_as_current_span.return_value.__enter__ = MagicMock(return_value=mock_span)
        mock_tracer.start_as_current_span.return_value.__exit__ = MagicMock(return_value=False)

        with patch("text.providers.openai_compat._get_tracer", return_value=mock_tracer):
            await provider.generate(_make_request())

        mock_tracer.start_as_current_span.assert_called_once()
        call_kwargs = mock_tracer.start_as_current_span.call_args
        attrs = call_kwargs[1]["attributes"]
        assert attrs["gen_ai.system"] == "openai_compat"
        assert attrs["gen_ai.operation.name"] == "generate"
        assert "gen_ai.request.model" in attrs

        mock_span.set_attribute.assert_any_call("gen_ai.usage.input_tokens", 10)
        mock_span.set_attribute.assert_any_call("gen_ai.usage.output_tokens", 5)
        mock_span.set_attribute.assert_any_call("gen_ai.response.finish_reason", "stop")


# ---------------------------------------------------------------------------
# 3. Registration & timeout tests
# ---------------------------------------------------------------------------


class TestOpenAICompatRegistration:
    # -- 18. provider available via lazy factory --
    @pytest.mark.asyncio
    async def test_provider_available_via_lazy_factory(self):
        # availability comes from a registered CONNECTION-gated factory
        # (no ENABLE flag); the instance is built only on the first ``get``.
        from text.providers.base import ProviderRegistry
        from text.providers.openai_compat import OpenAICompatProvider

        registry = ProviderRegistry()
        registry.register_factory("openai_compat", OpenAICompatProvider)

        assert "openai_compat" in registry.list_providers()
        assert registry.is_instantiated("openai_compat") is False  # not built yet
        provider = registry.get("openai_compat")
        assert provider is not None
        assert registry.is_instantiated("openai_compat") is True  # built on demand

    # -- 19. the control plane can set this provider's timeout --
    def test_timeout_comes_from_the_control_plane(self):
        """No alias map to forget an entry in: the served key IS the provider name."""
        from text.api.endpoints.generate import _get_provider_timeout
        from text.core.runtime_defaults import PROVIDER_TIMEOUT_FLOOR_S

        assert _get_provider_timeout({"openai_compat": 42}, "openai_compat") == 42.0
        assert _get_provider_timeout({}, "openai_compat") == float(PROVIDER_TIMEOUT_FLOOR_S)
