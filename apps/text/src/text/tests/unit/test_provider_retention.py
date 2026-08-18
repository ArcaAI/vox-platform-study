"""Retention propagation to server-managed engines.

Text does not hold model weights: the engines it talks to do. Retention
therefore propagates as a per-request hint rather than an in-process cache:

  * LM Studio — `ttl` (seconds) ferried through the OpenAI SDK's sanctioned
               `extra_body` escape hatch. ONLY for LM Studio: the openai-compat
               class is shared with vLLM and generic endpoints, which reject
               unknown body fields.

RED: written before the implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from text.core.config import OpenAICompatConfig
from text.models.requests import GenerateRequest

# ── LM Studio: extra_body.ttl ───────────────────────────────────────────────


def _compat_config() -> OpenAICompatConfig:
    return OpenAICompatConfig(base_url="http://localhost:1234/v1", default_model="m")


class TestLmStudioTtl:
    @pytest.mark.asyncio
    async def test_lm_studio_generate_sends_extra_body_ttl(self):
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config(), provider_name="lm-studio")
        provider.apply_retention({"ttl_seconds": 900})

        create = AsyncMock(return_value=_completion())
        provider._client.chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="lm-studio"))

        assert create.await_args.kwargs["extra_body"] == {"ttl": 900}

    @pytest.mark.asyncio
    async def test_vllm_generate_does_not_send_extra_body(self):
        """vLLM/generic endpoints reject unknown body fields — never send it."""
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config(), provider_name="vllm")
        provider.apply_retention({"ttl_seconds": 900})

        create = AsyncMock(return_value=_completion())
        provider._client.chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="vllm"))

        assert "extra_body" not in create.await_args.kwargs

    @pytest.mark.asyncio
    async def test_generic_openai_compat_does_not_send_extra_body(self):
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(_compat_config())

        create = AsyncMock(return_value=_completion())
        provider._client.chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m"))

        assert "extra_body" not in create.await_args.kwargs

    @pytest.mark.asyncio
    async def test_lm_studio_stream_sends_extra_body_ttl(self):
        from text.providers.openai_compat import OpenAICompatProvider

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
        from text.providers.openai_compat import OpenAICompatProvider

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
