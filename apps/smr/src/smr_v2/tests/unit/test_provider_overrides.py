"""TDD tests — SMR consumes gateway-injected `provider_overrides` (BYO cloud
credentials for azure/bedrock).

RED: written before implementation. Verifies:
  - `GenerateRequest.provider_overrides` / `ProviderOverride` exist and the
    `api_key` never leaks via repr/str/model_dump/logging.
  - the override WINS over env/config in both provider clients.
  - an ABSENT override leaves today's behavior byte-identical (the shared,
    config-built client is reused, not rebuilt).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from smr_v2.core.config import AzureOpenAIConfig, BedrockConfig
from smr_v2.models.requests import GenerateRequest, ProviderOverride


class TestProviderOverrideModel:
    def test_import_exists(self):
        assert ProviderOverride is not None

    def test_generate_request_defaults_to_no_overrides(self):
        req = GenerateRequest(prompt="hi", provider="azure")
        assert req.provider_overrides is None

    def test_generate_request_accepts_overrides(self):
        req = GenerateRequest(
            prompt="hi",
            provider="azure",
            provider_overrides={"azure": {"api_key": "byo-secret-value"}},
        )
        assert req.provider_overrides is not None
        assert req.provider_overrides["azure"].api_key.get_secret_value() == "byo-secret-value"

    def test_api_key_never_leaks_via_repr_or_str(self):
        override = ProviderOverride(api_key="byo-secret-value")
        assert "byo-secret-value" not in repr(override)
        assert "byo-secret-value" not in str(override)

    def test_api_key_never_leaks_via_model_dump(self):
        req = GenerateRequest(
            prompt="hi",
            provider="azure",
            provider_overrides={"azure": {"api_key": "byo-secret-value"}},
        )
        assert "byo-secret-value" not in repr(req)
        assert "byo-secret-value" not in str(req.model_dump())
        assert "byo-secret-value" not in req.model_dump_json()


@pytest.fixture
def azure_config():
    return AzureOpenAIConfig(
        api_key="env-key",
        endpoint="https://env.openai.azure.com",
        api_version="2024-06-01",
        deployment_name="",
        default_model="gpt-4",
    )


class TestAzureProviderOverrideConsumption:
    """override-wins-over-env/config, unit-testable against the client factory."""

    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(
        self, azure_config
    ):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "byo response"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()  # the shared/env client — must NOT be used

        override_client = AsyncMock()
        override_client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch(
            "smr_v2.providers.azure_openai.AsyncAzureOpenAI", return_value=override_client
        ) as mock_ctor:
            req = GenerateRequest(
                prompt="hi",
                provider="azure",
                model="caller-model",
                provider_overrides={
                    "azure": {
                        "api_key": "byo-secret-value",
                        "base_url": "https://tenant.openai.azure.com",
                        "api_version": "2025-01-01",
                        "deployment_name": "tenant-deployment",
                    }
                },
            )
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "byo response"
        # The tenant credential reached the SDK client constructor...
        mock_ctor.assert_called_once_with(
            api_key="byo-secret-value",
            azure_endpoint="https://tenant.openai.azure.com",
            api_version="2025-01-01",
        )
        # ...and the deployment override won model resolution.
        call_kwargs = override_client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "tenant-deployment"
        # The shared env-configured client was never touched.
        provider._client.chat.completions.create.assert_not_called()

    @pytest.mark.asyncio
    async def test_absent_override_reuses_the_shared_client_unchanged(self, azure_config):
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "platform response"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch("smr_v2.providers.azure_openai.AsyncAzureOpenAI") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="azure", model="caller-model")
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "platform response"
        mock_ctor.assert_not_called()
        provider._client.chat.completions.create.assert_called_once()


@pytest.fixture
def bedrock_config():
    return BedrockConfig(
        region="us-east-1", default_model="anthropic.claude-3-5-haiku-20241022-v1:0"
    )


class TestBedrockProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_bearer_token_client(self, bedrock_config):
        from smr_v2.providers.bedrock import BedrockProvider

        env_client = MagicMock()  # the shared/env client — must NOT be used
        override_client = MagicMock()
        override_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "byo bedrock response"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1},
            "stopReason": "end_turn",
        }

        with patch("smr_v2.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = env_client
            provider = BedrockProvider(config=bedrock_config)

            mock_session = MagicMock()
            mock_session.client.return_value = override_client
            mock_boto3.Session.return_value = mock_session

            req = GenerateRequest(
                prompt="hi",
                provider="bedrock",
                model="anthropic.claude-3-5-haiku-20241022-v1:0",
                provider_overrides={
                    "bedrock": {"api_key": "byo-lane-fake-bedrock-key", "region": "eu-west-1"},
                },
            )
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "byo bedrock response"
        # A request-scoped session/client was built (override wins)...
        mock_boto3.Session.assert_called_once()
        mock_session.client.assert_called_once()
        _, client_kwargs = mock_session.client.call_args
        assert client_kwargs["region_name"] == "eu-west-1"
        # ...and the shared env-configured client was never invoked.
        env_client.converse.assert_not_called()

    @pytest.mark.asyncio
    async def test_absent_override_reuses_the_shared_client_unchanged(self, bedrock_config):
        from smr_v2.providers.bedrock import BedrockProvider

        env_client = MagicMock()
        env_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "platform bedrock response"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1},
            "stopReason": "end_turn",
        }

        with patch("smr_v2.providers.bedrock.boto3") as mock_boto3:
            mock_boto3.client.return_value = env_client
            provider = BedrockProvider(config=bedrock_config)

            req = GenerateRequest(
                prompt="hi", provider="bedrock", model="anthropic.claude-3-5-haiku-20241022-v1:0"
            )
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "platform bedrock response"
        mock_boto3.Session.assert_not_called()
        env_client.converse.assert_called_once()


class TestProviderOverrideNeverLogged:
    """The gateway/service already guarantee the plaintext key is never
    logged on their side (see the config-plane assessment §Security). This
    locks the SMR-side half: a failed generation's error/log path must never
    include the raw override key, even incidentally via `str(request_body)`
    in an exception message."""

    def test_generate_request_str_never_contains_the_secret(self):
        req = GenerateRequest(
            prompt="hi",
            provider="bedrock",
            provider_overrides={"bedrock": {"api_key": "byo-lane-fake-bedrock-key"}},
        )
        assert "byo-lane-fake-bedrock-key" not in str(req)
        assert "byo-lane-fake-bedrock-key" not in repr(req)
