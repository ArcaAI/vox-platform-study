"""Retention propagation to server-managed engines.

SMR does not hold model weights: Ollama and LM Studio do. Retention therefore
propagates as a per-request hint rather than an in-process cache:

  * Ollama   — `keep_alive` in the generate payload overrides the server's
               `OLLAMA_KEEP_ALIVE` (default 5 min idle unload).
  * LM Studio — `ttl` (seconds) ferried through the OpenAI SDK's sanctioned
               `extra_body` escape hatch. ONLY for LM Studio: the openai-compat
               class is shared with vLLM and generic endpoints, which reject
               unknown body fields.

RED: written before the implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from smr.core.config import OllamaConfig, OpenAICompatConfig
from smr.models.requests import GenerateRequest


@pytest.fixture
def ollama_config():
    return OllamaConfig(base_url="http://localhost:11434", default_model="llama3.2:latest")


@pytest.fixture
def mock_http_client():
    return AsyncMock(spec=httpx.AsyncClient)


# ── Ollama: keep_alive ──────────────────────────────────────────────────────


class TestOllamaKeepAlive:
    def test_payload_carries_keep_alive_for_generate(self, ollama_config, mock_http_client):
        from smr.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        payload = provider._build_payload(GenerateRequest(prompt="hi", model="m"), stream=False)

        assert "keep_alive" in payload

    def test_payload_carries_keep_alive_for_stream(self, ollama_config, mock_http_client):
        """Both paths share `_build_payload`, so streaming must carry it too."""
        from smr.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        payload = provider._build_payload(GenerateRequest(prompt="hi", model="m"), stream=True)

        assert "keep_alive" in payload

    def test_keep_alive_uses_resolved_retention_ttl_in_seconds(
        self, ollama_config, mock_http_client
    ):
        """Ollama accepts a duration; we send integer seconds from the TTL."""
        from smr.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        provider.apply_retention({"ttl_seconds": 900})
        payload = provider._build_payload(GenerateRequest(prompt="hi", model="m"), stream=False)

        assert payload["keep_alive"] == "900s"

    def test_keep_alive_is_clamped_to_the_product_window(self, ollama_config, mock_http_client):
        from smr.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)

        provider.apply_retention({"ttl_seconds": 7200})
        assert (
            provider._build_payload(GenerateRequest(prompt="x", model="m"), stream=False)[
                "keep_alive"
            ]
            == "3600s"
        )

        provider.apply_retention({"ttl_seconds": 5})
        assert (
            provider._build_payload(GenerateRequest(prompt="x", model="m"), stream=False)[
                "keep_alive"
            ]
            == "60s"
        )

    def test_default_keep_alive_is_the_od5_default(self, ollama_config, mock_http_client):
        from smr.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        payload = provider._build_payload(GenerateRequest(prompt="hi", model="m"), stream=False)

        assert payload["keep_alive"] == "600s"


# ── LM Studio: extra_body.ttl ───────────────────────────────────────────────


def _compat_config() -> OpenAICompatConfig:
    return OpenAICompatConfig(base_url="http://localhost:1234/v1", default_model="m")


class TestLmStudioTtl:
    @pytest.mark.asyncio
    async def test_lm_studio_generate_sends_extra_body_ttl(self):
        from smr.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config(), provider_name="lm-studio")
        provider.apply_retention({"ttl_seconds": 900})

        create = AsyncMock(return_value=_completion())
        provider._client.chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="lm-studio"))

        assert create.await_args.kwargs["extra_body"] == {"ttl": 900}

    @pytest.mark.asyncio
    async def test_vllm_generate_does_not_send_extra_body(self):
        """vLLM/generic endpoints reject unknown body fields — never send it."""
        from smr.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config(), provider_name="vllm")
        provider.apply_retention({"ttl_seconds": 900})

        create = AsyncMock(return_value=_completion())
        provider._client.chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="vllm"))

        assert "extra_body" not in create.await_args.kwargs

    @pytest.mark.asyncio
    async def test_generic_openai_compat_does_not_send_extra_body(self):
        from smr.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config())

        create = AsyncMock(return_value=_completion())
        provider._client.chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m"))

        assert "extra_body" not in create.await_args.kwargs

    @pytest.mark.asyncio
    async def test_lm_studio_stream_sends_extra_body_ttl(self):
        from smr.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config(), provider_name="lm-studio")
        provider.apply_retention({"ttl_seconds": 300})

        async def _stream(*_args, **_kwargs):
            for chunk in [_finish_chunk()]:
                yield chunk

        create = AsyncMock(side_effect=lambda **kw: _stream(**kw))
        provider._client.chat.completions.create = create

        async for _ in provider.generate_stream(
            GenerateRequest(prompt="hi", model="m", provider="lm-studio")
        ):
            pass

        assert create.await_args.kwargs["extra_body"] == {"ttl": 300}

    def test_lm_studio_ttl_is_clamped(self):
        from smr.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config(), provider_name="lm-studio")
        provider.apply_retention({"ttl_seconds": 99999})
        assert provider._retention_ttl_s == 3600


def _completion() -> MagicMock:
    usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
    choice = MagicMock()
    choice.message.content = "ok"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


def _finish_chunk() -> MagicMock:
    chunk = MagicMock()
    choice = MagicMock()
    choice.delta.content = "ok"
    choice.delta.reasoning_content = None
    choice.delta.reasoning = None
    choice.finish_reason = "stop"
    chunk.choices = [choice]
    chunk.usage = None
    return chunk
