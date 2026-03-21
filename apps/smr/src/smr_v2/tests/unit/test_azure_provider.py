"""TDD tests for AzureOpenAIProvider.

Tests mock the openai.AsyncAzureOpenAI client.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from smr_v2.core.config import AzureOpenAIConfig
from smr_v2.models.requests import GenerateRequest, ResponseFormat


@pytest.fixture
def azure_config():
    return AzureOpenAIConfig(
        api_key="test-key",
        endpoint="https://test.openai.azure.com",
        api_version="2024-06-01",
        deployment_name="gpt-4",
        default_model="gpt-4",
    )


class TestAzureProviderInit:
    def test_creates_with_config(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider = AzureOpenAIProvider(config=azure_config)
        assert provider is not None

    def test_default_model_from_config(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider = AzureOpenAIProvider(config=azure_config)
        assert provider._default_model == "gpt-4"


class TestAzureGenerate:
    @pytest.mark.asyncio
    async def test_generate_returns_text(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "Azure response!"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        content, usage = await provider.generate(GenerateRequest(prompt="hi", provider="azure_openai"))
        assert content == "Azure response!"
        assert isinstance(usage, dict)

    @pytest.mark.asyncio
    async def test_generate_sends_messages(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        await provider.generate(GenerateRequest(prompt="explain AI", system_prompt="You are helpful", provider="azure_openai"))

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        messages = call_kwargs["messages"]
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        assert messages[1]["content"] == "explain AI"

    @pytest.mark.asyncio
    async def test_generate_raises_on_api_error(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(side_effect=Exception("API Error"))

        with pytest.raises(Exception, match="API Error"):
            await provider.generate(GenerateRequest(prompt="hi", provider="azure_openai"))


class TestAzureGenerateStream:
    @pytest.mark.asyncio
    async def test_stream_yields_chunks(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        from smr_v2.models.stream import StreamChunk

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

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        chunks = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", stream=True, provider="azure_openai")):
            chunks.append(chunk)

        text_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(text_chunks) == 3
        assert text_chunks[0].content == "Hello"

        done_chunks = [c for c in chunks if c.type == "done"]
        assert len(done_chunks) == 1


class TestAzureStructuredOutput:
    @pytest.mark.asyncio
    async def test_generate_with_json_format(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = '{"key": "value"}'
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            response_format=ResponseFormat(type="json"),
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["response_format"] == {"type": "json_object"}

    @pytest.mark.asyncio
    async def test_generate_with_json_schema_format(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = '{"name": "test"}'
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        schema = {"title": "MySchema", "type": "object", "properties": {"name": {"type": "string"}}}
        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["name"] == "MySchema"
        assert rf["json_schema"]["strict"] is True

    @pytest.mark.asyncio
    async def test_stream_with_json_format(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        from smr_v2.models.stream import StreamChunk

        async def _mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = '{"key": "value"}'
            chunk.choices[0].finish_reason = "stop"
            yield chunk

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            stream=True,
            response_format=ResponseFormat(type="json"),
        )
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["response_format"] == {"type": "json_object"}
        assert call_kwargs["stream"] is True

    @pytest.mark.asyncio
    async def test_stream_with_json_schema_format(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        from smr_v2.models.stream import StreamChunk

        async def _mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = '{"name": "test"}'
            chunk.choices[0].finish_reason = "stop"
            yield chunk

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        schema = {"title": "MySchema", "type": "object", "properties": {"name": {"type": "string"}}}
        req = GenerateRequest(
            prompt="Return JSON",
            provider="azure_openai",
            stream=True,
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
        )
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["name"] == "MySchema"
        assert call_kwargs["stream"] is True

    @pytest.mark.asyncio
    async def test_stream_without_response_format_omits_it(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        async def _mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = "Hello"
            chunk.choices[0].finish_reason = "stop"
            yield chunk

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        req = GenerateRequest(prompt="hi", provider="azure_openai", stream=True)
        async for _ in provider.generate_stream(req):
            pass

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert "response_format" not in call_kwargs


class TestAzureHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_true(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(return_value=MagicMock())
        assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_false_on_error(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(side_effect=Exception("down"))
        assert await provider.health_check() is False


class TestAzureGetInfo:
    @pytest.mark.asyncio
    async def test_get_info(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(return_value=MagicMock())
        info = await provider.get_info()
        assert info.name == "azure_openai"
        assert info.supports_streaming is True
