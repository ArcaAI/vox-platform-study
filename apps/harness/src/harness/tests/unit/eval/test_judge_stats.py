"""Judge-client generation-stats capture.

The judge backends call their own LLM endpoints (LM Studio / vLLM / Azure /
Bedrock), NOT SMR, so they capture the equivalent native fields (usage / finish
reason / latency) into an AD-1-shaped ``last_stats`` dict for Phase 2 trajectory
``LLM_CALL`` steps. Capture is null-safe: a response that omits usage / finish
reason must never throw — counts fall back to zero and the stop reason to a
null-safe value.

These substitute the SDK's ``chat.completions.create`` / the Bedrock runtime with
fakes so they stay hermetic/offline.
"""

from __future__ import annotations

import types

import pytest

from harness.eval.config import JudgeConfig, JudgeProvider
from harness.eval.judge.providers import (
    AzureOpenAIJudgeClient,
    BedrockJudgeClient,
    OpenAICompatJudgeClient,
)


def _fake_create(captured: dict, *, content, finish_reason="stop", usage=None, model="judge-x"):
    async def create(**kwargs):  # noqa: ANN003
        captured.update(kwargs)
        message = types.SimpleNamespace(content=content)
        choice = types.SimpleNamespace(message=message, finish_reason=finish_reason)
        return types.SimpleNamespace(choices=[choice], usage=usage, model=model)

    return create


def _usage(prompt: int, completion: int, total: int | None = None):
    return types.SimpleNamespace(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total if total is not None else prompt + completion,
    )


def _azure() -> AzureOpenAIJudgeClient:
    cfg = JudgeConfig(provider=JudgeProvider.AZURE, model="gpt-4o")
    cfg.azure.endpoint = "https://example.openai.azure.com"
    cfg.azure.api_key = "secret"  # type: ignore[assignment]
    cfg.azure.deployment = "gpt-4o-judge"
    return AzureOpenAIJudgeClient(cfg)


class TestOpenAICompatStats:
    @pytest.mark.asyncio
    async def test_captures_usage_and_finish_reason(self):
        client = OpenAICompatJudgeClient(JudgeConfig())
        captured: dict = {}
        client._client.chat.completions.create = _fake_create(
            captured,
            content='{"x": 1}',
            finish_reason="length",
            usage=_usage(30, 10, 40),
            model="gemma",
        )
        await client.complete([{"role": "user", "content": "hi"}])
        stats = client.last_stats
        assert stats is not None
        assert stats["prompt_tokens"] == 30
        assert stats["predicted_tokens"] == 10
        assert stats["total_tokens"] == 40
        assert stats["stop_reason"] == "length"
        assert stats["stop_reason_raw"] == "length"
        assert stats["provider"] == "openai_compat"
        assert stats["model"] == "gemma"
        assert stats["total_ms"] >= 0

    @pytest.mark.asyncio
    async def test_stats_null_safe_when_usage_absent(self):
        client = OpenAICompatJudgeClient(JudgeConfig())
        captured: dict = {}
        # No usage / finish_reason on the response (older / minimal engine).
        client._client.chat.completions.create = _fake_create(
            captured,
            content='{"x": 1}',
            finish_reason=None,
            usage=None,
        )
        await client.complete([{"role": "user", "content": "hi"}])
        stats = client.last_stats
        assert stats is not None
        assert stats["prompt_tokens"] == 0
        assert stats["predicted_tokens"] == 0
        assert stats["total_tokens"] == 0
        assert stats["tokens_per_second"] is None
        assert stats["provider"] == "openai_compat"


class TestAzureStats:
    @pytest.mark.asyncio
    async def test_captures_content_filter_stop_reason(self):
        client = _azure()
        captured: dict = {}
        client._client.chat.completions.create = _fake_create(
            captured,
            content='{"x": 1}',
            finish_reason="content_filter",
            usage=_usage(12, 4, 16),
            model="gpt-4o",
        )
        await client.complete([{"role": "user", "content": "hi"}])
        stats = client.last_stats
        assert stats is not None
        assert stats["stop_reason"] == "content_filter"
        assert stats["prompt_tokens"] == 12
        assert stats["predicted_tokens"] == 4
        assert stats["provider"] == "azure"


class TestBedrockStats:
    @pytest.mark.asyncio
    async def test_captures_usage_and_stop_reason(self):
        client = BedrockJudgeClient(
            JudgeConfig(provider=JudgeProvider.BEDROCK, model="anthropic.x")
        )

        class _Runtime:
            def converse(self, **kwargs):  # noqa: ANN003
                return {
                    "output": {"message": {"content": [{"text": '{"x": 1}'}]}},
                    "usage": {"inputTokens": 12, "outputTokens": 3, "totalTokens": 15},
                    "stopReason": "max_tokens",
                }

        client._runtime = _Runtime()
        out = await client.complete([{"role": "user", "content": "hi"}])
        assert out == '{"x": 1}'
        stats = client.last_stats
        assert stats is not None
        assert stats["prompt_tokens"] == 12
        assert stats["predicted_tokens"] == 3
        assert stats["total_tokens"] == 15
        assert stats["stop_reason"] == "length"
        assert stats["stop_reason_raw"] == "max_tokens"
        assert stats["provider"] == "bedrock"
