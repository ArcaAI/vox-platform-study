"""TDD tests for E1.3-E1.5 — Provider payload building with defaults + response_format.

Tests verify that:
1. Providers use resolve_request_defaults() for None hyperparameters
2. Providers map response_format to their native APIs
3. Providers extract token usage from responses
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from smr.models.requests import GenerateRequest, ResponseFormat
from smr.tests.conftest import keyed

# ── Ollama Provider ──


class TestOllamaPayloadDefaults:
    """Ollama _build_payload should use resolved defaults for None values."""

    def _make_provider(self):
        from smr.core.config import OllamaConfig
        from smr.providers.ollama import OllamaProvider

        config = OllamaConfig(base_url="http://localhost:11434")
        http_client = MagicMock()
        return OllamaProvider(config, http_client)

    def test_none_hyperparams_get_defaults(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello")
        payload = provider._build_payload(req, stream=False)
        assert payload["options"]["temperature"] == 0.1
        assert payload["options"]["num_predict"] == 16_384
        assert payload["options"]["top_p"] == 0.95

    def test_explicit_hyperparams_preserved(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello", temperature=0.5, max_tokens=8000, top_p=0.8)
        payload = provider._build_payload(req, stream=False)
        assert payload["options"]["temperature"] == 0.5
        assert payload["options"]["num_predict"] == 8000
        assert payload["options"]["top_p"] == 0.8

    def test_zero_temperature_preserved(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello", temperature=0.0)
        payload = provider._build_payload(req, stream=False)
        assert payload["options"]["temperature"] == 0.0


class TestOllamaResponseFormat:
    """Ollama should map response_format to the `format` parameter."""

    def _make_provider(self):
        from smr.core.config import OllamaConfig
        from smr.providers.ollama import OllamaProvider

        config = OllamaConfig(base_url="http://localhost:11434")
        return OllamaProvider(config, MagicMock())

    def test_no_response_format_no_format_key(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello")
        payload = provider._build_payload(req, stream=False)
        assert "format" not in payload

    def test_json_mode_sets_format_json(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello", response_format=ResponseFormat(type="json"))
        payload = provider._build_payload(req, stream=False)
        assert payload["format"] == "json"

    def test_json_schema_mode_sets_format_to_schema(self):
        provider = self._make_provider()
        schema = {"type": "object", "properties": {"plan": {"type": "string"}}}
        req = GenerateRequest(
            prompt="hello",
            response_format=ResponseFormat(type="json_schema", json_schema=schema),
        )
        payload = provider._build_payload(req, stream=False)
        assert payload["format"] == schema

    def test_text_mode_no_format_key(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello", response_format=ResponseFormat(type="text"))
        payload = provider._build_payload(req, stream=False)
        assert "format" not in payload


class TestOllamaTokenUsage:
    """Ollama generate() should return content + token usage."""

    def _make_provider(self):
        from smr.core.config import OllamaConfig
        from smr.providers.ollama import OllamaProvider

        config = OllamaConfig(base_url="http://localhost:11434")
        mock_http = AsyncMock()
        return OllamaProvider(config, mock_http), mock_http

    @pytest.mark.asyncio
    async def test_generate_returns_tuple_with_usage(self):
        provider, mock_http = self._make_provider()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "response": "Hello!",
            "prompt_eval_count": 10,
            "eval_count": 20,
        }
        mock_resp.raise_for_status = MagicMock()
        mock_http.post = AsyncMock(return_value=mock_resp)

        content, _reasoning, stats = await provider.generate(GenerateRequest(prompt="hello"))
        assert content == "Hello!"
        assert stats.prompt_tokens == 10
        assert stats.predicted_tokens == 20
        assert stats.total_tokens == 30

    @pytest.mark.asyncio
    async def test_generate_handles_missing_usage_fields(self):
        provider, mock_http = self._make_provider()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"response": "Hi"}
        mock_resp.raise_for_status = MagicMock()
        mock_http.post = AsyncMock(return_value=mock_resp)

        content, _reasoning, stats = await provider.generate(GenerateRequest(prompt="hello"))
        assert content == "Hi"
        assert stats.prompt_tokens == 0
        assert stats.predicted_tokens == 0
        assert stats.total_tokens == 0


# ── Azure OpenAI Provider ──


class TestAzurePayloadDefaults:
    """Azure provider should use resolved defaults for None values."""

    def _make_provider(self):
        from smr.core.config import AzureOpenAIConfig
        from smr.providers.azure_openai import AzureOpenAIProvider

        config = keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                deployment_name="gpt-4",
            ),
            "test-key",
        )
        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        return provider

    @pytest.mark.asyncio
    async def test_none_hyperparams_get_defaults(self):
        provider = self._make_provider()
        mock_resp = MagicMock()
        mock_resp.choices = [MagicMock(message=MagicMock(content="Hi"), finish_reason="stop")]
        mock_resp.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)
        provider._client.chat.completions.create = AsyncMock(return_value=mock_resp)

        req = GenerateRequest(prompt="hello")
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args
        assert call_kwargs.kwargs["temperature"] == 0.1
        assert call_kwargs.kwargs["max_tokens"] == 16_384
        assert call_kwargs.kwargs["top_p"] == 0.95

    @pytest.mark.asyncio
    async def test_explicit_hyperparams_preserved(self):
        provider = self._make_provider()
        mock_resp = MagicMock()
        mock_resp.choices = [MagicMock(message=MagicMock(content="Hi"), finish_reason="stop")]
        mock_resp.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)
        provider._client.chat.completions.create = AsyncMock(return_value=mock_resp)

        req = GenerateRequest(prompt="hello", temperature=0.5, max_tokens=8000, top_p=0.8)
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args
        assert call_kwargs.kwargs["temperature"] == 0.5
        assert call_kwargs.kwargs["max_tokens"] == 8000
        assert call_kwargs.kwargs["top_p"] == 0.8


class TestAzureResponseFormat:
    """Azure should map response_format to the OpenAI response_format parameter."""

    def _make_provider(self):
        from smr.core.config import AzureOpenAIConfig
        from smr.providers.azure_openai import AzureOpenAIProvider

        config = keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                deployment_name="gpt-4",
            ),
            "test-key",
        )
        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        return provider

    @pytest.mark.asyncio
    async def test_json_schema_format_passed_to_api(self):
        provider = self._make_provider()
        schema = {
            "type": "object",
            "properties": {"plan": {"type": "string"}},
            "title": "ClinicalNote",
        }
        mock_resp = MagicMock()
        mock_resp.choices = [
            MagicMock(message=MagicMock(content='{"plan":"rest"}'), finish_reason="stop")
        ]
        mock_resp.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)
        provider._client.chat.completions.create = AsyncMock(return_value=mock_resp)

        req = GenerateRequest(
            prompt="hello",
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
        )
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert "response_format" in call_kwargs
        rf = call_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["schema"] == schema
        assert rf["json_schema"]["strict"] is True

    @pytest.mark.asyncio
    async def test_no_response_format_omits_param(self):
        provider = self._make_provider()
        mock_resp = MagicMock()
        mock_resp.choices = [MagicMock(message=MagicMock(content="Hi"), finish_reason="stop")]
        mock_resp.usage = MagicMock(prompt_tokens=5, completion_tokens=10, total_tokens=15)
        provider._client.chat.completions.create = AsyncMock(return_value=mock_resp)

        req = GenerateRequest(prompt="hello")
        await provider.generate(req)

        call_kwargs = provider._client.chat.completions.create.call_args.kwargs
        assert "response_format" not in call_kwargs


class TestAzureTokenUsage:
    """Azure generate() should return content + token usage."""

    def _make_provider(self):
        from smr.core.config import AzureOpenAIConfig
        from smr.providers.azure_openai import AzureOpenAIProvider

        config = keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                deployment_name="gpt-4",
            ),
            "test-key",
        )
        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        return provider

    @pytest.mark.asyncio
    async def test_generate_returns_tuple_with_usage(self):
        provider = self._make_provider()
        mock_resp = MagicMock()
        mock_resp.choices = [
            MagicMock(message=MagicMock(content="Summary here"), finish_reason="stop")
        ]
        mock_resp.usage = MagicMock(prompt_tokens=50, completion_tokens=100, total_tokens=150)
        provider._client.chat.completions.create = AsyncMock(return_value=mock_resp)

        content, _reasoning, stats = await provider.generate(GenerateRequest(prompt="hello"))
        assert content == "Summary here"
        assert stats.prompt_tokens == 50
        assert stats.predicted_tokens == 100
        assert stats.total_tokens == 150


# ── Bedrock Provider ──


class TestBedrockPayloadDefaults:
    """Bedrock _build_converse_params should use resolved defaults."""

    def _make_provider(self):
        from smr.core.config import BedrockConfig
        from smr.providers.bedrock import BedrockProvider

        config = BedrockConfig(region="us-east-1")
        with patch("boto3.client"):
            return BedrockProvider(config)

    def test_none_hyperparams_get_defaults(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello")
        params = provider._build_converse_params(req)
        assert params["inferenceConfig"]["temperature"] == 0.1
        assert params["inferenceConfig"]["maxTokens"] == 16_384
        assert params["inferenceConfig"]["topP"] == 0.95

    def test_explicit_hyperparams_preserved(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello", temperature=0.5, max_tokens=8000, top_p=0.8)
        params = provider._build_converse_params(req)
        assert params["inferenceConfig"]["temperature"] == 0.5
        assert params["inferenceConfig"]["maxTokens"] == 8000
        assert params["inferenceConfig"]["topP"] == 0.8


class TestBedrockResponseFormat:
    """Bedrock should map response_format to toolConfig with JSON schema."""

    def _make_provider(self):
        from smr.core.config import BedrockConfig
        from smr.providers.bedrock import BedrockProvider

        config = BedrockConfig(region="us-east-1")
        with patch("boto3.client"):
            return BedrockProvider(config)

    def test_no_response_format_no_tool_config(self):
        provider = self._make_provider()
        req = GenerateRequest(prompt="hello")
        params = provider._build_converse_params(req)
        assert "toolConfig" not in params

    def test_json_schema_adds_tool_config(self):
        provider = self._make_provider()
        schema = {
            "type": "object",
            "properties": {"plan": {"type": "string"}},
            "title": "ClinicalNote",
        }
        req = GenerateRequest(
            prompt="hello",
            response_format=ResponseFormat(type="json_schema", json_schema=schema),
        )
        params = provider._build_converse_params(req)
        assert "toolConfig" in params
        tool = params["toolConfig"]["tools"][0]["toolSpec"]
        assert tool["name"] == "ClinicalNote"
        assert tool["inputSchema"]["json"] == schema


class TestBedrockTokenUsage:
    """Bedrock generate() should return content + token usage."""

    def _make_provider(self):
        from smr.core.config import BedrockConfig
        from smr.providers.bedrock import BedrockProvider

        config = BedrockConfig(region="us-east-1")
        with patch("boto3.client"):
            provider = BedrockProvider(config)
        provider._client = MagicMock()
        return provider

    @pytest.mark.asyncio
    async def test_generate_returns_tuple_with_usage(self):
        provider = self._make_provider()
        provider._client.converse.return_value = {
            "output": {"message": {"content": [{"text": "Summary"}]}},
            "usage": {"inputTokens": 25, "outputTokens": 50},
        }

        content, _reasoning, stats = await provider.generate(
            GenerateRequest(prompt="hello", model="anthropic.claude-3-5-haiku-20241022-v1:0")
        )
        assert content == "Summary"
        assert stats.prompt_tokens == 25
        assert stats.predicted_tokens == 50
        assert stats.total_tokens == 75

    @pytest.mark.asyncio
    async def test_generate_handles_missing_usage(self):
        provider = self._make_provider()
        provider._client.converse.return_value = {
            "output": {"message": {"content": [{"text": "Hi"}]}},
        }

        content, _reasoning, stats = await provider.generate(
            GenerateRequest(prompt="hello", model="anthropic.claude-3-5-haiku-20241022-v1:0")
        )
        assert content == "Hi"
        assert stats.prompt_tokens == 0
        assert stats.predicted_tokens == 0
