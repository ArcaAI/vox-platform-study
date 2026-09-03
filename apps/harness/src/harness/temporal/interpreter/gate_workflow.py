"""``ConsultationGateWorkflow`` — the durable human wait behind ``consultation.hitlGate``

## Why a new workflow type, and not the child-delegation `palette-contract.md` describes

decided "delegate the gate to the existing, replay-fixtured HarnessDocWorkflow gate
machinery as a child workflow", and defended it mainly on *reuse*: "reuses that code UNCHANGED …
the property `03-compliance-posture.md` calls 'the hardest property to get right, and it is
right' (timeout never signs) is never re-derived."

That option is not implementable as written, and the reason is not the one flagged as its own
falsifier. 's stated precondition — " `contracts/versioning.md` … forbids a parent
from starting a non-declared child workflow kind" — was re-confirmed this pass and is FINE:
`versioning.md` has no such prohibition; it requires a `workflow.patched` gate for a new command
in the shared loop (rule 3), which the interpreter side now carries.

The actual blocker is more basic: **``HarnessDocWorkflow`` has no gate-only entry point.**
``HarnessDocWorkflow.run`` is one ~1,100-line method that fetches policy, extracts entities,
retrieves evidence, assembles a prompt, generates, runs both sensor passes and persists a draft
*before* it reaches ``self._phase = "GATE"`` (`workflows.py:1539`). Starting it as a child to
"just wait at the gate" would re-run that entire pipeline and persist a SECOND draft for a
consultation the interpreter's own graph has already persisted one for. That is not delegation;
it is a competing writer.

So this module implements 's REASONING against the code that actually exists:

* **A child, not an interpreter extension.** The interpreter's signal surface stays exactly
  cancel-only — 's "v1 refuses it and the schema enforces the refusal" is
  preserved in full, and no other palette's runs inherit an ``approval`` signal they can never
  use. This was 's decisive axis against option (A).
* **A NEW ``@workflow.defn`` type.** A type with no recorded histories has no era to stay
  compatible with, which is precisely the precedent ``ConsultationLoopWorkflow`` set
  (`workflows.py:1634`: *"Being a NEW workflow type is what makes this safe"*). Nothing here
  needs — or may have — a ``workflow.patched`` marker, unlike the gate loop it mirrors, whose
  ``task-458-gate-terminal-abandon`` era exists only because histories predated that bound.
* **The proven side effects are reused verbatim.** ``escalate_gate`` and
  ``record_gate_decision`` are the same activities ``HarnessDocWorkflow`` calls, unchanged. What
  is re-expressed here is the ~40-line wait/escalate/abandon shape, not the audited writes.

## The property this file exists to hold

**A timeout never signs.** The escalation ladder can only ever end in one of two states: an
``approval`` signal really arrived (``APPROVED``), or the terminal bound was hit without one
(``ABANDONED``, ``approved=False``). There is no third path, no default, and no field a caller
could read as sign-off that is not set from a real signal — the forgery shape
`03-compliance-posture.md` §3 names. An abandoned gate leaves the draft exactly where it is for
manual handling; it does not retract, sign, or deliver anything.

## Not implemented: the ``edit`` signal

``HarnessDocWorkflow`` pairs ``approval`` with ``edit`` because its optimistic-assurance loop can
RE-RUN the inferential pass against an edited note. The interpreter walks a linear compiled graph
with no loop back to synthesis, so an ``edit`` signal would have nothing to re-run and accepting
one would imply a capability that does not exist. A clinician who edits and then signs is carried
by ``GateApprovalSignal.context_item_version_id`` — the same field ``HarnessDocWorkflow`` records
for exactly that case.
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from harness.temporal.activities import escalate_gate, fetch_policy, record_gate_decision
    from harness.temporal.interpreter.models import (
        ConsultationGateInput,
        ConsultationGateResult,
        GateApprovalSignal,
    )
    from harness.temporal.models import (
        EscalateInput,
        FetchPolicyInput,
        HarnessGateConfig,
        HarnessPolicy,
        RecordGateInput,
    )

_POLICY_TIMEOUT = timedelta(seconds=30)
_POLICY_RETRY = RetryPolicy(maximum_attempts=3)
_ESCALATE_TIMEOUT = timedelta(seconds=30)
_RECORD_TIMEOUT = timedelta(seconds=150)
_API_RETRY = RetryPolicy(maximum_attempts=3)

#: Suffix of the deterministic child workflow id (`f"{run_id}{GATE_WORKFLOW_ID_SUFFIX}"`).
#: Derived from the parent's run id alone so a caller can compute it without reading run state —
#: which is what lets the approve route address the child directly. Exactly one gate per graph is
#: a validator guarantee (`WF-CONS-003`, SINGLE_ENTRY on `consultation.hitlGate`), so this needs
#: no per-node discriminator; a palette that ever wants two gates must revisit both.
GATE_WORKFLOW_ID_SUFFIX = "-gate"


def gate_workflow_id(run_id: str) -> str:
    """The deterministic gate child workflow id for a run (pure)."""
    return f"{run_id}{GATE_WORKFLOW_ID_SUFFIX}"


@workflow.defn(name="ConsultationGateWorkflow")
class ConsultationGateWorkflow:
    """Waits for a clinician decision, escalating on an SLA breach, abandoning at the bound."""

    def __init__(self) -> None:
        self._approval: GateApprovalSignal | None = None
        self._phase = "GATE"
        self._escalations = 0

    @workflow.signal(name="approval")
    async def approval(self, payload: GateApprovalSignal) -> None:
        """The ONLY signal this workflow accepts — a code allow-list, never a name
        pass-through (F-09, orchestration.md). A second signal after the first is ignored: the
        gate is decided once."""
        if self._approval is None:
            self._approval = payload

    @workflow.query(name="state")
    def state(self) -> dict[str, object]:
        return {
            "phase": self._phase,
            "escalations": self._escalations,
            "approved": self._approval is not None,
        }

    @workflow.run
    async def run(self, inp: ConsultationGateInput) -> ConsultationGateResult:
        gate = await self._resolve_gate_config(inp)

        deadline = gate.gate_sla_seconds
        while self._approval is None:
            try:
                await workflow.wait_condition(
                    lambda: self._approval is not None,
                    timeout=timedelta(seconds=deadline),
                )
            except TimeoutError:
                terminal = self._escalations + 1 >= gate.gate_max_escalations
                await self._escalate(inp, terminal=terminal)
                self._escalations += 1
                deadline = gate.gate_escalation_seconds
                if self._escalations >= gate.gate_max_escalations:
                    break

        approval = self._approval
        if approval is None:
            # TERMINAL ABANDON. No decision is recorded because there was none: the draft stays
            # where the graph left it for manual handling, and the escalations already wrote the
            # breach record. `approved=False` is the only thing this can say.
            self._phase = "ABANDONED"
            return ConsultationGateResult(
                approved=False, outcome="ABANDONED", escalations=self._escalations
            )

        self._phase = "RECORD"
        await workflow.execute_activity(
            record_gate_decision,
            RecordGateInput(
                consultation_id=inp.consultation_id,
                tenant_id=inp.tenant_id,
                user_id=inp.user_id,
                decision=approval.decision or "SIGNED",
                gate_decision=inp.gate_type,
                context_item_version_id=approval.context_item_version_id,
                attestation_hash=approval.attestation_hash,
                clinician_id=approval.clinician_id,
                trajectory=inp.trajectory,
            ),
            start_to_close_timeout=_RECORD_TIMEOUT,
            retry_policy=_API_RETRY,
        )

        self._phase = "DONE"
        return ConsultationGateResult(
            approved=True,
            outcome="APPROVED",
            decision=approval.decision or "SIGNED",
            clinician_id=approval.clinician_id,
            context_item_version_id=approval.context_item_version_id,
            escalations=self._escalations,
        )

    async def _resolve_gate_config(self, inp: ConsultationGateInput) -> HarnessGateConfig:
        """Tenant SLA knobs, resolved through the same activity `HarnessDocWorkflow` uses.

        An unreachable policy service DEGRADES to the platform defaults rather than failing the
        gate: refusing to wait because a config read timed out would strand a real clinical
        decision, and the defaults are the conservative direction (a longer wait, never a
        shorter one that could abandon early).
        """
        try:
            policy: HarnessPolicy = await workflow.execute_activity(
                fetch_policy,
                FetchPolicyInput(tenant_id=inp.tenant_id, consultation_id=inp.consultation_id),
                start_to_close_timeout=_POLICY_TIMEOUT,
                retry_policy=_POLICY_RETRY,
            )
        except ActivityError:
            return HarnessGateConfig()

        return HarnessGateConfig(
            gate_sla_seconds=float(policy.gate_sla_seconds),
            gate_escalation_seconds=float(policy.gate_escalation_seconds),
        )

    async def _escalate(self, inp: ConsultationGateInput, *, terminal: bool) -> None:
        """Record an SLA breach. Best-effort: an escalation that cannot be written must not
        end the wait — the clinician can still sign, and dropping the wait on a bookkeeping
        failure would be the one outcome worse than a late escalation."""
        try:
            await workflow.execute_activity(
                escalate_gate,
                EscalateInput(
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    reason="gate_sla_abandoned" if terminal else "gate_sla_breached",
                    job_id=inp.job_id,
                    trajectory=inp.trajectory,
                ),
                start_to_close_timeout=_ESCALATE_TIMEOUT,
                retry_policy=_API_RETRY,
            )
        except ActivityError:
            pass
