"""TDD tests for vision capability (RED — written before implementation).

Verifies:
  1. ``GenerateRequest`` gains an ADDITIVE ``content_parts`` union; every
     existing text-only request builds the EXACT same wire payload as before
     (regression, written against current pre-implementation code shape).
  2. An image part reaches each adapter in that provider's native shape.
  3. ``llama_cpp`` rejects an image request with a clear typed error instead
     of silently dropping it.
  4. ``supports_vision`` is reported correctly per provider via ``get_info``.
"""

from __future__ import annotations

import base64
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.models.requests import GenerateRequest
from text.tests.conftest import keyed

_PNG_B64 = base64.b64encode(b"fake-png-bytes").decode("ascii")


def _image_request(**overrides: Any) -> GenerateRequest:
    payload: dict[str, Any] = {
        "prompt": "Describe this image",
        "model": "caller-model",
        "content_parts": [
            {"type": "image", "data": _PNG_B64, "media_type": "image/png"},
        ],
    }
    payload.update(overrides)
    return GenerateRequest(**payload)


def _text_request(**overrides: Any) -> GenerateRequest:
    payload: dict[str, Any] = {"prompt": "hello", "model": "caller-model"}
    payload.update(overrides)
    return GenerateRequest(**payload)


# ---------------------------------------------------------------------------
# 1. GenerateRequest — additive content_parts model
# ---------------------------------------------------------------------------


class TestContentPartsModel:
    def test_generate_request_defaults_to_no_content_parts(self):
        req = _text_request()
        assert req.content_parts is None

    def test_image_parts_empty_when_absent(self):
        req = _text_request()
        assert req.image_parts() == []

    def test_generate_request_accepts_an_image_part(self):
        req = _image_request()
        assert req.content_parts is not None
        assert len(req.content_parts) == 1

    def test_image_parts_returns_the_image_part(self):
        req = _image_request()
        parts = req.image_parts()
        assert len(parts) == 1
        assert parts[0].data == _PNG_B64
        assert parts[0].media_type == "image/png"

    def test_text_part_is_not_returned_by_image_parts(self):
        req = _text_request(
            content_parts=[
                {"type": "text", "text": "extra context"},
                {"type": "image", "data": _PNG_B64, "media_type": "image/jpeg"},
            ]
        )
        parts = req.image_parts()
        assert len(parts) == 1
        assert parts[0].media_type == "image/jpeg"

    def test_image_media_type_must_be_image_mime(self):
        with pytest.raises(ValueError, match="image/"):
            GenerateRequest(
                prompt="hi",
                content_parts=[{"type": "image", "data": _PNG_B64, "media_type": "text/plain"}],
            )

    def test_image_part_defaults_media_type_to_png(self):
        req = _text_request(content_parts=[{"type": "image", "data": _PNG_B64}])
        assert req.image_parts()[0].media_type == "image/png"


# ---------------------------------------------------------------------------
# 2. Byte-identical regression — every adapter's builder is unchanged when
#    content_parts is absent. These fixtures mirror the exact assertions the
#    existing per-provider test suites already make (test_openai_compat_
#    provider.py, test_provider_contract.py, etc.) and are the RED anchor:
#    run against pre-implementation code, `_build_messages`/`image_parts`
#    already exist would fail; after implementation they must keep passing.
# ---------------------------------------------------------------------------


class TestTextOnlyRegression:
    def test_openai_compat_messages_unchanged(self):
        from text.core.config import OpenAICompatConfig
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(OpenAICompatConfig(default_model="m"))
        messages = provider._build_messages(_text_request(system_prompt="sys"))
        assert messages == [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ]

    def test_azure_messages_unchanged(self):
        from text.core.config import AzureOpenAIConfig
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(
            keyed(AzureOpenAIConfig(endpoint="https://test.openai.azure.com", default_model="m"), "k")
        )
        messages = provider._build_messages(_text_request())
        assert messages == [{"role": "user", "content": "hello"}]

    def test_openai_messages_unchanged(self):
        from text.core.config import OpenAIConfig
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider(keyed(OpenAIConfig(default_model="m"), "k"))
        messages = provider._build_messages(_text_request())
        assert messages == [{"role": "user", "content": "hello"}]

    def test_anthropic_kwargs_content_stays_a_bare_string(self):
        from text.core.config import AnthropicConfig
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider(keyed(AnthropicConfig(), "k"))
        kwargs = provider._build_create_kwargs(_text_request())
        assert kwargs["messages"] == [{"role": "user", "content": "hello"}]

    def test_bedrock_params_content_stays_the_single_text_block(self):
        from text.core.config import BedrockConfig
        from text.providers.bedrock import BedrockProvider

        with patch("boto3.client"):
            provider = BedrockProvider(BedrockConfig(region="us-east-1", default_model="m"))
        params = provider._build_converse_params(_text_request())
        assert params["messages"] == [{"role": "user", "content": [{"text": "hello"}]}]

    def test_ollama_payload_has_no_images_key(self):
        from text.core.config import OllamaConfig
        from text.providers.ollama import OllamaProvider

        provider = OllamaProvider(
            OllamaConfig(base_url="http://localhost:11434", default_model="m"), AsyncMock()
        )
        payload = provider._build_payload(_text_request(), stream=False)
        assert "images" not in payload
        assert payload["prompt"] == "hello"

    def test_llama_cpp_does_not_raise_for_a_text_only_request(self):
        from text.core.config import LlamaCppConfig
        from text.providers.llama_cpp import LlamaCppProvider

        provider = LlamaCppProvider(
            LlamaCppConfig(base_url="http://localhost:8080", default_model="m"), AsyncMock()
        )
        payload = provider._build_payload(_text_request(), stream=False)
        assert payload["prompt"] == "hello"


# ---------------------------------------------------------------------------
# 3. Image part reaches each adapter in its native wire shape
# ---------------------------------------------------------------------------


class TestImageReachesEachAdapter:
    def test_openai_compat_builds_content_parts_array(self):
        from text.core.config import OpenAICompatConfig
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(OpenAICompatConfig(default_model="m"))
        messages = provider._build_messages(_image_request())
        user_msg = messages[-1]
        assert user_msg["role"] == "user"
        content = user_msg["content"]
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "Describe this image"}
        assert content[1]["type"] == "image_url"
        assert content[1]["image_url"]["url"] == f"data:image/png;base64,{_PNG_B64}"

    def test_azure_builds_content_parts_array(self):
        from text.core.config import AzureOpenAIConfig
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(
            keyed(AzureOpenAIConfig(endpoint="https://test.openai.azure.com", default_model="m"), "k")
        )
        messages = provider._build_messages(_image_request())
        content = messages[-1]["content"]
        assert content[1]["image_url"]["url"] == f"data:image/png;base64,{_PNG_B64}"

    def test_openai_builds_content_parts_array(self):
        from text.core.config import OpenAIConfig
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider(keyed(OpenAIConfig(default_model="m"), "k"))
        messages = provider._build_messages(_image_request())
        content = messages[-1]["content"]
        assert content[1]["image_url"]["url"] == f"data:image/png;base64,{_PNG_B64}"

    def test_anthropic_builds_image_and_text_blocks(self):
        from text.core.config import AnthropicConfig
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider(keyed(AnthropicConfig(), "k"))
        kwargs = provider._build_create_kwargs(_image_request())
        content = kwargs["messages"][0]["content"]
        assert isinstance(content, list)
        image_block = next(b for b in content if b["type"] == "image")
        assert image_block["source"] == {
            "type": "base64",
            "media_type": "image/png",
            "data": _PNG_B64,
        }
        text_block = next(b for b in content if b["type"] == "text")
        assert text_block["text"] == "Describe this image"

    def test_bedrock_builds_image_block_with_decoded_bytes(self):
        from text.core.config import BedrockConfig
        from text.providers.bedrock import BedrockProvider

        with patch("boto3.client"):
            provider = BedrockProvider(BedrockConfig(region="us-east-1", default_model="m"))
        params = provider._build_converse_params(_image_request())
        content = params["messages"][0]["content"]
        image_block = next(b for b in content if "image" in b)
        assert image_block["image"]["format"] == "png"
        assert image_block["image"]["source"]["bytes"] == base64.b64decode(_PNG_B64)

    def test_bedrock_rejects_an_unsupported_image_media_type(self):
        from text.core.config import BedrockConfig
        from text.providers.bedrock import BedrockProvider

        with patch("boto3.client"):
            provider = BedrockProvider(BedrockConfig(region="us-east-1", default_model="m"))
        req = _image_request(
            content_parts=[{"type": "image", "data": _PNG_B64, "media_type": "image/tiff"}]
        )
        with pytest.raises(Exception, match="image/tiff"):
            provider._build_converse_params(req)

    def test_ollama_populates_images_key_with_bare_base64(self):
        from text.core.config import OllamaConfig
        from text.providers.ollama import OllamaProvider

        provider = OllamaProvider(
            OllamaConfig(base_url="http://localhost:11434", default_model="m"), AsyncMock()
        )
        payload = provider._build_payload(_image_request(), stream=False)
        assert payload["images"] == [_PNG_B64]

    def test_vertex_builds_a_parts_list_with_from_bytes_image(self):
        from text.core.config import VertexConfig
        from text.providers.vertex import VertexProvider

        provider = VertexProvider(VertexConfig(project="proj"))
        contents = provider._build_contents(_image_request())
        assert isinstance(contents, list)
        assert contents[-1] == "Describe this image"
        # the image part was built via types.Part.from_bytes — assert on the
        # decoded bytes / mime type it carries rather than the SDK's internal
        # representation.
        image_part = contents[0]
        assert image_part.inline_data.mime_type == "image/png"
        assert image_part.inline_data.data == base64.b64decode(_PNG_B64)

    def test_vertex_contents_stays_bare_prompt_when_no_image(self):
        from text.core.config import VertexConfig
        from text.providers.vertex import VertexProvider

        provider = VertexProvider(VertexConfig(project="proj"))
        assert provider._build_contents(_text_request()) == "hello"

    def test_vllm_inherits_openai_compat_content_parts(self):
        from text.core.config import VllmConfig
        from text.providers.vllm import VllmProvider

        provider = VllmProvider(VllmConfig(default_model="m"))
        messages = provider._build_messages(_image_request())
        content = messages[-1]["content"]
        assert content[1]["image_url"]["url"] == f"data:image/png;base64,{_PNG_B64}"


# ---------------------------------------------------------------------------
# 4. llama.cpp rejects vision — clear typed error, not a silent drop
# ---------------------------------------------------------------------------


class TestLlamaCppRejectsVision:
    @pytest.mark.asyncio
    async def test_generate_raises_vision_not_supported_error(self):
        from text.core.config import LlamaCppConfig
        from text.core.exceptions import VisionNotSupportedError
        from text.providers.llama_cpp import LlamaCppProvider

        provider = LlamaCppProvider(
            LlamaCppConfig(base_url="http://localhost:8080", default_model="m"), AsyncMock()
        )
        with pytest.raises(VisionNotSupportedError):
            await provider.generate(_image_request())

    @pytest.mark.asyncio
    async def test_generate_stream_raises_vision_not_supported_error(self):
        from text.core.config import LlamaCppConfig
        from text.core.exceptions import VisionNotSupportedError
        from text.providers.llama_cpp import LlamaCppProvider

        provider = LlamaCppProvider(
            LlamaCppConfig(base_url="http://localhost:8080", default_model="m"), AsyncMock()
        )
        with pytest.raises(VisionNotSupportedError):
            async for _ in provider.generate_stream(_image_request()):
                pass

    def test_vision_not_supported_error_maps_to_422(self):
        from text.core.exception_handlers import _get_status_code
        from text.core.exceptions import VisionNotSupportedError

        exc = VisionNotSupportedError("no vision", provider="llama-cpp")
        assert _get_status_code(exc) == 422

    @pytest.mark.asyncio
    async def test_llama_cpp_http_client_never_called_for_an_image_request(self):
        from text.core.config import LlamaCppConfig
        from text.core.exceptions import VisionNotSupportedError
        from text.providers.llama_cpp import LlamaCppProvider

        http = AsyncMock()
        provider = LlamaCppProvider(
            LlamaCppConfig(base_url="http://localhost:8080", default_model="m"), http
        )
        with pytest.raises(VisionNotSupportedError):
            await provider.generate(_image_request())
        http.post.assert_not_called()


# ---------------------------------------------------------------------------
# 5. supports_vision reported correctly per provider
# ---------------------------------------------------------------------------


class TestSupportsVisionPerProvider:
    @pytest.mark.asyncio
    async def test_openai_compat_supports_vision(self):
        from text.core.config import OpenAICompatConfig
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(OpenAICompatConfig(default_model="m"))
        provider._client = MagicMock()
        provider._client.models.list = AsyncMock(return_value=MagicMock(data=[]))
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_vllm_supports_vision(self):
        from text.core.config import VllmConfig
        from text.providers.vllm import VllmProvider

        provider = VllmProvider(VllmConfig(default_model="m"))
        provider._client = MagicMock()
        provider._client.models.list = AsyncMock(return_value=MagicMock(data=[]))
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_azure_supports_vision(self):
        from text.core.config import AzureOpenAIConfig
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider(
            keyed(AzureOpenAIConfig(endpoint="https://test.openai.azure.com", default_model="m"), "k")
        )
        provider._client.models.list = AsyncMock()
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_openai_supports_vision(self):
        from text.core.config import OpenAIConfig
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider(keyed(OpenAIConfig(default_model="m"), "k"))
        provider._client.models.list = AsyncMock(return_value=MagicMock(data=[]))
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_anthropic_supports_vision(self):
        from text.core.config import AnthropicConfig
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider(keyed(AnthropicConfig(), "k"))
        provider._client.models.list = AsyncMock(return_value=MagicMock(data=[]))
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_bedrock_supports_vision(self):
        from text.core.config import BedrockConfig
        from text.providers.bedrock import BedrockProvider

        with patch("boto3.client"):
            provider = BedrockProvider(BedrockConfig(region="us-east-1", default_model="m"))
        provider._mgmt_client = MagicMock()
        provider._mgmt_client.list_foundation_models = MagicMock(return_value={"modelSummaries": []})
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_vertex_supports_vision(self):
        from text.core.config import VertexConfig
        from text.providers.vertex import VertexProvider

        provider = VertexProvider(VertexConfig(project="proj"))
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_ollama_supports_vision(self):
        from text.core.config import OllamaConfig
        from text.providers.ollama import OllamaProvider

        http = AsyncMock()
        http.get = AsyncMock(return_value=MagicMock(status_code=200, json=lambda: {"models": []}))
        provider = OllamaProvider(OllamaConfig(base_url="http://localhost:11434", default_model="m"), http)
        info = await provider.get_info()
        assert info.supports_vision is True

    @pytest.mark.asyncio
    async def test_llama_cpp_does_not_support_vision(self):
        from text.core.config import LlamaCppConfig
        from text.providers.llama_cpp import LlamaCppProvider

        http = AsyncMock()
        http.get = AsyncMock(return_value=MagicMock(status_code=200))
        provider = LlamaCppProvider(
            LlamaCppConfig(base_url="http://localhost:8080", default_model="m"), http
        )
        info = await provider.get_info()
        assert info.supports_vision is False
