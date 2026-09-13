"""TASK-959 §6.2 Gap A + TASK-957 F-6 — the legs that LOST, and the counts that were zeroed.

Two holes in what a `core.agent` generation reports, both of them silent:

* **A failed fallback attempt recorded nothing.** The walk did `last_error = exc; continue`
  with no timer around the attempt, so a BYOK candidate that raised cost the platform CPU time
  and network bytes, cost the tenant nothing, and left no trace in the ledger or the trajectory.
  The owner's measurement model counts both ("CPU time used calling the provider").
* **`usage_detail` never reached the step.** Text returns the cache/reasoning split and its own
  timing on the SAME response; `TextGenerationResult` dropped it (`extra="ignore"`), so
  `harness-usage.mapper.ts` set `cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0`
  and reasoning-model spend inside a workflow was structurally unbillable.

The seq arithmetic is the load-bearing part of the first fix and is pinned here: `seq` is
workflow-owned (a workflow body may not read a clock), so a failed attempt offsets inside the
node's own strided base. If that offset ever exceeded the stride, one node's step would land on
the next node's base and a colliding `harness:step:<sessionId>:<runId>:<seq>` would silently
replace a different node's step.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from harness.services.text_client import TextServiceError, usage_detail_counters
from harness.temporal import activities as activities_mod
from harness.temporal import workflows as doc_workflows
from harness.temporal.activities import (
    FAILED_ATTEMPT_OFFSET_BASE,
    MAX_FAILED_ATTEMPT_STEPS,
)
from harness.temporal.interpreter import workflow as interpreter_workflow
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM = "00000000-0000-0000-0000-000000000000"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_STARTED = datetime(2026, 9, 12, tzinfo=UTC)


def _candidate(provider: str, model: str, funding_tier: str | None) -> dict[str, Any]:
    return {
        "kind": "platform-default",
        "agent": {
            "slug": f"fallback-{provider}",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": _SYSTEM,
            "source": "platform-default",
        },
        "modelSlug": f"slug-{model}",
        "provider": provider,
        "model": model,
        "resolvedPrompt": {"source": "inline", "content": "Summarise."},
        "instruction": {"systemPrompt": "Summarise."},
        "parameters": {},
        "tools": [],
        "fundingTier": funding_tier,
    }


def _wire(chain: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "clinic-summarizer",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {
                "id": "m-1",
                "slug": "az-gpt",
                "provider": "azure",
                "taskType": "TEXT_GENERATION",
            },
            "fallbacks": [],
            "instruction": {"systemPrompt": "Summarise."},
            "resolvedPrompt": {"source": "inline", "content": "Summarise."},
            "parameters": {},
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "slug": "az-gpt",
                "sourceUri": "gpt-5.4-mini",
                "format": "CLOUD",
                "provider": "azure",
                "tenantId": _TENANT,
            }
        ],
        "textPrimary": {
            **_candidate("azure-openai", "gpt-5.4-mini", "tenant"),
            "kind": "primary",
            "agent": {
                "slug": "clinic-summarizer",
                "versionId": "agent-1",
                "versionNumber": 3,
                "tenantId": _TENANT,
                "source": "tenant",
            },
        },
        "textFallback": {"autoSwitch": True, "chain": chain},
    }


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    def __init__(self, provider: str, model: str, usage_detail: dict[str, Any] | None) -> None:
        self.content = "generated"
        self.provider = provider
        self.model = model
        self.usage = None
        self.stats = {"provider": provider, "model": model, "prompt_tokens": 10}
        self.usage_detail = usage_detail


class _StubText:
    def __init__(self, failing: set[str], usage_detail: dict[str, Any] | None = None) -> None:
        self.failing = failing
        self.usage_detail = usage_detail
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return _Result(kwargs["provider"], kwargs["model"], self.usage_detail)


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    """Runs `core.agent` and returns every recorded step as `(step_type, status, offset, stats)`."""
    steps: list[tuple[str, str, int, dict[str, Any] | None]] = []

    class _CapturingBatch:
        def __init__(self, _settings: Any, ctx: Any) -> None:
            self.ctx = ctx

        def record(self, *, step_type, name, status, started, stats=None, offset=0, **_kw):
            steps.append((step_type, status, offset, stats))

        async def flush(self) -> None:
            return None

    monkeypatch.setattr(core, "_phi_redactor", lambda: None)
    monkeypatch.setattr(
        "harness.temporal.interpreter.nodes._shared.TrajectoryBatch", _CapturingBatch
    )

    async def _go(
        chain: list[dict[str, Any]],
        failing: set[str],
        usage_detail: dict[str, Any] | None = None,
    ):
        monkeypatch.setattr(core, "_api_client", lambda _s: _StubApi(_wire(chain)))
        monkeypatch.setattr(core, "_text_client", lambda _s: _StubText(failing, usage_detail))
        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="agent1",
                node_type="core.agent",
                config={"agentRef": {"slug": "clinic-summarizer"}},
                tenant_id=_TENANT,
                sandbox=False,
                bound_inputs={"in": "Summarise this."},
                run_payload={},
                run_id=_RUN,
                trajectory={"tenant_id": _TENANT, "seq": 0},
            )
        )
        return steps, result

    return _go


class TestAFailedLegIsRecorded:
    @pytest.mark.asyncio
    async def test_the_primary_that_raised_gets_its_own_error_llm_call_step(self, run) -> None:
        steps, result = await run(
            [_candidate("lm-studio", "gemma-4", "platform")], {"azure-openai"}
        )

        assert result.status == "SUCCEEDED"
        node, served, failed = steps
        assert (node[0], node[1], node[2]) == ("NODE", "OK", 0)
        assert (served[0], served[1], served[2]) == ("LLM_CALL", "OK", 1)
        assert (failed[0], failed[1], failed[2]) == (
            "LLM_CALL",
            "ERROR",
            FAILED_ATTEMPT_OFFSET_BASE,
        )

    @pytest.mark.asyncio
    async def test_the_failed_step_names_the_candidate_that_could_not_serve(self, run) -> None:
        steps, _result = await run(
            [_candidate("lm-studio", "gemma-4", "platform")], {"azure-openai"}
        )

        stats = steps[-1][3]
        assert stats["provider"] == "azure-openai"
        assert stats["model"] == "gpt-5.4-mini"
        assert stats["funding_tier"] == "tenant"
        assert stats["leg"] == "failed"
        assert stats["trigger"] == "WORKFLOW_RUN"
        assert isinstance(stats["total_ms"], int)
        # Nothing was generated, so there is nothing to bill on the token plane.
        assert "prompt_tokens" not in stats
        assert "predicted_tokens" not in stats

    @pytest.mark.asyncio
    async def test_the_step_that_SERVED_still_carries_the_billable_block(self, run) -> None:
        steps, _result = await run(
            [_candidate("lm-studio", "gemma-4", "platform")], {"azure-openai"}
        )

        served = steps[1][3]
        assert served["provider"] == "lm-studio"
        assert served["prompt_tokens"] == 10
        assert "leg" not in served  # the serving leg is not a "failed" one

    @pytest.mark.asyncio
    async def test_two_failed_legs_take_consecutive_offsets(self, run) -> None:
        chain = [
            _candidate("lm-studio", "gemma-4", "platform"),
            _candidate("vllm", "qwen-3", None),
        ]
        steps, result = await run(chain, {"azure-openai", "lm-studio"})

        assert result.status == "SUCCEEDED"
        failed = [s for s in steps if s[1] == "ERROR"]
        assert [s[2] for s in failed] == [
            FAILED_ATTEMPT_OFFSET_BASE,
            FAILED_ATTEMPT_OFFSET_BASE + 1,
        ]
        assert [s[3]["provider"] for s in failed] == ["azure-openai", "lm-studio"]

    @pytest.mark.asyncio
    async def test_an_underived_funding_tier_is_absent_never_guessed(self, run) -> None:
        steps, _result = await run(
            [_candidate("vllm", "qwen-3", None), _candidate("lm-studio", "gemma-4", "platform")],
            {"azure-openai", "vllm"},
        )

        failed = [s for s in steps if s[1] == "ERROR"]
        assert "funding_tier" not in failed[1][3]

    @pytest.mark.asyncio
    async def test_when_every_candidate_fails_the_legs_are_still_recorded(self, run) -> None:
        steps, result = await run(
            [_candidate("lm-studio", "gemma-4", "platform")], {"azure-openai", "lm-studio"}
        )

        assert result.status == "DEGRADED"
        assert [(s[0], s[1], s[2]) for s in steps] == [
            ("NODE", "DEGRADED", 0),
            ("LLM_CALL", "ERROR", FAILED_ATTEMPT_OFFSET_BASE),
            ("LLM_CALL", "ERROR", FAILED_ATTEMPT_OFFSET_BASE + 1),
        ]

    @pytest.mark.asyncio
    async def test_a_lone_primary_with_no_chain_still_records_its_leg(self, run) -> None:
        """`autoSwitch` off / an empty chain is the common shape — and the one that used to
        lose the most: one provider, one failure, nothing recorded anywhere."""
        steps, result = await run([], {"azure-openai"})

        assert result.status == "DEGRADED"
        assert [(s[0], s[1], s[2]) for s in steps] == [
            ("NODE", "DEGRADED", 0),
            ("LLM_CALL", "ERROR", FAILED_ATTEMPT_OFFSET_BASE),
        ]


class TestTheOffsetSchemeCannotCollide:
    def test_the_reserved_offsets_are_the_node_step_and_the_serving_step(self) -> None:
        assert FAILED_ATTEMPT_OFFSET_BASE == 2

    def test_the_cap_matches_both_lanes_seq_strides(self) -> None:
        """The one invariant that makes the scheme safe.

        `MAX_FAILED_ATTEMPT_STEPS` cannot import either stride (`interpreter/workflow.py`
        imports `nodes/_shared`, so the edge would be a cycle), so it is mirrored — and a
        mirror that nothing checks is how two numbers drift apart.
        """
        assert interpreter_workflow._SEQ_STRIDE == doc_workflows._SEQ_STRIDE
        assert (
            FAILED_ATTEMPT_OFFSET_BASE + MAX_FAILED_ATTEMPT_STEPS
            == interpreter_workflow._SEQ_STRIDE
        )

    def test_attempts_past_the_cap_are_dropped_not_allowed_to_collide(self) -> None:
        recorded: list[int] = []

        class _Batch:
            def record(self, *, offset: int = 0, **_kw: Any) -> None:
                recorded.append(offset)

        activities_mod.record_failed_attempts(
            _Batch(),
            [
                activities_mod.FailedAttempt(_STARTED, {"provider": "p", "model": "m"})
                for _ in range(MAX_FAILED_ATTEMPT_STEPS + 3)
            ],
        )

        assert len(recorded) == MAX_FAILED_ATTEMPT_STEPS
        assert max(recorded) == interpreter_workflow._SEQ_STRIDE - 1

    def test_no_attempts_records_nothing(self) -> None:
        class _Batch:
            def record(self, **_kw: Any) -> None:  # pragma: no cover
                raise AssertionError("nothing to record")

        activities_mod.record_failed_attempts(_Batch(), None)
        activities_mod.record_failed_attempts(_Batch(), [])


class TestUsageDetailCounters:
    """F-6 — the counts AD-1 `GenerationStats` cannot express."""

    def test_the_flat_spelling_is_copied_verbatim(self) -> None:
        assert usage_detail_counters(
            {
                "cache_read_tokens": 128,
                "cache_write_tokens": 64,
                "reasoning_tokens": 512,
                "total_ms": 30412,
                "engine_ms": 29800,
                "request_bytes": 4096,
                "response_bytes": 2048,
            }
        ) == {
            "cache_read_tokens": 128,
            "cache_write_tokens": 64,
            "reasoning_tokens": 512,
            "total_ms": 30412,
            "engine_ms": 29800,
            "request_bytes": 4096,
            "response_bytes": 2048,
        }

    def test_the_providers_own_raw_object_is_read_when_the_flat_keys_are_absent(self) -> None:
        """The shape `apps/text` actually emits TODAY — and the reason F-6 was reported."""
        assert usage_detail_counters(
            {
                "raw": {
                    "prompt_tokens": 812,
                    "prompt_tokens_details": {"cached_tokens": 300, "cache_write_tokens": 12},
                    "completion_tokens_details": {"reasoning_tokens": 900},
                }
            }
        ) == {"cache_read_tokens": 300, "cache_write_tokens": 12, "reasoning_tokens": 900}

    def test_the_flat_spelling_wins_over_raw(self) -> None:
        counters = usage_detail_counters(
            {
                "reasoning_tokens": 7,
                "raw": {"completion_tokens_details": {"reasoning_tokens": 900}},
            }
        )
        assert counters["reasoning_tokens"] == 7

    def test_absent_is_absent_never_zero(self) -> None:
        assert usage_detail_counters({}) == {}
        assert usage_detail_counters(None) == {}
        assert usage_detail_counters({"raw": {}}) == {}
        assert usage_detail_counters("nonsense") == {}

    def test_a_reported_zero_is_kept(self) -> None:
        assert usage_detail_counters({"cache_read_tokens": 0}) == {"cache_read_tokens": 0}

    def test_a_non_numeric_value_is_dropped_rather_than_crashing(self) -> None:
        assert usage_detail_counters({"total_ms": "fast", "engine_ms": True}) == {}

    @pytest.mark.asyncio
    async def test_the_counts_ride_the_interpreter_lanes_llm_call_step(self, run) -> None:
        steps, _result = await run(
            [],
            set(),
            usage_detail={
                "total_ms": 30412,
                "raw": {"completion_tokens_details": {"reasoning_tokens": 900}},
            },
        )

        served = next(s for s in steps if s[0] == "LLM_CALL")[3]
        assert served["reasoning_tokens"] == 900
        assert served["total_ms"] == 30412
        # Everything the lane already stamped is untouched.
        assert served["trigger"] == "WORKFLOW_RUN"
        assert served["prompt_tokens"] == 10

    @pytest.mark.asyncio
    async def test_a_response_without_usage_detail_changes_nothing(self, run) -> None:
        steps, _result = await run([], set(), usage_detail=None)

        served = next(s for s in steps if s[0] == "LLM_CALL")[3]
        assert "reasoning_tokens" not in served
        assert served["prompt_tokens"] == 10
