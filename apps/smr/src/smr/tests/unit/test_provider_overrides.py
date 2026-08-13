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

from smr.core.config import AzureOpenAIConfig, BedrockConfig
from smr.models.requests import GenerateRequest, ProviderOverride
from smr.tests.conftest import keyed


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
    return keyed(
        AzureOpenAIConfig(
            endpoint="https://env.openai.azure.com",
            api_version="2024-06-01",
            deployment_name="",
            default_model="gpt-4",
        ),
        "env-key",
    )


class TestAzureProviderOverrideConsumption:
    """override-wins-over-env/config, unit-testable against the client factory."""

    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(
        self, azure_config
    ):
        from smr.providers.azure_openai import AzureOpenAIProvider

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
            "smr.providers.azure_openai.AsyncAzureOpenAI", return_value=override_client
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
        from smr.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "platform response"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = AzureOpenAIProvider(config=azure_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch("smr.providers.azure_openai.AsyncAzureOpenAI") as mock_ctor:
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
        from smr.providers.bedrock import BedrockProvider

        env_client = MagicMock()  # the shared/env client — must NOT be used
        override_client = MagicMock()
        override_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "byo bedrock response"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1},
            "stopReason": "end_turn",
        }

        with patch("smr.providers.bedrock.boto3") as mock_boto3:
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
        from smr.providers.bedrock import BedrockProvider

        env_client = MagicMock()
        env_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "platform bedrock response"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1},
            "stopReason": "end_turn",
        }

        with patch("smr.providers.bedrock.boto3") as mock_boto3:
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


# --- new cloud BYO providers (openai / anthropic / vertex) ---------


class TestProviderOverrideNewFields:
    """C4 wire shape gained ``model`` (override-wins model) + Vertex
    ``project``/``location``, additively — old callers unaffected."""

    def test_model_project_location_default_to_none(self):
        override = ProviderOverride(api_key="k")
        assert override.model is None
        assert override.project is None
        assert override.location is None

    def test_new_fields_round_trip(self):
        override = ProviderOverride(
            api_key="k", model="gemini-2.0-flash", project="proj-1", location="us-central1"
        )
        assert override.model == "gemini-2.0-flash"
        assert override.project == "proj-1"
        assert override.location == "us-central1"


@pytest.fixture
def openai_config():
    from smr.core.config import OpenAIConfig

    return keyed(OpenAIConfig(base_url="https://api.openai.com/v1"), "env-key")


class TestOpenAIProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(
        self, openai_config
    ):
        from smr.providers.openai import OpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "byo openai response"
        mock_choice.message.reasoning_content = None
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = OpenAIProvider(config=openai_config)
        provider._client = AsyncMock()  # shared env client — must NOT be used

        override_client = AsyncMock()
        override_client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch("smr.providers.openai.AsyncOpenAI", return_value=override_client) as mock_ctor:
            req = GenerateRequest(
                prompt="hi",
                provider="openai",
                model="caller-model",
                provider_overrides={
                    "openai": {
                        "api_key": "byo-secret-value",
                        "base_url": "https://tenant.example.com/v1",
                        "model": "tenant-model",
                    }
                },
            )
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "byo openai response"
        mock_ctor.assert_called_once()
        ctor_kwargs = mock_ctor.call_args.kwargs
        assert ctor_kwargs["api_key"] == "byo-secret-value"
        assert ctor_kwargs["base_url"] == "https://tenant.example.com/v1"
        # override.model wins over the caller-supplied model.
        call_kwargs = override_client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "tenant-model"
        provider._client.chat.completions.create.assert_not_called()

    @pytest.mark.asyncio
    async def test_absent_override_reuses_the_shared_client_unchanged(self, openai_config):
        from smr.providers.openai import OpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "platform response"
        mock_choice.message.reasoning_content = None
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = OpenAIProvider(config=openai_config)
        provider._client = AsyncMock()
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch("smr.providers.openai.AsyncOpenAI") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="openai", model="caller-model")
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "platform response"
        mock_ctor.assert_not_called()
        provider._client.chat.completions.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_two_tenants_do_not_share_a_client(self, openai_config):
        """A fresh request-scoped client is built per override — two tenants'
        concurrent requests can never reuse one client instance."""
        from smr.providers.openai import OpenAIProvider

        provider = OpenAIProvider(config=openai_config)
        with patch("smr.providers.openai.AsyncOpenAI") as mock_ctor:
            mock_ctor.side_effect = lambda **_: AsyncMock()
            req_a = GenerateRequest(
                prompt="hi",
                provider="openai",
                provider_overrides={"openai": {"api_key": "tenant-a-key"}},
            )
            req_b = GenerateRequest(
                prompt="hi",
                provider="openai",
                provider_overrides={"openai": {"api_key": "tenant-b-key"}},
            )
            client_a = provider._client_for(req_a)
            client_b = provider._client_for(req_b)

        assert client_a is not client_b
        assert mock_ctor.call_count == 2

    def test_fail_open_falls_back_to_env_client_when_override_build_raises(
        self, openai_config, caplog
    ):
        from smr.providers.openai import OpenAIProvider

        provider = OpenAIProvider(config=openai_config)
        sentinel_env_client = provider._client

        with patch(
            "smr.providers.openai.AsyncOpenAI",
            side_effect=RuntimeError("bad key"),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="openai",
                provider_overrides={"openai": {"api_key": "byo-broken-openai-key"}},
            )
            client = provider._client_for(req)

        # Degrades to the shared env client rather than failing the request...
        assert client is sentinel_env_client
        # ...and the raw key never appears in any captured log line.
        assert "byo-broken-openai-key" not in caplog.text


@pytest.fixture
def anthropic_config():
    from smr.core.config import AnthropicConfig

    return keyed(
        AnthropicConfig(default_model="claude-3-5-haiku-20241022"),
        "env-key",
    )


class TestAnthropicProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(
        self, anthropic_config
    ):
        from smr.providers.anthropic import AnthropicProvider

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "byo anthropic response"
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_message.stop_reason = "end_turn"
        mock_message.usage = MagicMock(input_tokens=3, output_tokens=4)

        provider = AnthropicProvider(config=anthropic_config)
        provider._client = MagicMock()  # shared env client — must NOT be used

        override_client = MagicMock()
        override_client.messages.create = AsyncMock(return_value=mock_message)

        with patch(
            "smr.providers.anthropic.AsyncAnthropic", return_value=override_client
        ) as mock_ctor:
            req = GenerateRequest(
                prompt="hi",
                provider="anthropic",
                model="caller-model",
                provider_overrides={
                    "anthropic": {"api_key": "byo-secret-value", "model": "tenant-model"}
                },
            )
            content, _reasoning, stats = await provider.generate(req)

        assert content == "byo anthropic response"
        assert stats.prompt_tokens == 3
        assert stats.predicted_tokens == 4
        assert stats.stop_reason == "stop"
        mock_ctor.assert_called_once()
        assert mock_ctor.call_args.kwargs["api_key"] == "byo-secret-value"
        call_kwargs = override_client.messages.create.call_args.kwargs
        assert call_kwargs["model"] == "tenant-model"

    @pytest.mark.asyncio
    async def test_absent_override_reuses_the_shared_client_unchanged(self, anthropic_config):
        from smr.providers.anthropic import AnthropicProvider

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "platform response"
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_message.stop_reason = "end_turn"
        mock_message.usage = MagicMock(input_tokens=1, output_tokens=1)

        provider = AnthropicProvider(config=anthropic_config)
        provider._client = MagicMock()
        provider._client.messages.create = AsyncMock(return_value=mock_message)

        with patch("smr.providers.anthropic.AsyncAnthropic") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="anthropic", model="caller-model")
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "platform response"
        mock_ctor.assert_not_called()
        provider._client.messages.create.assert_called_once()

    def test_fail_open_falls_back_to_env_client_when_override_build_raises(
        self, anthropic_config, caplog
    ):
        from smr.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider(config=anthropic_config)
        sentinel_env_client = provider._client

        with patch(
            "smr.providers.anthropic.AsyncAnthropic",
            side_effect=RuntimeError("bad key"),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="anthropic",
                provider_overrides={"anthropic": {"api_key": "byo-broken-anthropic-key"}},
            )
            client = provider._client_for(req)

        assert client is sentinel_env_client
        assert "byo-broken-anthropic-key" not in caplog.text


@pytest.fixture
def vertex_config():
    from smr.core.config import VertexConfig

    return VertexConfig(project="env-project", location="us-central1")


class TestVertexProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_sa_key(self, vertex_config):
        from smr.providers.vertex import VertexProvider

        candidate = MagicMock()
        candidate.finish_reason = "STOP"
        mock_response = MagicMock()
        mock_response.text = "byo vertex response"
        mock_response.candidates = [candidate]
        mock_response.usage_metadata = MagicMock(
            prompt_token_count=5, candidates_token_count=6, total_token_count=11
        )

        override_client = MagicMock()
        override_client.aio.models.generate_content = AsyncMock(return_value=mock_response)

        provider = VertexProvider(config=vertex_config)
        provider._client = MagicMock()  # shared env client — must NOT be used

        sa_json = '{"type":"service_account","project_id":"tenant-proj"}'
        with (
            patch("smr.providers.vertex.genai.Client", return_value=override_client) as mock_ctor,
            patch(
                "smr.providers.vertex.service_account.Credentials.from_service_account_info",
                return_value=MagicMock(),
            ),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="vertex",
                model="gemini-2.0-flash",
                provider_overrides={
                    "vertex": {
                        "api_key": sa_json,
                        "project": "tenant-proj",
                        "location": "europe-west1",
                        "model": "gemini-1.5-pro",
                    }
                },
            )
            content, _reasoning, stats = await provider.generate(req)

        assert content == "byo vertex response"
        assert stats.prompt_tokens == 5
        assert stats.predicted_tokens == 6
        mock_ctor.assert_called_once()
        ctor_kwargs = mock_ctor.call_args.kwargs
        assert ctor_kwargs["vertexai"] is True
        assert ctor_kwargs["project"] == "tenant-proj"
        assert ctor_kwargs["location"] == "europe-west1"
        # override.model wins.
        call_kwargs = override_client.aio.models.generate_content.call_args.kwargs
        assert call_kwargs["model"] == "gemini-1.5-pro"

    @pytest.mark.asyncio
    async def test_absent_override_reuses_the_shared_client_unchanged(self, vertex_config):
        from smr.providers.vertex import VertexProvider

        candidate = MagicMock()
        candidate.finish_reason = "STOP"
        mock_response = MagicMock()
        mock_response.text = "platform response"
        mock_response.candidates = [candidate]
        mock_response.usage_metadata = MagicMock(
            prompt_token_count=1, candidates_token_count=1, total_token_count=2
        )

        provider = VertexProvider(config=vertex_config)
        provider._client = MagicMock()
        provider._client.aio.models.generate_content = AsyncMock(return_value=mock_response)

        with patch("smr.providers.vertex.genai.Client") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="vertex", model="gemini-2.0-flash")
            content, _reasoning, _stats = await provider.generate(req)

        assert content == "platform response"
        mock_ctor.assert_not_called()
        provider._client.aio.models.generate_content.assert_called_once()

    def test_fail_open_falls_back_to_env_client_when_override_build_raises(
        self, vertex_config, caplog
    ):
        from smr.providers.vertex import VertexProvider

        provider = VertexProvider(config=vertex_config)
        sentinel_env_client = provider._client

        with patch(
            "smr.providers.vertex.service_account.Credentials.from_service_account_info",
            side_effect=ValueError("bad sa json"),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="vertex",
                provider_overrides={"vertex": {"api_key": "byo-broken-vertex-sa-key"}},
            )
            client = provider._client_for(req)

        assert client is sentinel_env_client
        assert "byo-broken-vertex-sa-key" not in caplog.text
