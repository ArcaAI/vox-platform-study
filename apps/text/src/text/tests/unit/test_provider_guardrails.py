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


def _bedrock_request(**guardrail: str) -> GenerateRequest:
    """A request whose resolved connection may pin an AWS Bedrock Guardrail."""
    connection: dict[str, str] = {"api_key": "k", "region": "us-east-1"}
    connection.update(guardrail)
    return GenerateRequest(
        prompt="test prompt",
        provider="bedrock",
        model="test-model",
        provider_overrides={"bedrock": connection},
    )


class TestBedrockGuardrailConfig:
    """`guardrailConfig` is injected from the CONNECTION, not from the environment.

    An AWS Bedrock Guardrail belongs to the AWS account the request
    authenticates against, so it travels with that account's credential.
    `TEXT_BEDROCK_GUARDRAIL_ID` was a process-wide value that would have applied
    one tenant's guardrail — from another tenant's AWS account, where it does not
    even exist — to every other tenant's traffic.
    """

    def test_guardrail_config_added_when_the_connection_pins_one(self):
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        params = provider._build_converse_params(
            _bedrock_request(guardrail_id="gr-123", guardrail_version="1")
        )

        assert params["guardrailConfig"]["guardrailIdentifier"] == "gr-123"
        assert params["guardrailConfig"]["guardrailVersion"] == "1"

    def test_guardrail_config_absent_when_the_connection_pins_none(self):
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        assert "guardrailConfig" not in provider._build_converse_params(_bedrock_request())

    def test_guardrail_config_absent_when_there_is_no_connection_at_all(self):
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        request = GenerateRequest(prompt="test prompt", provider="bedrock", model="test-model")
        assert "guardrailConfig" not in provider._build_converse_params(request)

    def test_guardrail_version_defaults_to_draft(self):
        """AWS's own default for an unversioned guardrail."""
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        params = provider._build_converse_params(_bedrock_request(guardrail_id="gr-123"))
        assert params["guardrailConfig"]["guardrailVersion"] == "DRAFT"


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

        if True:
            provider = BedrockProvider()
            stub_client(provider, mock_client)

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


class TestAzureContentFilterSeverityIsNotAKnob:
    """`TEXT_AZURE_CONTENT_FILTER_SEVERITY` is gone, and it never did anything.

    The field was declared and read by nothing: Azure's content filter is
    configured on the Azure RESOURCE, not on an API request, so a value here
    could never have reached the wire. It was a knob that looked like a safety
    control and was not one — which is worse than its absence.

    What Text actually does with Azure's filter is REACT to it, and that is
    covered by `TestAzureContentFilterErrorHandling` below.
    """

    def test_no_content_filter_setting_exists(self):
        from text.core.config import Settings

        assert "content_filter_severity" not in Settings.model_fields


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
                    GenerateRequest(
                        prompt="bad prompt", provider="azure_openai", model="test-model"
                    )
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
                await provider.generate(
                    GenerateRequest(prompt="hello", provider="azure_openai", model="test-model")
                )

            mock_logger.warning.assert_not_called()
