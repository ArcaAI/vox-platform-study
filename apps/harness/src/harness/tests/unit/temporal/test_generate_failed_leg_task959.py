"""TASK-959 §6.2 Gap A + TASK-957 F-6 — the DURABLE lane's failed legs and zeroed counts.

Same two holes as the workflow lane (see
`interpreter/test_core_agent_failed_leg_task959.py`), on the `generate` activity
`HarnessDocWorkflow` and the consultation loop run:

* a candidate that raised recorded nothing — and when EVERY candidate raised, the activity
  raised too, having spent platform CPU on each of them, with not one step written;
* `usage_detail` never reached the `LLM_CALL` step, so the mapper's cache-read / cache-write /
  reasoning counts were hard zeros.

One deliberate difference from the workflow lane: no `trigger`. This lane's SUCCESSFUL step
carries none either (it is `harness.step`, not an invocation), and inventing one here would put
a value in the ledger that no other step on this lane agrees with.
"""

from __future__ import annotations

import dataclasses
import datetime
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.services.api_client import TrajectoryReportResponse
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal import activities
from harness.temporal.activities import FAILED_ATTEMPT_OFFSET_BASE
from harness.temporal.models import GenerateInput, TrajectoryContext

_TENANT = "11111111-1111-1111-1111-111111111111"
_SEQ = 16


def _candidate(provider: str, model: str, funding_tier: str | None) -> dict[str, Any]:
    return {
        "kind": "platform-default",
        "agent": {
            "slug": f"fallback-{provider}",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": "00000000-0000-0000-0000-000000000000",
            "source": "platform-default",
        },
        "modelSlug": f"slug-{model}",
        "provider": provider,
        "model": model,
        "parameters": {},
        "fundingTier": funding_tier,
    }


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        return TrajectoryReportResponse(accepted=len(steps))


class _Text:
    def __init__(
        self, failing: set[str], usage_detail: dict[str, Any] | None = None
    ) -> None:
        self.failing = failing
        self.usage_detail = usage_detail
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        if kwargs.get("provider") in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return TextGenerationResult(
            content="DRAFT",
            model=kwargs.get("model") or "",
            provider=kwargs.get("provider") or "",
            finish_reason="stop",
            stats={"provider": kwargs.get("provider"), "prompt_tokens": 11},
            usage_detail=self.usage_detail,
        )


@pytest.fixture
def env() -> ActivityEnvironment:
    environment = ActivityEnvironment()
    environment.info = dataclasses.replace(
        environment.info, start_to_close_timeout=datetime.timedelta(minutes=30)
    )
    return environment


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch):
    captured = _CapTraj()

    def _install(text: _Text) -> _CapTraj:
        monkeypatch.setattr(activities, "_text_client", lambda _s: text)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: captured)
        return captured

    return _install


def _input(**over: Any) -> GenerateInput:
    payload: dict[str, Any] = {
        "tenant_id": _TENANT,
        "prompt": "Write the SOAP note.",
        "provider": "azure-openai",
        "model": "gpt-5.4-mini",
        "trajectory": TrajectoryContext(tenant_id=_TENANT, consultation_id="c-1", seq=_SEQ),
    }
    payload.update(over)
    return GenerateInput(**payload)


def _steps(captured: _CapTraj) -> list[tuple[str, str, int, dict[str, Any] | None]]:
    return [(s.step_type, s.status, s.seq, s.stats) for s in captured.steps]


class TestAFailedLegIsRecorded:
    @pytest.mark.asyncio
    async def test_the_failed_primary_gets_its_own_error_step(self, env, wired) -> None:
        captured = wired(_Text(failing={"azure-openai"}))

        await env.run(
            activities.generate,
            _input(
                text_fallback={
                    "autoSwitch": True,
                    "chain": [_candidate("lm-studio", "gemma-4", "platform")],
                }
            ),
        )

        recorded = _steps(captured)
        assert [(s[0], s[1], s[2]) for s in recorded] == [
            ("LLM_CALL", "OK", _SEQ),
            ("LLM_CALL", "ERROR", _SEQ + FAILED_ATTEMPT_OFFSET_BASE),
        ]
        failed = recorded[1][3]
        assert failed["provider"] == "azure-openai"
        assert failed["model"] == "gpt-5.4-mini"
        assert failed["leg"] == "failed"
        assert isinstance(failed["total_ms"], int)
        # The snapshotted primary has no derived tier on this lane, so none is claimed …
        assert "funding_tier" not in failed
        # … and this lane's successful step stamps no trigger, so neither does its failed one.
        assert "trigger" not in failed
        assert "prompt_tokens" not in failed

    @pytest.mark.asyncio
    async def test_a_failed_fallback_names_the_tier_the_gateway_derived_for_it(
        self, env, wired
    ) -> None:
        captured = wired(_Text(failing={"azure-openai", "lm-studio"}))

        await env.run(
            activities.generate,
            _input(
                text_fallback={
                    "autoSwitch": True,
                    "chain": [
                        _candidate("lm-studio", "gemma-4", "platform"),
                        _candidate("vllm", "qwen-3", "tenant"),
                    ],
                }
            ),
        )

        failed = [s for s in _steps(captured) if s[1] == "ERROR"]
        assert [s[3]["provider"] for s in failed] == ["azure-openai", "lm-studio"]
        assert failed[1][3]["funding_tier"] == "platform"
        assert [s[2] for s in failed] == [
            _SEQ + FAILED_ATTEMPT_OFFSET_BASE,
            _SEQ + FAILED_ATTEMPT_OFFSET_BASE + 1,
        ]

    @pytest.mark.asyncio
    async def test_a_total_failure_records_every_leg_before_it_raises(self, env, wired) -> None:
        """The run still fails and no draft is persisted — but the CPU it spent is metered."""
        captured = wired(_Text(failing={"azure-openai", "lm-studio"}))

        with pytest.raises(TextServiceError):
            await env.run(
                activities.generate,
                _input(
                    text_fallback={
                        "autoSwitch": True,
                        "chain": [_candidate("lm-studio", "gemma-4", "platform")],
                    }
                ),
            )

        recorded = _steps(captured)
        assert [(s[0], s[1], s[2]) for s in recorded] == [
            ("LLM_CALL", "ERROR", _SEQ + FAILED_ATTEMPT_OFFSET_BASE),
            ("LLM_CALL", "ERROR", _SEQ + FAILED_ATTEMPT_OFFSET_BASE + 1),
        ]
        assert all(s[3]["leg"] == "failed" for s in recorded)

    @pytest.mark.asyncio
    async def test_a_generation_that_never_failed_records_only_its_own_step(
        self, env, wired
    ) -> None:
        captured = wired(_Text(failing=set()))

        await env.run(activities.generate, _input())

        assert [(s[0], s[1], s[2]) for s in _steps(captured)] == [("LLM_CALL", "OK", _SEQ)]

    @pytest.mark.asyncio
    async def test_the_failed_legs_never_displace_the_thinking_step(self, env, wired) -> None:
        """THINKING keeps offset 1; failed legs start at 2 — the two must not overlap."""
        text = _Text(failing={"azure-openai"})
        text.usage_detail = None
        captured = wired(text)

        original = TextGenerationResult(
            content="DRAFT",
            model="gemma-4",
            provider="lm-studio",
            finish_reason="stop",
            stats={"provider": "lm-studio", "reasoning_tokens": 42},
        )

        async def _generate(**kwargs: Any) -> TextGenerationResult:
            if kwargs.get("provider") in text.failing:
                raise TextServiceError("down")
            return original

        text.generate = _generate  # type: ignore[method-assign]

        await env.run(
            activities.generate,
            _input(
                text_fallback={
                    "autoSwitch": True,
                    "chain": [_candidate("lm-studio", "gemma-4", "platform")],
                }
            ),
        )

        by_seq = {s[2]: (s[0], s[1]) for s in _steps(captured)}
        assert by_seq[_SEQ] == ("LLM_CALL", "OK")
        assert by_seq[_SEQ + 1] == ("THINKING", "OK")
        assert by_seq[_SEQ + FAILED_ATTEMPT_OFFSET_BASE] == ("LLM_CALL", "ERROR")


class TestUsageDetailReachesTheStep:
    @pytest.mark.asyncio
    async def test_the_counts_ride_the_llm_call_step(self, env, wired) -> None:
        captured = wired(
            _Text(
                failing=set(),
                usage_detail={
                    "total_ms": 30412,
                    "engine_ms": 29800,
                    "request_bytes": 4096,
                    "response_bytes": 2048,
                    "raw": {
                        "prompt_tokens_details": {"cached_tokens": 300},
                        "completion_tokens_details": {"reasoning_tokens": 900},
                    },
                },
            )
        )

        await env.run(activities.generate, _input())

        [(_type, _status, _seq, stats)] = _steps(captured)
        assert stats["cache_read_tokens"] == 300
        assert stats["reasoning_tokens"] == 900
        assert stats["total_ms"] == 30412
        assert stats["engine_ms"] == 29800
        assert stats["request_bytes"] == 4096
        assert stats["response_bytes"] == 2048
        # F-19's own observability fields and the AD-1 block are untouched.
        assert stats["prompt_tokens"] == 11
        assert stats["prompt_chars"] > 0

    @pytest.mark.asyncio
    async def test_a_response_without_usage_detail_changes_nothing(self, env, wired) -> None:
        captured = wired(_Text(failing=set(), usage_detail=None))

        await env.run(activities.generate, _input())

        [(_type, _status, _seq, stats)] = _steps(captured)
        assert "reasoning_tokens" not in stats
        assert stats["prompt_tokens"] == 11

    def test_the_text_client_model_now_carries_it(self) -> None:
        """The field that made all of this invisible: `extra="ignore"` dropped it."""
        parsed = TextGenerationResult.model_validate(
            {
                "content": "x",
                "provider": "lm-studio",
                "model": "gemma-4",
                "usage_detail": {"task_id": "t-1", "total_ms": 5},
            }
        )
        assert parsed.usage_detail == {"task_id": "t-1", "total_ms": 5}
