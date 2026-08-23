"""TDD tests for BedrockProvider.

Tests mock boto3 client via asyncio.to_thread.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client




class TestBedrockProviderInit:
    def test_creates_with_config(self):
        from text.providers.bedrock import BedrockProvider

        if True:
            provider = BedrockProvider()
            assert provider is not None


class TestBedrockGenerate:
    @pytest.mark.asyncio
    async def test_generate_returns_text(self):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "Bedrock says hi!"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 10},
            "stopReason": "end_turn",
        }

        if True:
            provider = BedrockProvider()
            stub_client(provider, mock_client)
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
    async def test_generate_sends_messages(self):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 5, "outputTokens": 2},
            "stopReason": "end_turn",
        }

        if True:
            provider = BedrockProvider()
            stub_client(provider, mock_client)
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
    async def test_generate_raises_on_error(self):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.side_effect = Exception("Bedrock error")

        if True:
            provider = BedrockProvider()
            stub_client(provider, mock_client)
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
    async def test_stream_yields_chunks(self):
        from text.providers.bedrock import BedrockProvider

        mock_stream_events = [
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"contentBlockDelta": {"delta": {"text": " world"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 5, "outputTokens": 10}}},
        ]

        mock_client = MagicMock()
        mock_client.converse_stream.return_value = {"stream": iter(mock_stream_events)}

        if True:
            provider = BedrockProvider()
            stub_client(provider, mock_client)
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
    """Bedrock has no process-level AWS account to probe.

    Credential AND region arrive per request, so `health_check` returns True —
    "no negative evidence". `PoolHealthTracker` acts only on a POSITIVELY
    known-unhealthy result (`services/pool_health.py`), and reporting False would
    take Bedrock out of degrade routing for every tenant with a working key.
    """

    @pytest.mark.asyncio
    async def test_health_check_is_not_a_negative_signal(self):
        from text.providers.bedrock import BedrockProvider

        assert await BedrockProvider().health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_builds_no_aws_client(self):
        """The ambient-chain guard: a probe must not construct a client either."""
        from text.providers.bedrock import BedrockProvider

        with patch("text.providers.bedrock._bearer_client") as build_client:
            await BedrockProvider().health_check()
        build_client.assert_not_called()


class TestBedrockGetInfo:
    """Adapter capabilities only — listing foundation models needs an AWS account
    to list them IN, and this process has none. The catalogue is `AiModel`."""

    @pytest.mark.asyncio
    async def test_get_info_reports_adapter_capabilities(self):
        from text.providers.bedrock import BedrockProvider

        info = await BedrockProvider().get_info()
        assert info.name == "bedrock"
        assert info.supports_streaming is True
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_get_info_advertises_no_model_of_its_own(self):
        from text.providers.bedrock import BedrockProvider

        info = await BedrockProvider().get_info()
        assert info.default_model == ""
        assert info.models == []

    @pytest.mark.asyncio
    async def test_get_info_calls_no_aws_api(self):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        provider = BedrockProvider()
        stub_client(provider, mock_client)
        await provider.get_info()
        mock_client.list_foundation_models.assert_not_called()
