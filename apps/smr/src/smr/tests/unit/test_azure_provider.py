"""TDD tests for AzureOpenAIProvider.

Tests mock the openai.AsyncAzureOpenAI client.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from smr.core.config import AzureOpenAIConfig
from smr.models.requests import GenerateRequest, ResponseFormat
from smr.tests.conftest import keyed


@pytest.fixture
def azure_config():
    return keyed(
        AzureOpenAIConfig(
            endpoint="https://test.openai.azure.com",
            api_version="2024-06-01",
            deployment_name="gpt-4",
            default_model="gpt-4",
        ),
        "test-key",
    )


class TestAzureProviderInit:
    def test_creates_with_config(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        assert provider is not None

    def test_default_model_from_config(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        assert provider._default_model == "gpt-4"


class TestAzureGenerate:
    @pytest.mark.asyncio
    async def test_generate_returns_text(self, azure_config):
        from smr.models.stats import GenerationStats
        from smr.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "Azure response!"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        content, _reasoning, stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="azure_openai")
        )
        assert content == "Azure response!"
        assert isinstance(stats, GenerationStats)

    @pytest.mark.asyncio
    async def test_generate_sends_messages(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        await provider.generate(
            GenerateRequest(
                prompt="explain AI", system_prompt="You are helpful", provider="azure_openai"
            )
        )

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        messages = call_kwargs["messages"]
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        assert messages[1]["content"] == "explain AI"

    @pytest.mark.asyncio
    async def test_generate_raises_on_api_error(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(side_effect=Exception("API Error"))

        with pytest.raises(Exception, match="API Error"):
            await provider.generate(GenerateRequest(prompt="hi", provider="azure_openai"))


class TestAzureGenerateStream:
    @pytest.mark.asyncio
    async def test_stream_yields_reasoning_then_content(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

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

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=_mock_stream())

        chunks = []
        async for chunk in provider.generate_stream(
            GenerateRequest(prompt="hi", stream=True, provider="azure_openai")
        ):
            chunks.append(chunk)

        reasoning_chunks = [c for c in chunks if c.type == "reasoning"]
        assert len(reasoning_chunks) == 1
        assert reasoning_chunks[0].content == "Thinking..."

    @pytest.mark.asyncio
    async def test_stream_yields_chunks(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

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
        async for chunk in provider.generate_stream(
            GenerateRequest(prompt="hi", stream=True, provider="azure_openai")
        ):
            chunks.append(chunk)

        text_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(text_chunks) == 3
        assert text_chunks[0].content == "Hello"

        done_chunks = [c for c in chunks if c.type == "done"]
        assert len(done_chunks) == 1


class TestAzureStructuredOutput:
    @pytest.mark.asyncio
    async def test_generate_with_json_format(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = '{"key": "value"}'
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

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
        from smr.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = '{"name": "test"}'
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

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
        from smr.providers.azure_openai import AzureOpenAIProvider

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
        from smr.providers.azure_openai import AzureOpenAIProvider

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
        from smr.providers.azure_openai import AzureOpenAIProvider

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


class TestAzureDeploymentName:
    """D6 (dead-config sweep) — ``AzureOpenAIConfig.deployment_name``
    was defined but never read; Azure OpenAI routes requests by *deployment
    name*, not model name, so an operator-configured deployment must win over
    the caller-supplied ``request.model``. When unset (the "" default), today's
    behavior — forwarding ``request.model`` unchanged — must be preserved.
    """

    @pytest.mark.asyncio
    async def test_generate_uses_deployment_name_when_configured(self, azure_config):
        """RED: deployment_name (="gpt-4" on the fixture) is currently never
        read, so the caller-supplied request.model is sent to Azure even when
        an explicit deployment is configured."""
        from smr.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        req = GenerateRequest(prompt="hi", provider="azure_openai", model="some-other-caller-model")
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "gpt-4"

    @pytest.mark.asyncio
    async def test_generate_falls_back_to_request_model_when_deployment_name_unset(self):
        """Default deployment_name ("") must preserve today's behavior: the
        caller-supplied request.model is forwarded unchanged to Azure.

        deployment_name="" is passed explicitly (not relied on as an implicit
        pydantic default) so this test is deterministic regardless of ambient
        SMR_AZURE_DEPLOYMENT_NAME env state (e.g. the e2e conftest's
        module-level os.environ mutation from the monorepo-root .env)."""
        from smr.providers.azure_openai import AzureOpenAIProvider

        config = keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                api_version="2024-06-01",
                default_model="gpt-4",
                deployment_name="",
            ),
            "test-key",
        )
        assert config.deployment_name == ""

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)

        provider = AzureOpenAIProvider(config=config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        req = GenerateRequest(prompt="hi", provider="azure_openai", model="caller-model")
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "caller-model"


class TestAzureHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_true(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(return_value=MagicMock())
        assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_false_on_error(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(side_effect=Exception("down"))
        assert await provider.health_check() is False


class TestAzureGetInfo:
    @pytest.mark.asyncio
    async def test_get_info(self, azure_config):
        from smr.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(return_value=MagicMock())
        info = await provider.get_info()
        assert info.name == "azure_openai"
        assert info.supports_streaming is True
