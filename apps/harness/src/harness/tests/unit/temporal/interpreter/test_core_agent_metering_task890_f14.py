"""F14 — a workflow-lane `core.agent` generation is METERED (OD-E: count every inference).

Measured on run `01a079fd-…`: the pre-summary node ran a real ~30 s gemma generation and
`core."AiUsageEvent"` gained ZERO rows, while the SAME agent invoked through the gateway produced
`AGENT_INVOCATION` rows. The cause was one field: every interpreter node recorded its
`AgentTrajectoryStep` with `stats = null`, and the gateway's co-emission hook
(`buildHarnessUsageEvent`) bills exactly the LLM_CALL steps that carry billable AD-1
`GenerationStats`. No stats, no step type, no row.

The durable consultation lane has recorded that step since F-19 (`activities.py::generate`); the
interpreter lane never did. It does now, from the SAME `result.stats` block, plus the three
dimensions this lane is the only place that knows:

* `trigger: WORKFLOW_RUN` — WHICH product activity caused the inference (OD-E's closed
  vocabulary);
* `funding_tier` — the tier the GATEWAY derived for the candidate that actually served, which is
  what decides BYOK vs platform metering. Derived, never stamped by a call site;
* `guardrail` — the screening disposition the node folded once for the whole fallback walk.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

#: What `apps/text` returns in `GenerateResponse.stats` (AD-1 `GenerationStats`).
_TEXT_STATS = {
    "provider": "lm-studio",
    "model": "gemma-4-e2b-it-qat",
    "prompt_tokens": 812,
    "predicted_tokens": 344,
    "total_tokens": 1156,
    "total_ms": 30412,
    "stop_reason": "stop",
}


def _wire(funding_tier: str | None, guardrail: dict[str, Any] | None) -> dict[str, Any]:
    compiled: dict[str, Any] = {
        "task": "TEXT_GENERATION",
        "service": "llm",
        "model": {
            "id": "m-1",
            "slug": "lms-gemma",
            "provider": "lm-studio",
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
    }
    if guardrail is not None:
        compiled["guardrail"] = guardrail
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "arcaai-pre-summarization",
        "versionNumber": 4,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": compiled,
        "models": [
            {
                "role": "primary",
                "priority": 0,
                "slug": "lms-gemma",
                "sourceUri": "gemma-4-e2b-it-qat",
                "provider": "lm-studio",
                "format": "GGUF",
                "tenantId": _TENANT,
            }
        ],
        "textPrimary": {
            "kind": "primary",
            "agent": {
                "slug": "arcaai-pre-summarization",
                "versionId": "agent-1",
                "versionNumber": 4,
                "tenantId": _TENANT,
                "source": "tenant",
            },
            "modelSlug": "lms-gemma",
            "provider": "lm-studio",
            "model": "gemma-4-e2b-it-qat",
            "resolvedPrompt": {"source": "inline", "content": "Summarise."},
            "instruction": {"systemPrompt": "Summarise."},
            "parameters": {},
            "tools": [],
            "fundingTier": funding_tier,
        },
        "textFallback": {"autoSwitch": False, "chain": []},
    }


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    content = "A pre-summary."
    provider = "lm-studio"
    model = "gemma-4-e2b-it-qat"
    usage = {"prompt_tokens": 812, "completion_tokens": 344}
    stats = dict(_TEXT_STATS)


class _StubText:
    async def generate(self, **_kwargs: Any) -> _Result:
        return _Result()


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    recorded: list[dict[str, Any]] = []

    async def _record_generation(payload: Any, *, started: Any, stats: dict[str, Any]) -> None:
        recorded.append(stats)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _record_generation)
    monkeypatch.setattr(core, "_phi_redactor", lambda: None)
    monkeypatch.setattr(core, "_text_client", lambda _settings: _StubText())

    async def _go(
        funding_tier: str | None = "platform", guardrail: dict[str, Any] | None = None
    ) -> tuple[list[dict[str, Any]], Any]:
        monkeypatch.setattr(
            core, "_api_client", lambda _settings: _StubApi(_wire(funding_tier, guardrail))
        )
        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="node_presummary",
                node_type="core.agent",
                config={"agentRef": {"slug": "arcaai-pre-summarization"}},
                tenant_id=_TENANT,
                sandbox=False,
                bound_inputs={"in": "Patient reports chest pain."},
                run_payload={},
                run_id=_RUN,
            )
        )
        return recorded, result

    return _go


class TestTheGenerationIsBillable:
    @pytest.mark.asyncio
    async def test_the_text_stats_block_rides_verbatim(self, run) -> None:
        recorded, result = await run()

        assert result.status == "SUCCEEDED"
        assert len(recorded) == 1
        stats = recorded[0]
        # The two counts `buildHarnessUsageEvent` bills from, plus the attribution
        # it refuses to guess at (`if (!rawProvider) return null`).
        assert stats["prompt_tokens"] == 812
        assert stats["predicted_tokens"] == 344
        assert stats["provider"] == "lm-studio"
        assert stats["model"] == "gemma-4-e2b-it-qat"
        # Everything else Text reported survives untouched.
        assert stats["total_ms"] == 30412

    @pytest.mark.asyncio
    async def test_the_trigger_says_which_activity_caused_it(self, run) -> None:
        recorded, _result = await run()

        assert recorded[0]["trigger"] == "WORKFLOW_RUN"

    @pytest.mark.asyncio
    async def test_funding_comes_from_the_candidate_that_served(self, run) -> None:
        recorded, _result = await run(funding_tier="tenant")

        assert recorded[0]["funding_tier"] == "tenant"

    @pytest.mark.asyncio
    async def test_a_platform_funded_call_says_so(self, run) -> None:
        recorded, _result = await run(funding_tier="platform")

        assert recorded[0]["funding_tier"] == "platform"

    @pytest.mark.asyncio
    async def test_an_underived_funding_tier_is_absent_never_guessed(self, run) -> None:
        recorded, _result = await run(funding_tier=None)

        assert "funding_tier" not in recorded[0]

    @pytest.mark.asyncio
    async def test_the_screening_disposition_rides_along(self, run) -> None:
        screened, _r1 = await run(guardrail={"enabled": True})
        assert screened[0]["guardrail"] == "screened"

    @pytest.mark.asyncio
    async def test_an_opted_out_generation_is_still_billed_and_says_so(
        self, monkeypatch: pytest.MonkeyPatch, run
    ) -> None:
        recorded, result = await run(guardrail={"enabled": False})

        assert result.status == "SUCCEEDED"
        assert recorded[0]["guardrail"] == "opted_out"


class TestNothingIsBilledForAGenerationThatDidNotHappen:
    @pytest.mark.asyncio
    async def test_a_degraded_node_records_no_llm_call_step(
        self, monkeypatch: pytest.MonkeyPatch, run
    ) -> None:
        recorded: list[dict[str, Any]] = []

        async def _record_generation(_payload: Any, **kwargs: Any) -> None:
            recorded.append(kwargs["stats"])

        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        monkeypatch.setattr(core, "record_and_flush", _noop)
        monkeypatch.setattr(core, "record_generation_and_flush", _record_generation)
        monkeypatch.setattr(core, "_phi_redactor", lambda: None)
        monkeypatch.setattr(
            core, "_api_client", lambda _settings: _StubApi(_wire("platform", None))
        )
        monkeypatch.setattr(core, "_text_client", lambda _settings: _StubText())

        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="node_presummary",
                node_type="core.agent",
                config={"agentRef": {"slug": "arcaai-pre-summarization"}},
                tenant_id=_TENANT,
                sandbox=False,
                bound_inputs={},  # nothing bound => DEGRADED before any provider is reached
                run_payload={},
                run_id=_RUN,
            )
        )

        assert result.status == "DEGRADED"
        assert recorded == []
