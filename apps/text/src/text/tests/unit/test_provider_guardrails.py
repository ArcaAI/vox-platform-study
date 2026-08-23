"""TDD tests for provider-native guardrails (Tasks 1.11 & 1.12).

Task 1.11: Bedrock guardrail integration via guardrailConfig in converse API.
Task 1.12: Azure OpenAI content safety filter logging and error handling.

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------








# ===========================================================================
# Task 1.11 — Bedrock Guardrails
# ===========================================================================


class TestBedrockGuardrailConfig:
    """Verify guardrailConfig is injected into converse params."""

    def test_bedrock_guardrail_config_added_when_id_set(self):
        from text.providers.bedrock import BedrockProvider

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = MagicMock()
            provider = BedrockProvider()

        request = GenerateRequest(prompt="test prompt", provider="bedrock", model="test-model")
        params = provider._build_converse_params(request)

        assert "guardrailConfig" in params
        assert params["guardrailConfig"]["guardrailIdentifier"] == "gr-123"
        assert params["guardrailConfig"]["guardrailVersion"] == "1"

    def test_bedrock_guardrail_config_absent_when_id_empty(self):
        from text.providers.bedrock import BedrockProvider

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = MagicMock()
            provider = BedrockProvider()

        request = GenerateRequest(prompt="test prompt", provider="bedrock", model="test-model")
        params = provider._build_converse_params(request)

        assert "guardrailConfig" not in params

    def test_bedrock_guardrail_config_default_version(self):
        config = BedrockConfig(
            region="us-east-1",
            default_model="anthropic.claude-3-sonnet-20240229-v1:0",
            guardrail_id="gr-456",
        )
        assert config.guardrail_version == "DRAFT"


class TestBedrockGuardrailIntervened:
    """Verify guardrail_intervened stop reason is logged and handled."""

    @pytest.mark.asyncio
    async def test_bedrock_guardrail_intervened_logged(self):
        from text.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {
                "message": {"content": [{"text": "Sorry, I cannot help with that request."}]}
            },
            "usage": {"inputTokens": 10, "outputTokens": 5},
            "stopReason": "guardrail_intervened",
        }

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.Session.return_value.client.return_value = mock_client
            provider = BedrockProvider()

        with patch("text.providers.bedrock.logger") as mock_logger:
            content, _reasoning, stats = await provider.generate(
                GenerateRequest(
                    prompt="bad prompt",
                    provider="bedrock",
                    model="anthropic.claude-3-sonnet-20240229-v1:0",
                )
            )

            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "guardrail_intervened" in call_args[0][0]

        from text.models.stats import GenerationStats

        assert isinstance(content, str)
        assert isinstance(stats, GenerationStats)
        # AD-1: the native ``guardrail_intervened`` maps to content_filter.
        assert stats.stop_reason == "content_filter"


# ===========================================================================
# Task 1.12 — Azure Content Safety
# ===========================================================================


class TestAzureContentFilterConfig:
    """Verify content_filter_severity config field exists with correct default."""

    def test_azure_content_filter_severity_config(self):
        config = keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                default_model="gpt-4",
            ),
            "test-key",
        )
        assert config.content_filter_severity == "medium"

    def test_azure_content_filter_severity_custom(self):
        config = keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                default_model="gpt-4",
                content_filter_severity="high",
            ),
            "test-key",
        )
        assert config.content_filter_severity == "high"


class TestAzureContentFilterErrorHandling:
    """Verify content filter errors from Azure are logged and re-raised."""

    @pytest.mark.asyncio
    async def test_azure_content_filter_error_logged(self):
        from openai import BadRequestError

        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())

        error_body = {
            "error": {
                "message": "The response was filtered due to the prompt triggering Azure OpenAI's content_filter policy.",
                "code": "content_filter",
            }
        }
        provider._client.chat.completions.create = AsyncMock(
            side_effect=BadRequestError(
                message="content_filter policy triggered",
                response=MagicMock(status_code=400, json=lambda: error_body),
                body=error_body,
            )
        )

        with patch("text.providers.azure_openai.logger") as mock_logger:
            with pytest.raises(BadRequestError):
                await provider.generate(
                    GenerateRequest(prompt="bad prompt", provider="azure_openai", model="test-model")
                )

            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "content_filter" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_azure_non_content_filter_error_not_logged_as_filter(self):
        """Non-content-filter BadRequestError should NOT trigger filter logging."""
        from openai import BadRequestError

        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        provider._client = stub_client(provider, AsyncMock())

        error_body = {
            "error": {
                "message": "Invalid model specified",
                "code": "invalid_model",
            }
        }
        provider._client.chat.completions.create = AsyncMock(
            side_effect=BadRequestError(
                message="Invalid model specified",
                response=MagicMock(status_code=400, json=lambda: error_body),
                body=error_body,
            )
        )

        with patch("text.providers.azure_openai.logger") as mock_logger:
            with pytest.raises(BadRequestError):
                await provider.generate(GenerateRequest(prompt="hello", provider="azure_openai", model="test-model"))

            mock_logger.warning.assert_not_called()
