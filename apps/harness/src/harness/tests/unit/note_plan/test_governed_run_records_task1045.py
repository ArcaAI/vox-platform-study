"""The governed finalizer's trajectory steps carry what the gateway's run record needs.

A WorkflowInterpreter run's trajectory context carries no consultation id (the interpreter is
keyed by run, not consultation), so the governed note's NOTE_GENERATE / NOTE_SECTION_GROUP run
records landed with no consultation, no workflow slug/version and the TEMPORAL run id — invisible
to the console's per-consultation run view. The finalizer knows all three (the plan is bound to
its consultation; protocol v2 hands it ``run.*``), so it stamps them on every step it records,
and the note-level step also names the served model and the summed tokens.

Hermetic: gateway, Text and the run-event producer are stubbed; the activity runs under
``ActivityEnvironment``.
"""

from __future__ import annotations

from typing import Any

from harness.services.note_plan.models import NotePlanV1
from harness.services.text_client import TextGenerationResult
from harness.temporal.models import TrajectoryContext
from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    GROUPS,
    _answer,
    _Api,
    _CapTraj,
    _env,
    _governed_agent,
    _raw,
    activities,
)

_HOPE_RUN = "01a10d86-f2ef-7d30-a177-6b7824aa4423"
_CALLS = len(_raw(GROUPS)["calls"])


class _Text:
    def __init__(self, plan: NotePlanV1) -> None:
        self.plan = plan

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        call = next(c for c in self.plan.calls if kwargs["prompt"].endswith(c.directive))
        return TextGenerationResult(
            content=_answer(list(call.section_keys)),
            model=kwargs["model"],
            provider=kwargs["provider"],
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            stats={
                "provider": kwargs["provider"],
                "model": kwargs["model"],
                "prompt_tokens": 100,
                "predicted_tokens": 20,
            },
        )


class _Producer:
    async def append(self, **_kwargs: Any) -> None:
        return None

    async def text_delta(self, **_kwargs: Any) -> None:
        return None


async def _run(monkeypatch, *, protocol: int | None, run_fields: dict[str, Any] | None):
    import harness.temporal.interpreter.activities as interpreter_activities
    from harness.services.api_client import DraftResponse
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION
    plan = NotePlanV1.model_validate(raw)
    agent = _governed_agent()

    class _GovApi(_Api):
        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return agent

    api, cap = _GovApi(raw), _CapTraj()

    async def _persist_draft(_payload: Any) -> Any:
        return DraftResponse(context_item_id="ctx-1", version_number=7)

    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: _Text(plan))
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)
    monkeypatch.setattr(activities, "persist_draft", _persist_draft)
    monkeypatch.setattr(interpreter_activities, "run_event_producer", lambda: _Producer())

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": raw["planId"]}
    result = await _env().run(
        core.interpreter_core_agent,
        NodeActivityInput(
            node_id="n_finalize",
            node_type="core.agent",
            config={
                "agentRef": {"slug": "casenote-finalization"},
                "execution": {"lane": "durable", "cadence": "onEnd"},
            },
            tenant_id=_GOV_TENANT,
            bound_inputs={"in": [{"text": "", "note_plan_ref": ref}]},
            run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
            run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": {}},
            run_id=_HOPE_RUN,
            protocol=protocol,
            run_fields=run_fields,
            # What the interpreter actually threads: node identity, never a consultation id.
            trajectory=TrajectoryContext(
                tenant_id=_GOV_TENANT, seq=48, node_id="n_finalize", node_type="core.agent"
            ),
        ),
    )
    return result, cap.steps


def _wire(step: Any) -> dict[str, Any]:
    return step.model_dump() if hasattr(step, "model_dump") else dict(step)


async def test_every_note_step_names_the_consultation_and_the_workflow_run(monkeypatch) -> None:
    result, steps = await _run(
        monkeypatch,
        protocol=2,
        run_fields={
            "id": _HOPE_RUN,
            "tenantId": _GOV_TENANT,
            "workflowSlug": "arcaai-bren-consultation",
            "workflowVersion": 1,
        },
    )

    assert result.status == "SUCCEEDED"
    recorded = [_wire(s) for s in steps if (_wire(s).get("stats") or {}).get("activity_kind")]
    kinds = sorted(s["stats"]["activity_kind"] for s in recorded)
    assert kinds == ["NOTE_GENERATE"] + ["NOTE_SECTION_GROUP"] * _CALLS
    for step in recorded:
        assert step["consultation_id"] == _GOV_CONSULTATION
        assert step["stats"]["workflow_slug"] == "arcaai-bren-consultation"
        assert step["stats"]["workflow_version"] == 1
        assert step["stats"]["workflow_run_id"] == _HOPE_RUN
        assert step["stats"]["agent_slug"] == "casenote-finalization"


async def test_the_note_record_names_the_served_model_and_the_summed_tokens(monkeypatch) -> None:
    _result, steps = await _run(
        monkeypatch,
        protocol=2,
        run_fields={
            "id": _HOPE_RUN,
            "workflowSlug": "arcaai-bren-consultation",
            "workflowVersion": 1,
        },
    )

    node = next(
        _wire(s)
        for s in steps
        if (_wire(s).get("stats") or {}).get("activity_kind") == "NOTE_GENERATE"
    )
    assert node["stats"]["provider"]
    assert node["stats"]["model"]
    assert node["stats"]["prompt_tokens"] == 100 * _CALLS
    assert node["stats"]["predicted_tokens"] == 20 * _CALLS
    assert node["stats"]["context_item_id"] == "ctx-1"
    assert node["stats"]["output_version"] == 7


async def test_without_protocol_v2_the_run_id_still_names_the_workflow_run(monkeypatch) -> None:
    _result, steps = await _run(monkeypatch, protocol=None, run_fields=None)

    recorded = [_wire(s) for s in steps if (_wire(s).get("stats") or {}).get("activity_kind")]
    assert recorded
    for step in recorded:
        assert step["consultation_id"] == _GOV_CONSULTATION
        assert step["stats"]["workflow_run_id"] == _HOPE_RUN
        assert "workflow_slug" not in step["stats"]
