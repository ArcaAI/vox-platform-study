"""Granite client generation-stats capture.

Granite Guardian runs on its own LM Studio / Ollama endpoint (NOT SMR), so the
safety-screen client and the groundedness judge capture the equivalent native
fields (usage / finish reason / latency) into an AD-1-shaped ``last_stats`` dict
for Phase 2 trajectory ``GUARDRAIL`` / ``LLM_CALL`` steps. Capture is null-safe:
a response that omits usage must never throw. ``screen`` aggregates the token
counts across its per-dimension calls.

Hermetic via ``httpx.MockTransport`` (mirrors ``test_granite_client``).
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from harness.core.config import SafetyGuardConfig
from harness.sensors.inferential.granite_client import (
    GraniteGroundednessJudge,
    GraniteGuardianClient,
)


def _cfg(**overrides) -> SafetyGuardConfig:
    base: dict[str, Any] = {
        "enabled": True,
        "provider": "lm-studio",
        "base_url": "http://lmstudio:1234/v1",
        "model": "granite-test",
        "no_think": True,
        "timeout_s": 5.0,
        "harm_criteria": ["harm", "violence"],
    }
    base.update(overrides)
    return SafetyGuardConfig(**base)


def _openai_response(verdict: str, *, usage=None, finish_reason="stop") -> httpx.Response:
    choice: dict[str, Any] = {"message": {"role": "assistant", "content": f"<score>{verdict}</score>"}}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    body: dict[str, Any] = {"choices": [choice]}
    if usage is not None:
        body["usage"] = usage
    return httpx.Response(200, json=body)


class TestGuardianScreenStats:
    @pytest.mark.asyncio
    async def test_aggregates_usage_across_dimensions(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _openai_response(
                "no",
                usage={"prompt_tokens": 20, "completion_tokens": 2, "total_tokens": 22},
                finish_reason="stop",
            )

        client = GraniteGuardianClient(
            _cfg(harm_criteria=["harm", "violence"]), transport=httpx.MockTransport(handler)
        )
        await client.screen("patient note text")
        stats = client.last_stats
        assert stats is not None
        # 2 dimensions × (20 prompt, 2 predicted, 22 total).
        assert stats["prompt_tokens"] == 40
        assert stats["predicted_tokens"] == 4
        assert stats["total_tokens"] == 44
        assert stats["stop_reason"] == "stop"
        assert stats["provider"] == "lm-studio"
        assert stats["model"] == "granite-test"
        assert stats["total_ms"] >= 0

    @pytest.mark.asyncio
    async def test_null_safe_when_usage_absent(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _openai_response("no", usage=None, finish_reason=None)

        client = GraniteGuardianClient(
            _cfg(harm_criteria=["harm"]), transport=httpx.MockTransport(handler)
        )
        await client.screen("x")
        stats = client.last_stats
        assert stats is not None
        assert stats["prompt_tokens"] == 0
        assert stats["predicted_tokens"] == 0
        assert stats["provider"] == "lm-studio"

    @pytest.mark.asyncio
    async def test_no_stats_when_no_criteria(self):
        def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
            raise AssertionError("no HTTP call expected with empty harm_criteria")

        client = GraniteGuardianClient(
            _cfg(harm_criteria=[]), transport=httpx.MockTransport(handler)
        )
        await client.screen("x")
        assert client.last_stats is None


class TestGroundednessJudgeStats:
    @pytest.mark.asyncio
    async def test_captures_usage_on_complete(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _openai_response(
                "no",
                usage={"prompt_tokens": 50, "completion_tokens": 5, "total_tokens": 55},
                finish_reason="stop",
            )

        judge = GraniteGroundednessJudge(_cfg(), transport=httpx.MockTransport(handler))
        await judge.complete([{"role": "user", "content": "PREMISE:\nx\n\nHYPOTHESIS:\ny"}])
        stats = judge.last_stats
        assert stats is not None
        assert stats["prompt_tokens"] == 50
        assert stats["predicted_tokens"] == 5
        assert stats["total_tokens"] == 55
        assert stats["provider"] == "lm-studio"
        assert stats["model"] == "granite-test"
