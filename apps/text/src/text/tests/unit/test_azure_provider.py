"""TDD tests for AzureOpenAIProvider.

Tests mock the openai.AsyncAzureOpenAI client.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from text.models.requests import GenerateRequest, ResponseFormat
from text.tests.conftest import stub_client


class TestAzureProviderInit:
    def test_creates_with_config(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        assert provider is not None

    def test_the_adapter_carries_no_model_of_its_own(self):
        """`TEXT_AZURE_DEFAULT_MODEL` is gone, and nothing replaced it in-process.

        Its only reader was `get_info()`; the model catalogue is authoritative on
        the gateway (`AiModel` / `AiTaskDefault`), and a generation resolves its
        model from the request. An adapter-held default would be a hardcoded
        SELECTION, which is `failMode: closed`."""
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        assert not hasattr(provider, "_default_model")


class TestAzureGenerate:
    @pytest.mark.asyncio
    async def test_generate_returns_text(self):
        from text.models.stats import GenerationStats
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "Azure response!"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        content, _reasoning, stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="azure_openai", model="test-model")
        )
        assert content == "Azure response!"
        assert isinstance(stats, GenerationStats)

    @pytest.mark.asyncio
    async def test_generate_sends_messages(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        await provider.generate(
            GenerateRequest(
                prompt="explain AI",
                system_prompt="You are helpful",
                provider="azure_openai",
                model="test-model",
            )
        )

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        messages = call_kwargs["messages"]
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        assert messages[1]["content"] == "explain AI"

    @pytest.mark.asyncio
    async def test_generate_raises_on_api_error(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(side_effect=Exception("API Error"))

        with pytest.raises(Exception, match="API Error"):
            await provider.generate(
                GenerateRequest(prompt="hi", provider="azure_openai", model="test-model")
            )


class TestAzureGenerateStream:
    @pytest.mark.asyncio
    async def test_stream_yields_reasoning_then_content(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        async def _mock_stream():
            reasoning_chunk = MagicMock()
            reasoning_chunk.choices = [MagicMock()]
            reasoning_chunk.choices[0].delta.content = None
            reasoning_chunk.choices[0].delta.reasoning_content = "Thinking..."
            reasoning_chunk.choices[0].finish_reason = None
            yield reasoning_chunk

            content_chunk = MagicMock()
            content_chunk.choices = [MagicMock()]
            content_chunk.choices[0].delta.content = "Answer"
            content_chunk.choices[0].delta.reasoning_content = None
            content_chunk.choices[0].finish_reason = "stop"
            yield content_chunk

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        chunks = []
        async for chunk in provider.generate_stream(
            GenerateRequest(prompt="hi", stream=True, provider="azure_openai", model="test-model")
        ):
            chunks.append(chunk)

        reasoning_chunks = [c for c in chunks if c.type == "reasoning"]
        assert len(reasoning_chunks) == 1
        assert reasoning_chunks[0].content == "Thinking..."

    @pytest.mark.asyncio
    async def test_stream_yields_chunks(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        async def _mock_stream():
            for text in ["Hello", " from", " Azure"]:
                chunk = MagicMock()
                chunk.choices = [MagicMock()]
                chunk.choices[0].delta.content = text
                chunk.choices[0].finish_reason = None
                yield chunk
            final = MagicMock()
            final.choices = [MagicMock()]
            final.choices[0].delta.content = None
            final.choices[0].finish_reason = "stop"
            yield final

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        chunks = []
        async for chunk in provider.generate_stream(
            GenerateRequest(prompt="hi", stream=True, provider="azure_openai", model="test-model")
        ):
            chunks.append(chunk)

        text_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(text_chunks) == 3
        assert text_chunks[0].content == "Hello"

        done_chunks = [c for c in chunks if c.type == "done"]
        assert len(done_chunks) == 1


class TestAzureStructuredOutput:
    @pytest.mark.asyncio
    async def test_generate_with_json_format(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = '{"key": "value"}'
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            response_format=ResponseFormat(type="json"),
            model="test-model",
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["response_format"] == {"type": "json_object"}

    @pytest.mark.asyncio
    async def test_generate_with_json_schema_format(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = '{"name": "test"}'
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        schema = {"title": "MySchema", "type": "object", "properties": {"name": {"type": "string"}}}
        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
            model="test-model",
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["name"] == "MySchema"
        assert rf["json_schema"]["strict"] is True

    @pytest.mark.asyncio
    async def test_stream_with_json_format(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        async def _mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = '{"key": "value"}'
            chunk.choices[0].finish_reason = "stop"
            yield chunk

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            stream=True,
            response_format=ResponseFormat(type="json"),
            model="test-model",
        )
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["response_format"] == {"type": "json_object"}
        assert call_kwargs["stream"] is True

    @pytest.mark.asyncio
    async def test_stream_with_json_schema_format(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        async def _mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = '{"name": "test"}'
            chunk.choices[0].finish_reason = "stop"
            yield chunk

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        schema = {"title": "MySchema", "type": "object", "properties": {"name": {"type": "string"}}}
        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            stream=True,
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
            model="test-model",
        )
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["name"] == "MySchema"
        assert call_kwargs["stream"] is True

    @pytest.mark.asyncio
    async def test_stream_without_response_format_omits_it(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        async def _mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = "Hello"
            chunk.choices[0].finish_reason = "stop"
            yield chunk

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        req = GenerateRequest(prompt="hi", provider="azure_openai", stream=True, model="test-model")
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert "response_format" not in call_kwargs


class TestAzureDeploymentName:
    """Azure routes by DEPLOYMENT name, not model name.

    A deployment belongs to the Azure resource the request authenticates against,
    so it travels with that resource's credential on the connection row — not as
    a process-wide `TEXT_AZURE_DEPLOYMENT_NAME` that would pin every tenant to one
    tenant's deployment. Absent one, the caller-supplied `request.model` is
    forwarded unchanged.
    """

    @pytest.mark.asyncio
    async def test_the_connections_deployment_wins_over_the_caller_model(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        req = GenerateRequest(
            prompt="hi",
            provider="azure_openai",
            model="some-other-caller-model",
            provider_overrides={
                "azure_openai": {
                    "api_key": "k",
                    "base_url": "https://tenant.openai.azure.com",
                    "deployment_name": "tenant-deployment",
                }
            },
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "tenant-deployment"

    @pytest.mark.asyncio
    async def test_falls_back_to_the_request_model_when_no_deployment_is_pinned(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        req = GenerateRequest(
            prompt="hi",
            provider="azure_openai",
            model="caller-model",
            provider_overrides={
                "azure_openai": {"api_key": "k", "base_url": "https://tenant.openai.azure.com"}
            },
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "caller-model"


class TestAzureHealthCheck:
    """A BYOK adapter has no process-level connection, so there is nothing to probe.

    `health_check` returns True — "no negative evidence" — because
    `PoolHealthTracker` acts only on a POSITIVELY known-unhealthy result
    (`services/pool_health.py`). Reporting False would take a perfectly usable
    provider out of degrade routing for every tenant carrying a working key.
    """

    @pytest.mark.asyncio
    async def test_health_check_is_not_a_negative_signal(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        assert await AzureOpenAIProvider().health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_opens_no_connection(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        client = stub_client(provider, AsyncMock())
        await provider.health_check()
        client.models.list.assert_not_called()


class TestAzureGetInfo:
    @pytest.mark.asyncio
    async def test_get_info_reports_adapter_capabilities(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        info = await AzureOpenAIProvider().get_info()
        assert info.name == "azure_openai"
        assert info.supports_streaming is True
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_get_info_advertises_no_model_of_its_own(self):
        """The catalogue comes from `AiModel` on the gateway."""
        from text.providers.azure_openai import AzureOpenAIProvider

        info = await AzureOpenAIProvider().get_info()
        assert info.default_model == ""
        assert info.models == []
