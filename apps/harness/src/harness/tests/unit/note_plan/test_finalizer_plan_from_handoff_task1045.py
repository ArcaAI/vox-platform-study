"""The governed finalizer finds the handoff's note plan where the WALK actually puts it
(TASK-1045 e2e, E2E-NOTE).

Live e2e 2026-10-05 (ArcaAI, ``arcaai-bren-consultation``): every governed run — encounter 1 and the
encounter-2 supersede — ended ``core.agent n_finalize DEGRADED no_bound_text`` and then
``core.output`` failed its schema (``'case_note' is a required property``), with no model call.

The live handoff hands each note node ``{text: '', note_plan_ref}``. The graph binds
``n_summary_*.out -> n_finalize.in``, and ``core.agent``'s ``out`` socket is the ``text`` key
(``registry.py``), so the walk bound ``in = ''``: the pointer never reached the finalizer. The
unit tests bound ``in`` as the whole output dict, which the walk never does. The seeded node
outputs ARE in the run context (``run_context.nodes``), so the finalizer reads the pointer there
when ``in`` carries none — an activity-only change, no workflow command differs.
"""

from __future__ import annotations

from typing import Any

from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    GROUPS,
    NotePlanV1,
    TrajectoryContext,
    _answer,
    _Api,
    _CapTraj,
    _env,
    _governed_agent,
    _raw,
    _Text,
    activities,
)


class _GovApi(_Api):
    def __init__(self, plan: dict[str, Any]) -> None:
        super().__init__(plan)
        self.progress: list[dict[str, Any]] = []

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return _governed_agent()

    async def report_progress(self, consultation_id: str, **kwargs: Any) -> Any:
        self.progress.append({"consultation_id": consultation_id, **kwargs})
        return None

    async def verify_governed_prompts(self, **_kwargs: Any) -> dict[str, Any]:
        # TASK-1047 V7: an unstamped agent is verified through the gateway registry.
        return {"governed": True, "policyVersion": "pv1"}


def _input(*, bound: dict[str, Any], nodes: dict[str, Any]):
    from harness.temporal.interpreter.models import NodeActivityInput

    return NodeActivityInput(
        node_id="n_finalize",
        node_type="core.agent",
        config={
            "agentRef": {"slug": "casenote-finalization"},
            "execution": {"lane": "durable", "cadence": "onEnd"},
        },
        tenant_id=_GOV_TENANT,
        bound_inputs=bound,
        run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
        run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": nodes},
        run_id="run-1",
        trajectory=TrajectoryContext(
            tenant_id=_GOV_TENANT, consultation_id=_GOV_CONSULTATION, seq=48
        ),
    )


async def test_the_plan_seeded_on_a_live_note_node_reaches_the_finalizer_bound_through_out(
    monkeypatch,
) -> None:
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION
    plan = NotePlanV1.model_validate(raw)
    api, cap = _GovApi(raw), _CapTraj()
    text = _Text(
        script={
            plan.calls[0].directive: [_answer(["subjective", "objective"])],
            plan.calls[1].directive: [_answer(["assessment", "plan"])],
        }
    )
    persisted: list[Any] = []

    async def _persist_draft(payload: Any) -> Any:
        from harness.services.api_client import DraftResponse

        persisted.append(payload)
        return DraftResponse(context_item_id="ctx-1", version_number=1)

    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)
    monkeypatch.setattr(activities, "persist_draft", _persist_draft)

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": raw["planId"]}
    seeded = {"text": "", "note_plan_ref": ref}
    result = await _env().run(
        core.interpreter_core_agent,
        _input(
            # What the walk binds: `n_summary_new.out` is the `text` key.
            bound={"in": ""},
            nodes={
                "n_trigger": {"context": {"consultationId": _GOV_CONSULTATION}},
                "n_ner": {"text": "", "entities": []},
                "n_summary_new": seeded,
                "n_summary_revisit": seeded,
            },
        ),
    )

    assert result.status == "SUCCEEDED", result.reason
    assert api.calls == [(_GOV_CONSULTATION, raw["planId"], _GOV_TENANT)]
    assert len(text.calls) == 2
    assert set(result.output["data"]) == {"case_note", "redactions", "sources"}
    [draft] = persisted
    assert draft.content == result.output["data"]["case_note"]
    assert api.progress == []


async def test_a_seeded_plan_error_degrades_with_that_code_not_no_bound_text(monkeypatch) -> None:
    from harness.temporal.interpreter.nodes import core

    api, cap, text = _GovApi(_raw(GROUPS)), _CapTraj(), _Text()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

    result = await _env().run(
        core.interpreter_core_agent,
        _input(
            bound={"in": ""},
            nodes={"n_summary_new": {"text": "", "note_plan_error": "NOTE_INPUT_EXCEEDS_CONTEXT"}},
        ),
    )

    assert result.status == "DEGRADED"
    assert "NOTE_INPUT_EXCEEDS_CONTEXT" in (result.reason or "")
    assert text.calls == []
    assert [s.error_code for s in cap.steps] == ["NOTE_INPUT_EXCEEDS_CONTEXT"]


async def test_a_bound_note_still_wins_over_the_run_context(monkeypatch) -> None:
    """``in`` carrying its own pointer (or error) is read first, exactly as before."""
    from harness.temporal.interpreter.nodes import core

    api, cap, text = _GovApi(_raw(GROUPS)), _CapTraj(), _Text()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": _raw(GROUPS)["planId"]}
    result = await _env().run(
        core.interpreter_core_agent,
        _input(
            bound={"in": [{"text": "", "note_plan_error": "NOTE_MODEL_CONTEXT_UNDECLARED"}]},
            nodes={"n_summary_new": {"text": "", "note_plan_ref": ref}},
        ),
    )

    assert result.status == "DEGRADED"
    assert "NOTE_MODEL_CONTEXT_UNDECLARED" in (result.reason or "")
    assert api.calls == []


async def test_a_non_finalizer_never_reads_a_seeded_plan(monkeypatch) -> None:
    from harness.temporal.interpreter.nodes import core

    api, cap, text = _GovApi(_raw(GROUPS)), _CapTraj(), _Text()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": _raw(GROUPS)["planId"]}
    payload = _input(bound={"in": ""}, nodes={"n_summary_new": {"text": "", "note_plan_ref": ref}})
    once = payload.model_copy(
        update={
            "config": {
                "agentRef": {"slug": "casenote-finalization"},
                "execution": {"lane": "durable", "cadence": "once"},
            }
        }
    )
    result = await _env().run(core.interpreter_core_agent, once)

    assert result.status == "DEGRADED"
    assert "nothing bound" in (result.reason or "")
    assert api.calls == []
