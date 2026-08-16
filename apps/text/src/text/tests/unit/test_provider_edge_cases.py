"""Edge case tests for LLM providers — empty responses, parse errors, stream errors."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from text.core.config import AzureOpenAIConfig, BedrockConfig
from text.models.requests import GenerateRequest
from text.tests.conftest import keyed


@pytest.fixture
def azure_config():
    return keyed(
        AzureOpenAIConfig(
            endpoint="https://test.openai.azure.com",
            deployment_name="gpt-4",
            default_model="gpt-4",
        ),
        "k",
    )


@pytest.fixture
def bedrock_config():
    return BedrockConfig(
        region="us-east-1", default_model="anthropic.claude-3-sonnet-20240229-v1:0"
    )


@pytest.fixture
def mock_http():
    return AsyncMock(spec=httpx.AsyncClient)


# ── Azure edge cases ──


class TestAzureEdgeCases:
    @pytest.mark.asyncio
    async def test_generate_empty_content(self, azure_config):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = None
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=0, total_tokens=1)
        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)
        content, _reasoning, _stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="azure_openai")
        )
        assert content == ""

    @pytest.mark.asyncio
    async def test_generate_passes_all_params(self, azure_config):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)
        await provider.generate(
            GenerateRequest(
                prompt="hi", temperature=0.2, max_tokens=100, top_p=0.8, provider="azure_openai"
            )
        )
        call_kw = provider._client.chat.completions.create.call_args.kwargs
        assert call_kw["temperature"] == 0.2
        assert call_kw["max_completion_tokens"] == 100
        assert call_kw["top_p"] == 0.8

    @pytest.mark.asyncio
    async def test_stream_skips_empty_choices(self, azure_config):
        from text.providers.azure_openai import AzureOpenAIProvider

        async def _stream():
            empty = MagicMock()
            empty.choices = []
            yield empty
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = "hi"
            chunk.choices[0].finish_reason = None
            yield chunk
            done = MagicMock()
            done.choices = [MagicMock()]
            done.choices[0].delta.content = None
            done.choices[0].finish_reason = "stop"
            yield done

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=_stream())
        chunks = [
            c
            async for c in provider.generate_stream(
                GenerateRequest(prompt="hi", stream=True, provider="azure_openai")
            )
        ]
        text = [c for c in chunks if c.type == "chunk"]
        assert len(text) == 1

    @pytest.mark.asyncio
    async def test_get_info_when_unavailable(self, azure_config):
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(side_effect=Exception("auth failed"))
        info = await provider.get_info()
        assert info.status == "unavailable"


# ── Bedrock edge cases ──


class TestBedrockEdgeCases:
    @pytest.mark.asyncio
    async def test_generate_multiple_content_blocks(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "Hello "}, {"text": "world"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 10},
        }
        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            content, _reasoning, usage = await provider.generate(
                GenerateRequest(
                    prompt="hi", provider="bedrock", model="anthropic.claude-3-sonnet-20240229-v1:0"
                )
            )
        assert content == "Hello world"

    @pytest.mark.asyncio
    async def test_generate_with_system_prompt(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 2},
        }
        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            await provider.generate(
                GenerateRequest(
                    prompt="hi",
                    system_prompt="Be helpful",
                    provider="bedrock",
                    model="anthropic.claude-3-sonnet-20240229-v1:0",
                )
            )
        call_kw = mock_client.converse.call_args.kwargs
        assert "system" in call_kw
        assert call_kw["system"][0]["text"] == "Be helpful"

    @pytest.mark.asyncio
    async def test_stream_usage_event(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse_stream.return_value = {
            "stream": iter(
                [
                    {"contentBlockDelta": {"delta": {"text": "hi"}}},
                    {"messageStop": {"stopReason": "end_turn"}},
                    {"metadata": {"usage": {"inputTokens": 5, "outputTokens": 10}}},
                ]
            )
        }
        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            chunks = [
                c
                async for c in provider.generate_stream(
                    GenerateRequest(
                        prompt="hi",
                        stream=True,
                        provider="bedrock",
                        model="anthropic.claude-3-sonnet-20240229-v1:0",
                    )
                )
            ]
        usage = [c for c in chunks if c.type == "usage"]
        assert len(usage) == 1
        assert usage[0].data["total_tokens"] == 15

    @pytest.mark.asyncio
    async def test_stream_empty_text_skipped(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse_stream.return_value = {
            "stream": iter(
                [
                    {"contentBlockDelta": {"delta": {"text": ""}}},
                    {"contentBlockDelta": {"delta": {"text": "hello"}}},
                    {"messageStop": {"stopReason": "end_turn"}},
                ]
            )
        }
        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            chunks = [
                c
                async for c in provider.generate_stream(
                    GenerateRequest(
                        prompt="hi",
                        stream=True,
                        provider="bedrock",
                        model="anthropic.claude-3-sonnet-20240229-v1:0",
                    )
                )
            ]
        text = [c for c in chunks if c.type == "chunk"]
        assert len(text) == 1
        assert text[0].content == "hello"

    @pytest.mark.asyncio
    async def test_get_info_when_unavailable(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.list_foundation_models.side_effect = Exception("no creds")
        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            info = await provider.get_info()
        assert info.status == "unavailable"
        assert info.models == []

    @pytest.mark.asyncio
    async def test_generate_passes_inference_config(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 2},
        }
        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            await provider.generate(
                GenerateRequest(
                    prompt="hi",
                    temperature=0.1,
                    max_tokens=200,
                    top_p=0.5,
                    provider="bedrock",
                    model="anthropic.claude-3-sonnet-20240229-v1:0",
                )
            )
        call_kw = mock_client.converse.call_args.kwargs
        ic = call_kw["inferenceConfig"]
        assert ic["temperature"] == 0.1
        assert ic["maxTokens"] == 200
        assert ic["topP"] == 0.5
