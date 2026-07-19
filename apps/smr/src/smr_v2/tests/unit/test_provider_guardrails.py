"""TDD tests for provider-native guardrails (Tasks 1.11 & 1.12).

Task 1.11: Bedrock guardrail integration via guardrailConfig in converse API.
Task 1.12: Azure OpenAI content safety filter logging and error handling.

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from smr_v2.core.config import AzureOpenAIConfig, BedrockConfig
from smr_v2.models.requests import GenerateRequest

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def bedrock_config_with_guardrail():
    return BedrockConfig(
        region="us-east-1",
        default_model="anthropic.claude-3-sonnet-20240229-v1:0",
        guardrail_id="gr-123",
        guardrail_version="1",
    )


@pytest.fixture
def bedrock_config_no_guardrail():
    return BedrockConfig(
        region="us-east-1",
        default_model="anthropic.claude-3-sonnet-20240229-v1:0",
    )


@pytest.fixture
def azure_config():
    return AzureOpenAIConfig(
        api_key="test-key",
        endpoint="https://test.openai.azure.com",
        api_version="2024-06-01",
        deployment_name="gpt-4",
        default_model="gpt-4",
    )


# ===========================================================================
# Task 1.11 — Bedrock Guardrails
# ===========================================================================

class TestBedrockGuardrailConfig:
    """Verify guardrailConfig is injected into converse params."""

    def test_bedrock_guardrail_config_added_when_id_set(
        self, bedrock_config_with_guardrail
    ):
        from smr_v2.providers.bedrock import BedrockProvider

        with patch("smr_v2.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = MagicMock()
            provider = BedrockProvider(config=bedrock_config_with_guardrail)

        request = GenerateRequest(prompt="test prompt", provider="bedrock")
        params = provider._build_converse_params(request)

        assert "guardrailConfig" in params
        assert params["guardrailConfig"]["guardrailIdentifier"] == "gr-123"
        assert params["guardrailConfig"]["guardrailVersion"] == "1"

    def test_bedrock_guardrail_config_absent_when_id_empty(
        self, bedrock_config_no_guardrail
    ):
        from smr_v2.providers.bedrock import BedrockProvider

        with patch("smr_v2.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = MagicMock()
            provider = BedrockProvider(config=bedrock_config_no_guardrail)

        request = GenerateRequest(prompt="test prompt", provider="bedrock")
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
    async def test_bedrock_guardrail_intervened_logged(
        self, bedrock_config_with_guardrail
    ):
        from smr_v2.providers.bedrock import BedrockProvider

        mock_client = MagicMock()
        mock_client.converse.return_value = {
            "output": {
                "message": {
                    "content": [
                        {"text": "Sorry, I cannot help with that request."}
                    ]
                }
            },
            "usage": {"inputTokens": 10, "outputTokens": 5},
            "stopReason": "guardrail_intervened",
        }

        with patch("smr_v2.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            provider = BedrockProvider(config=bedrock_config_with_guardrail)

        with patch("smr_v2.providers.bedrock.logger") as mock_logger:
            content, _reasoning, stats = await provider.generate(
                GenerateRequest(prompt="bad prompt", provider="bedrock")
            )

            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "guardrail_intervened" in call_args[0][0]

        from smr_v2.models.stats import GenerationStats

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
        config = AzureOpenAIConfig(
            api_key="test-key",
            endpoint="https://test.openai.azure.com",
            default_model="gpt-4",
        )
        assert config.content_filter_severity == "medium"

    def test_azure_content_filter_severity_custom(self):
        config = AzureOpenAIConfig(
            api_key="test-key",
            endpoint="https://test.openai.azure.com",
            default_model="gpt-4",
            content_filter_severity="high",
        )
        assert config.content_filter_severity == "high"


class TestAzureContentFilterErrorHandling:
    """Verify content filter errors from Azure are logged and re-raised."""

    @pytest.mark.asyncio
    async def test_azure_content_filter_error_logged(self, azure_config):
        from openai import BadRequestError

        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()

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

        with patch("smr_v2.providers.azure_openai.logger") as mock_logger:
            with pytest.raises(BadRequestError):
                await provider.generate(
                    GenerateRequest(prompt="bad prompt", provider="azure_openai")
                )

            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "content_filter" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_azure_non_content_filter_error_not_logged_as_filter(
        self, azure_config
    ):
        """Non-content-filter BadRequestError should NOT trigger filter logging."""
        from openai import BadRequestError

        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()

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

        with patch("smr_v2.providers.azure_openai.logger") as mock_logger:
            with pytest.raises(BadRequestError):
                await provider.generate(
                    GenerateRequest(prompt="hello", provider="azure_openai")
                )

            mock_logger.warning.assert_not_called()
