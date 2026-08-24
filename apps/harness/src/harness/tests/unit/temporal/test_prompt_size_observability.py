"""F-19 / F-35 — prompt-size and prompt-cache observability on ``generate``.

The harness re-sends the ENTIRE template+transcript prefix on every regen
iteration and never compacts or truncates it (a deliberate single-shot design:
clinical content must never be silently dropped). What was missing is the
*observability*: nothing recorded how big the assembled prompt actually was, and
nothing surfaced whether the backend's prompt cache was hit.

So this is measure-only:

* the ``LLM_CALL`` trajectory step carries ``prompt_chars`` +
  ``prompt_tokens_est`` (chars // 4) for the FULLY assembled prompt actually
  dispatched (user prompt incl. RAG / segment-citation / regen-feedback blocks,
  plus the system prompt);
* an oversized prompt emits a structured ``harness.prompt_size_warn`` WARNING
  above ``HARNESS_PROMPT_SIZE_WARN_CHARS`` — and still generates. Nothing is
  ever truncated;
* whatever cache-related keys the Text backend reports in its generation stats
  (``cached_tokens``, ``prompt_cache_hit_tokens`` in ``engine_native``, …)
  survive the passthrough into the persisted trajectory step verbatim, so
  cache-hit rate is derivable from trajectory rollups.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.services.api_client import TrajectoryReportResponse
from harness.services.text_client import TextGenerationResult
from harness.temporal import activities
from harness.temporal.models import GenerateInput, TrajectoryContext


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        return TrajectoryReportResponse(accepted=len(steps))


class _StatsText:
    """Text double that records the dispatched prompt and returns fixed stats."""

    def __init__(self, stats: dict[str, Any] | None = None) -> None:
        self.stats = stats
        self.kwargs: dict[str, Any] = {}

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.kwargs = kwargs
        return TextGenerationResult(
            content="DRAFT", model="m", finish_reason="stop", stats=self.stats
        )


def _traj(seq: int = 0) -> TrajectoryContext:
    return TrajectoryContext(tenant_id="t-1", consultation_id="c-1", seq=seq)


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _llm_step(cap: _CapTraj):
    return next(s for s in cap.steps if s.step_type == "LLM_CALL")


class TestPromptSizeStats:
    @pytest.mark.asyncio
    async def test_llm_call_step_carries_prompt_size(self, env, monkeypatch):
        cap = _CapTraj()
        text_client = _StatsText(stats={"prompt_tokens": 25, "total_tokens": 37})
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111",
                prompt="U" * 400,
                system_prompt="S" * 100,
                trajectory=_traj(7),
            ),
        )

        step = _llm_step(cap)
        # The size measured is the prompt ACTUALLY dispatched (user + system).
        assert step.stats["prompt_chars"] == 500
        assert step.stats["prompt_tokens_est"] == 125
        # The backend's own stats are still there, untouched.
        assert step.stats["prompt_tokens"] == 25
        assert step.stats["total_tokens"] == 37

    @pytest.mark.asyncio
    async def test_prompt_size_counts_the_appended_blocks(self, env, monkeypatch):
        """The measured size is post-assembly, not the bare template prefix."""
        cap = _CapTraj()
        text_client = _StatsText()
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        block = "KNOWLEDGE CONTEXT BLOCK"
        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111",
                prompt="U" * 100,
                prompt_block=block,
                trajectory=_traj(),
            ),
        )

        step = _llm_step(cap)
        dispatched = text_client.kwargs["prompt"]
        assert block in dispatched
        assert step.stats["prompt_chars"] == len(dispatched)
        assert step.stats["prompt_chars"] > 100

    @pytest.mark.asyncio
    async def test_stats_absent_from_backend_still_carries_prompt_size(self, env, monkeypatch):
        """A legacy Text response without ``stats`` must not lose the size fields."""
        cap = _CapTraj()
        monkeypatch.setattr(activities, "_text_client", lambda s: _StatsText(stats=None))
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111",
                prompt="P" * 12,
                trajectory=_traj(),
            ),
        )

        step = _llm_step(cap)
        assert step.stats["prompt_chars"] == 12
        assert step.stats["prompt_tokens_est"] == 3


class TestPromptSizeWarning:
    @pytest.mark.asyncio
    async def test_warns_above_threshold_and_still_generates(self, env, monkeypatch, caplog):
        cap = _CapTraj()
        text_client = _StatsText()
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(prompt_size_warn_chars=50))
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        with caplog.at_level(logging.WARNING):
            result = await env.run(
                activities.generate,
                GenerateInput(
                    tenant_id="11111111-1111-1111-1111-111111111111",
                    prompt="X" * 120,
                    trajectory=_traj(),
                ),
            )

        assert any("harness.prompt_size_warn" in r.getMessage() for r in caplog.records)
        # Observe-only: the full prompt is still dispatched and the draft returned.
        assert text_client.kwargs["prompt"] == "X" * 120
        assert result.content == "DRAFT"

    @pytest.mark.asyncio
    async def test_silent_below_threshold(self, env, monkeypatch, caplog):
        cap = _CapTraj()
        monkeypatch.setattr(
            activities, "get_settings", lambda: Settings(prompt_size_warn_chars=1000)
        )
        monkeypatch.setattr(activities, "_text_client", lambda s: _StatsText())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        with caplog.at_level(logging.WARNING):
            await env.run(
                activities.generate,
                GenerateInput(
                    tenant_id="11111111-1111-1111-1111-111111111111",
                    prompt="X" * 120,
                    trajectory=_traj(),
                ),
            )

        assert not any("harness.prompt_size_warn" in r.getMessage() for r in caplog.records)

    def test_default_threshold_is_100k_tokens_worth_of_chars(self):
        assert Settings().prompt_size_warn_chars == 400_000


class TestPromptCacheStatsPassthrough:
    @pytest.mark.asyncio
    async def test_cache_keys_survive_into_the_trajectory_step(self, env, monkeypatch):
        """F-35 — nothing between Text and the persisted step filters stats keys."""
        stats = {
            "stop_reason": "stop",
            "prompt_tokens": 12_000,
            "total_tokens": 12_400,
            # Normalized cache counters some backends surface directly …
            "cached_tokens": 11_800,
            "prompt_cache_hit_tokens": 11_800,
            # … and the engine-native blob everything else lands in.
            "engine_native": {"tokens_cached": 11_800, "prompt_cache_key": "abc"},
        }
        cap = _CapTraj()
        monkeypatch.setattr(activities, "_text_client", lambda s: _StatsText(stats=stats))
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111", prompt="P", trajectory=_traj()
            ),
        )

        step = _llm_step(cap)
        for key, value in stats.items():
            assert step.stats[key] == value
