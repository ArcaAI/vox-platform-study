"""Text consumes gateway-injected `provider_overrides` — the ONLY source of a
provider connection.

Verifies:
  - `GenerateRequest.provider_overrides` / `ProviderOverride` exist and the
    `api_key` never leaks via repr/str/model_dump/logging.
  - the injected connection supplies endpoint, credential, routing and model.
  - each request builds its OWN client, so two tenants can never share one.
  - an ABSENT connection FAILS CLOSED.

That last point is the TASK-799 lane B inversion, and it is the whole reason this
file changed. These tests used to assert "absent override ⇒ the shared,
config-built client is reused" — which was only expressible because the process
held a credential of its own, read from `TEXT_<PROVIDER>_*`. A process-wide
credential is one no tenant can override and no admin can rotate without a
redeploy; worse, on the two adapters with an ambient SDK chain (bedrock's boto3,
vertex's ADC) it was a working platform identity that appeared in no config
surface at all. There is now nothing to fall back TO, and these tests say so.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.models.requests import GenerateRequest, ProviderOverride


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


class TestAzureProviderOverrideConsumption:
    """The connection is the only source, unit-testable against the client factory."""

    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "byo response"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = AzureOpenAIProvider()
        override_client = AsyncMock()
        override_client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch(
            "text.providers.azure_openai.AsyncAzureOpenAI", return_value=override_client
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

    @pytest.mark.asyncio
    async def test_absent_connection_fails_closed(self):
        """No injected connection ⇒ raise, and never build a client."""
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        with patch("text.providers.azure_openai.AsyncAzureOpenAI") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="azure", model="caller-model")
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(req)
        mock_ctor.assert_not_called()


class TestBedrockProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_bearer_token_client(self):
        from text.providers.bedrock import BedrockProvider

        env_client = MagicMock()  # the shared/env client — must NOT be used
        override_client = MagicMock()
        override_client.converse.return_value = {
            "output": {"message": {"content": [{"text": "byo bedrock response"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1},
            "stopReason": "end_turn",
        }

        with patch("text.providers.bedrock.boto3") as mock_boto3:
            provider = BedrockProvider()

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
        # ...and the ambient boto3 client factory was never used.
        mock_boto3.client.assert_not_called()
        env_client.converse.assert_not_called()

    @pytest.mark.asyncio
    async def test_absent_connection_fails_closed(self):
        """The F-01 half: absent a connection, Bedrock must NOT reach boto3's
        ambient credential chain (`AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / instance
        metadata)."""
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        with patch("text.providers.bedrock._bearer_client") as build_client:
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(
                    GenerateRequest(
                        prompt="hi",
                        provider="bedrock",
                        model="anthropic.claude-3-5-haiku-20241022-v1:0",
                    )
                )
        build_client.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_connection_without_a_region_fails_closed(self):
        """A Bedrock client is bound to a region, so the region travels with the
        credential rather than being a process-wide `TEXT_BEDROCK_REGION` that
        would pin every tenant's traffic to one AWS region."""
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.bedrock import BedrockProvider

        provider = BedrockProvider()
        with patch("text.providers.bedrock._bearer_client") as build_client:
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(
                    GenerateRequest(
                        prompt="hi",
                        provider="bedrock",
                        model="anthropic.claude-3-5-haiku-20241022-v1:0",
                        provider_overrides={"bedrock": {"api_key": "k"}},
                    )
                )
        build_client.assert_not_called()


class TestProviderOverrideNeverLogged:
    """The gateway/service already guarantee the plaintext key is never
    logged on their side (see the config-plane assessment §Security). This
    locks the Text-side half: a failed generation's error/log path must never
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


class TestOpenAIProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(self):
        from text.providers.openai import OpenAIProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "byo openai response"
        mock_choice.message.reasoning_content = None
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = OpenAIProvider()
        override_client = AsyncMock()
        override_client.chat.completions.create = AsyncMock(return_value=mock_completion)

        with patch("text.providers.openai.AsyncOpenAI", return_value=override_client) as mock_ctor:
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

    @pytest.mark.asyncio
    async def test_absent_connection_fails_closed(self):
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        with patch("text.providers.openai.AsyncOpenAI") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="openai", model="caller-model")
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(req)
        mock_ctor.assert_not_called()

    @pytest.mark.asyncio
    async def test_two_tenants_do_not_share_a_client(self):
        """A fresh request-scoped client is built per override — two tenants'
        concurrent requests can never reuse one client instance."""
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        with patch("text.providers.openai.AsyncOpenAI") as mock_ctor:
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

    def test_fail_closed_when_the_connection_cannot_build_a_client(self, caplog):
        """INVERTED from the original assertion, deliberately.

        This used to degrade to the shared env client — so a tenant whose key was
        revoked or malformed kept generating on the PLATFORM's OpenAI account
        while `funding` still said `tenant`. That is un-invoiced spend plus a
        silent cross-tier credential substitution. With no platform client to
        degrade onto, a broken tenant credential surfaces as an error the tenant
        can fix. The key must still never reach the log or the message.
        """
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()

        with patch(
            "text.providers.openai.AsyncOpenAI",
            side_effect=RuntimeError("bad key"),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="openai",
                provider_overrides={"openai": {"api_key": "byo-broken-openai-key"}},
            )
            with pytest.raises(ProviderCredentialsError) as exc:
                provider._client_for(req)

        assert "byo-broken-openai-key" not in caplog.text
        assert "byo-broken-openai-key" not in str(exc.value)


class TestAnthropicProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_credential(self):
        from text.providers.anthropic import AnthropicProvider

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "byo anthropic response"
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_message.stop_reason = "end_turn"
        mock_message.usage = MagicMock(input_tokens=3, output_tokens=4)

        provider = AnthropicProvider()
        override_client = MagicMock()
        override_client.messages.create = AsyncMock(return_value=mock_message)

        with patch(
            "text.providers.anthropic.AsyncAnthropic", return_value=override_client
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
    async def test_absent_connection_fails_closed(self):
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider()
        with patch("text.providers.anthropic.AsyncAnthropic") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="anthropic", model="caller-model")
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(req)
        mock_ctor.assert_not_called()

    def test_fail_closed_when_the_connection_cannot_build_a_client(self, caplog):
        """INVERTED — see `TestOpenAIProviderOverrideConsumption`."""
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider()

        with patch(
            "text.providers.anthropic.AsyncAnthropic",
            side_effect=RuntimeError("bad key"),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="anthropic",
                provider_overrides={"anthropic": {"api_key": "byo-broken-anthropic-key"}},
            )
            with pytest.raises(ProviderCredentialsError) as exc:
                provider._client_for(req)

        assert "byo-broken-anthropic-key" not in caplog.text
        assert "byo-broken-anthropic-key" not in str(exc.value)


class TestVertexProviderOverrideConsumption:
    @pytest.mark.asyncio
    async def test_override_builds_a_request_scoped_client_with_tenant_sa_key(self):
        from text.providers.vertex import VertexProvider

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

        provider = VertexProvider()
        sa_json = '{"type":"service_account","project_id":"tenant-proj"}'
        with (
            patch("text.providers.vertex.genai.Client", return_value=override_client) as mock_ctor,
            patch(
                "text.providers.vertex.service_account.Credentials.from_service_account_info",
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
    async def test_absent_connection_fails_closed(self):
        """No injected connection ⇒ raise, rather than build an
        ADC-authenticated client from the ambient process environment."""
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.vertex import VertexProvider

        provider = VertexProvider()
        with patch("text.providers.vertex.genai.Client") as mock_ctor:
            req = GenerateRequest(prompt="hi", provider="vertex", model="gemini-2.0-flash")
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(req)
        mock_ctor.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_connection_without_a_project_fails_closed(self):
        """A Vertex client is bound to a (project, location), so both travel with
        the service-account key rather than being process-wide values."""
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.vertex import VertexProvider

        provider = VertexProvider()
        with patch("text.providers.vertex.genai.Client") as mock_ctor:
            req = GenerateRequest(
                prompt="hi",
                provider="vertex",
                model="gemini-2.0-flash",
                provider_overrides={"vertex": {"api_key": '{"type":"service_account"}'}},
            )
            with pytest.raises(ProviderCredentialsError):
                await provider.generate(req)
        mock_ctor.assert_not_called()

    def test_fail_closed_when_override_build_raises(self, caplog):
        """F-07 — INVERTED from the original assertion, deliberately.

        This test used to assert `client is sentinel_env_client`: a tenant
        credential that could not be built fell through to the PLATFORM client
        while `funding` stayed `tenant`, so a revoked or malformed tenant key
        kept generating on the platform's Google account, billed as BYOK. That
        is un-invoiced COGS plus a cross-tier credential substitution, and it
        must raise. The key must still never reach the log or the message.
        """
        from text.core.exceptions import ProviderCredentialsError
        from text.providers.vertex import VertexProvider

        provider = VertexProvider()

        with patch(
            "text.providers.vertex.service_account.Credentials.from_service_account_info",
            side_effect=ValueError("bad sa json"),
        ):
            req = GenerateRequest(
                prompt="hi",
                provider="vertex",
                provider_overrides={
                    "vertex": {"api_key": "byo-broken-vertex-sa-key", "project": "p"}
                },
            )
            with pytest.raises(ProviderCredentialsError) as exc:
                provider._client_for(req)

        assert "byo-broken-vertex-sa-key" not in caplog.text
        assert "byo-broken-vertex-sa-key" not in str(exc.value)
