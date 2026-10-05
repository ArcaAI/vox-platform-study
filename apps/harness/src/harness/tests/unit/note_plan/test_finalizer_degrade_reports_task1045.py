"""A degraded consultation finalizer reports the failure, so the consultation is not marked
``OUTPUT_INVALID`` (TASK-1045 live-fix3).

Live run 2026-10-05: the governed finalizer degraded (nothing bound), stored no output, and the
critical ``core.output`` node then failed its schema — the run's error code became
``OUTPUT_INVALID`` and that is what the consultation's processing reason read. The finalizer knows
why it wrote nothing; it now says so on the harness progress feed (``failed`` stage), which marks a
STOPPED consultation with no note FAILED by the note path — keeping an earlier named reason
(``NOTE_INPUT_EXCEEDS_CONTEXT``) — before the run's own failure arrives, and ``failGovernedRun``
keeps that reason.
"""

from __future__ import annotations

from typing import Any

from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    GROUPS,
    _Api,
    _CapTraj,
    _env,
    _governed_agent,
    _raw,
    _Text,
    activities,
)


class _ReportingApi(_Api):
    def __init__(self, plan: dict[str, Any], *, fail: bool = False) -> None:
        super().__init__(plan)
        self.progress: list[dict[str, Any]] = []
        self.fail = fail

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return _governed_agent()

    async def report_progress(self, consultation_id: str, **kwargs: Any) -> Any:
        if self.fail:
            from harness.services.api_client import ApiServiceError

            raise ApiServiceError("down")
        self.progress.append({"consultation_id": consultation_id, **kwargs})
        return None


async def _run(monkeypatch, api: _ReportingApi, *, bound: dict[str, Any], cadence: str = "onEnd"):
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: _Text())
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: _CapTraj())
    return await _env().run(
        core.interpreter_core_agent,
        NodeActivityInput(
            node_id="n_finalize",
            node_type="core.agent",
            config={
                "agentRef": {"slug": "casenote-finalization"},
                "execution": {"lane": "durable", "cadence": cadence},
            },
            tenant_id=_GOV_TENANT,
            bound_inputs=bound,
            run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
            run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": {}},
            run_id="run-1",
        ),
    )


async def test_a_note_plan_error_is_reported_as_a_failed_note(monkeypatch) -> None:
    api = _ReportingApi(_raw(GROUPS))

    result = await _run(
        monkeypatch,
        api,
        bound={"in": [{"text": "", "note_plan_error": "NOTE_INPUT_EXCEEDS_CONTEXT"}]},
    )

    assert result.status == "DEGRADED"
    [report] = api.progress
    assert report["consultation_id"] == _GOV_CONSULTATION
    assert report["tenant_id"] == _GOV_TENANT
    assert report["stage"] == "failed"
    assert "NOTE_INPUT_EXCEEDS_CONTEXT" in report["label"]


async def test_a_finalizer_with_nothing_bound_reports_a_failed_note(monkeypatch) -> None:
    api = _ReportingApi(_raw(GROUPS))

    result = await _run(monkeypatch, api, bound={})

    assert result.status == "DEGRADED"
    assert [r["stage"] for r in api.progress] == ["failed"]
    assert "no_bound_text" in api.progress[0]["label"]


async def test_a_plan_the_api_cannot_serve_is_reported(monkeypatch) -> None:
    class _Unavailable(_ReportingApi):
        async def get_note_plan(self, *_a: Any, **_k: Any):
            from harness.services.api_client import ApiServiceError

            raise ApiServiceError("gone")

    api = _Unavailable(_raw(GROUPS))
    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": _raw(GROUPS)["planId"]}

    result = await _run(monkeypatch, api, bound={"in": [{"text": "", "note_plan_ref": ref}]})

    assert result.status == "DEGRADED"
    assert "note_plan_unavailable" in api.progress[0]["label"]


async def test_a_node_that_is_not_the_consultation_finalizer_reports_nothing(monkeypatch) -> None:
    api = _ReportingApi(_raw(GROUPS))

    result = await _run(monkeypatch, api, bound={}, cadence="once")

    assert result.status == "DEGRADED"
    assert api.progress == []


async def test_a_failed_report_never_changes_the_outcome(monkeypatch) -> None:
    api = _ReportingApi(_raw(GROUPS), fail=True)

    result = await _run(
        monkeypatch,
        api,
        bound={"in": [{"text": "", "note_plan_error": "NOTE_INPUT_EXCEEDS_CONTEXT"}]},
    )

    assert result.status == "DEGRADED"
    assert "NOTE_INPUT_EXCEEDS_CONTEXT" in (result.reason or "")
