"""TASK-1047 V7 — the note-plan finalizer never sends a governance claim for a system it did not send.

Live e2e 2026-10-06 (ArcaAI, ``arcaai-bren-consultation``): apps/text logged ``governance: mismatch``
on every finalizer call — a 7,083-char system prompt under the plan's ``composed_digest``, which
describes the plan's 22,021-char system. The interpreter's finalizer sends the AGENT's own
composition (platform rules -> instruction -> language step), yet forwarded each plan call's
``systemGovernance`` verbatim. apps/text then screened the system as untrusted and the medical judge
refused it: every BREN note failed. Invariant: a claim sent always hashes to the text sent.
"""

from __future__ import annotations

import hashlib
from typing import Any

from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    GROUPS,
    NotePlanV1,
    _answer,
    _CapTraj,
    _env,
    _raw,
    _Text,
    activities,
)
from harness.tests.unit.note_plan.test_finalizer_plan_from_handoff_task1045 import _GovApi, _input

_PLAN_SYSTEM = "THE PLAN'S OWN SYSTEM TEXT"
_PLAN_GOV = {
    "composed_digest": hashlib.sha256(_PLAN_SYSTEM.encode("utf-8")).hexdigest(),
    "pieces": [{"kind": "PLATFORM", "key": "platform-rules@1", "digest": "d1"}],
    "policy_version": "pv1",
}


async def test_every_claim_the_finalizer_sends_describes_the_system_it_sends(monkeypatch) -> None:
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION
    raw["system"] = _PLAN_SYSTEM
    for call in raw["calls"]:
        call["systemGovernance"] = _PLAN_GOV
    plan = NotePlanV1.model_validate(raw)
    api = _GovApi(raw)
    text = _Text(
        script={
            plan.calls[0].directive: [_answer(["subjective", "objective"])],
            plan.calls[1].directive: [_answer(["assessment", "plan"])],
        }
    )

    async def _persist_draft(payload: Any) -> Any:
        from harness.services.api_client import DraftResponse

        return DraftResponse(context_item_id="ctx-1", version_number=1)

    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: _CapTraj())
    monkeypatch.setattr(activities, "persist_draft", _persist_draft)

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": raw["planId"]}
    seeded = {"text": "", "note_plan_ref": ref}
    result = await _env().run(
        core.interpreter_core_agent,
        _input(bound={"in": ""}, nodes={"n_summary_new": seeded, "n_summary_revisit": seeded}),
    )

    assert result.status == "SUCCEEDED", result.reason
    assert len(text.calls) == 2
    # The registry vouches (stub), so the agent's own claim IS sent — and must describe its text.
    assert all(call.get("system_governance") for call in text.calls)
    for call in text.calls:
        claim = call.get("system_governance")
        if claim is None:
            continue
        sent = call["system_prompt"] or ""
        assert claim["composed_digest"] == hashlib.sha256(sent.encode("utf-8")).hexdigest()
