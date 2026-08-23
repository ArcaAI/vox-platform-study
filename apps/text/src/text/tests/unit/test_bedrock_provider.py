"""TDD tests for BedrockProvider.

Tests mock boto3 client via asyncio.to_thread.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from text.core.config import BedrockConfig
from text.models.requests import GenerateRequest
from text.tests.conftest import keyed


@pytest.fixture
def bedrock_config():
    # Keyed: Bedrock builds no platform client without an explicit credential
    # (TASK-799 closed its ambient boto3 chain), and these tests are about the
    # converse/stream wire, not the credential contract.
    return keyed(
        BedrockConfig(
            region="us-east-1",
            default_model="anthropic.claude-3-sonnet-20240229-v1:0",
        )
    )


class TestBedrockProviderInit:
    def test_creates_with_config(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = MagicMock()
            provider = BedrockProvider(config=bedrock_config)
            assert provider is not None


class TestBedrockGenerate:
    @pytest.mark.asyncio
    async def test_generate_returns_text(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "Bedrock says hi!"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 10},
            "stopReason": "end_turn",
        }

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            from text.models.stats import GenerationStats

            content, _reasoning, stats = await provider.generate(
                GenerateRequest(
                    prompt="hi",
                    provider="bedrock",
                    model="anthropic.claude-3-sonnet-20240229-v1:0",
                )
            )
            assert content == "Bedrock says hi!"
            assert isinstance(stats, GenerationStats)

    @pytest.mark.asyncio
    async def test_generate_sends_messages(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 2},
            "stopReason": "end_turn",
        }

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            await provider.generate(
                GenerateRequest(
                    prompt="explain AI",
                    system_prompt="You are helpful",
                    provider="bedrock",
                    model="anthropic.claude-3-sonnet-20240229-v1:0",
                )
            )

            call_kwargs = mock_client.converse.call_args.kwargs
            assert call_kwargs["messages"][0]["role"] == "user"
            assert "system" in call_kwargs

    @pytest.mark.asyncio
    async def test_generate_raises_on_error(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.side_effect = Exception("Bedrock error")

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            with pytest.raises(Exception, match="Bedrock error"):
                await provider.generate(
                    GenerateRequest(
                        prompt="hi",
                        provider="bedrock",
                        model="anthropic.claude-3-sonnet-20240229-v1:0",
                    )
                )


class TestBedrockGenerateStream:
    @pytest.mark.asyncio
    async def test_stream_yields_chunks(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_stream_events = [
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"contentBlockDelta": {"delta": {"text": " world"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 5, "outputTokens": 10}}},
        ]

        mock_client = MagicMock()
        mock_client.converse_stream.return_value = {"stream": iter(mock_stream_events)}

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            chunks = []
            async for chunk in provider.generate_stream(
                GenerateRequest(
                    prompt="hi",
                    stream=True,
                    provider="bedrock",
                    model="anthropic.claude-3-sonnet-20240229-v1:0",
                )
            ):
                chunks.append(chunk)

            text_chunks = [c for c in chunks if c.type == "chunk"]
            assert len(text_chunks) == 2
            assert text_chunks[0].content == "Hello"

            done_chunks = [c for c in chunks if c.type == "done"]
            assert len(done_chunks) == 1


class TestBedrockHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_true(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.list_foundation_models.return_value = {"modelSummaries": []}

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_false_on_error(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.list_foundation_models.side_effect = Exception("down")

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            assert await provider.health_check() is False


class TestBedrockGetInfo:
    @pytest.mark.asyncio
    async def test_get_info(self, bedrock_config):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.list_foundation_models.return_value = {
            "modelSummaries": [{"modelId": "anthropic.claude-3-sonnet-20240229-v1:0"}]
        }

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config)
            info = await provider.get_info()
            assert info.name == "bedrock"
            assert info.supports_streaming is True
