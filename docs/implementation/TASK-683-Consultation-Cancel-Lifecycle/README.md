# TASK-683 — Consultation Cancel Lifecycle and the Orphaned `loop-cancel` Signal

**Status:** Blocked (design-only; no unilateral feature build — see §4 Decision)

**Type:** investigation / design (Phase 1 concluded the requested feature must not be
built without product sign-off; Phase 2 delivers a design, not code). **Base:** `dev-2.1`
@ `baeb7d49b` ("Implement robust temporal synchronization helpers for workflow tests").
This worktree spawned off `main` (`180d09d6a`) — the known repo default — and was
`git reset --hard dev-2.1` before any investigation, per the worktree-agent guidance in
project memory.

## 1. Requirement Analysis

TASK-670 built complete, tested `loop-cancel` machinery —
`HarnessGatewayService.signalLoopCancel` (`packages/applications/src/services/consultation/harness/harness-gateway.service.ts:326`),
`LoopContextSignalService.signalLoopCancel` (`packages/applications/src/services/consultation/loop/loop-context-signal.service.ts:106`),
and the harness-side receiver (`POST /api/v1/internal/workflows/{id}/signal/loop-cancel`,
`apps/harness/src/harness/api/endpoints/internal.py:533-560`) — and nothing calls it,
because there is no cancel concept in the domain. `ConsultationStatus`
(`packages/database/src/prisma/db_main/enums.prisma:278-286`) is
`OPEN | RECORDING | DRAFT_PENDING_SENSORS | PENDING_REVIEW | SIGNED | CLOSED | REOPENED`
— no `CANCELLED`, no `ABANDONED`.

**Consequence as stated in the ticket:** an abandoned consultation leaves its loop
workflow running until its own bounds expire, holding worker capacity for hours after
anyone stopped caring.

**The central question:** is `CLOSED` the cancel, or is abandonment genuinely distinct?
This document answers that question with evidence gathered from the code (not
assumption) and states the decision the ticket's own Phase 1 gate requires before any
feature code is written.

## 2. Current State Evaluation (verified against `dev-2.1` @ `baeb7d49b`)

### 2.1 What `close()` actually does today

`ConsultationController.close`/`.reopen` (`apps/api/src/modules/consultation/consultation.controller.ts:439,452`)
call `ConsultationService.closeConsultation`/`.reopenConsultation`
(`packages/applications/src/services/consultation/consultation/consultation.service.ts:710,717`),
which both route through the shared `transitionStatus` helper (`:664-705`). That helper:

- Reads/writes **only** `consultation.metadata.status` — a free-form JSON field holding
  `CONSULTATION_STATUS.OPEN | CLOSED`
  (`packages/applications/src/services/consultation/consultation/dto/update-consultation.request.ts:11-18`).
  Its own doc comment states this explicitly: *"The Consultation model has no dedicated
  open/closed column; lifecycle state is stored in `metadata.status`."*
- **Never touches the typed `status` COLUMN** (`Consultation.status: ConsultationStatus`).
  Grepping every write site of `ConsultationStatus.*` in `packages/applications/src`
  (consultation, harness-internal, summary, agentPromotion services) turns up
  `RECORDING`, `OPEN` (via `setRecordingStatus`, `:794-826`), `DRAFT_PENDING_SENSORS`,
  `PENDING_REVIEW`, `SIGNED` — never `CLOSED` or `REOPENED`. Those two enum members exist
  in the Prisma schema (comment: *"promotes it to a typed column so the clinical-doc
  harness can gate transitions"*) but **nothing in the merged codebase writes them.**
  Close/reopen and the typed lifecycle column are two parallel, non-interacting systems —
  exactly the "two coexisting status systems" TASK-544 flagged
  (`docs/implementation/TASK-544-Agent-Platform-Concept/README.md:76`).
- Is idempotent and gated only by `assertEqualTenants` — **not** by the current typed
  `status` (RECORDING, PENDING_REVIEW, etc.). Nothing prevents calling `close()` while a
  consultation is mid-recording or mid-review.
- **Is clinician/client-initiated**, not systemic. The only caller found in this repo is
  `useArcaSession().close()`/`.reopen()` in the SDK
  (`packages/agentic-sdk-v2/src/hooks/useArcaSession.ts:294-339`), documented in
  `.claude/rules/08-vox-sdk.md` as step 4 of the **normal, happy-path** session lifecycle:
  `session.open()` → `audio.start()` → context/summary → `audio.stop()` →
  `useArcaSession().close()`/`.reopen()`. There is no automated/background closer (no
  cron, no stale-consultation sweep) anywhere in `apps/api` or `apps/harness` — grepped
  for `autoClose`/`stale.*consultation`/`abandon` across both, zero hits beyond the
  `loop-cancel` machinery itself. The admin console exposes `close`/`reopen` only in a
  playground demo screen's mocked SDK session
  (`apps/admin-console/src/features/playground-consultation/components/__tests__/consultation-demo-screen.test.tsx:121`)
  — no production screen wires a real "close" button today.
- `REOPENED` existing as a status value, and `reopen()` being a first-class, symmetric
  operation, means `CLOSED` is **not treated as terminal** in this domain. A closed
  consultation can always come back.

**Conclusion:** `close()` is the ordinary, reversible, client-driven "I'm done with this
session for now" gesture that happens at the END of a successful, cooperative session —
it carries no information about whether the harness loop for that consultation ever ran,
is still running, or has already finished. It is not, and was never designed to be, an
"abandon this consultation" signal.

### 2.2 The ordering hazard against `recording/stop` → `consultation-ending`

`ConsultationController.stopRecording` (`:503-522`) already calls
`loopContextSignalService.signalConsultationEnding(id, { reason: 'recording_stopped', ... })`
(`:511`), which reaches `ConsultationLoopWorkflow.consultation_ending`
(`apps/harness/src/harness/temporal/workflows.py:1964-1968`) and sets `self._ending = True`.
The SDK's documented lifecycle calls `close()` right after `audio.stop()` — i.e. `close()`
frequently races the `consultation-ending` signal, not follows it by a safe margin.

`ConsultationLoopWorkflow.run()`'s main loop (`workflows.py:2028-2049`) is:

```python
while True:
    await workflow.wait_condition(
        lambda: bool(self._pending) or self._ending or self._cancelled
    )
    await self._drain()

    if self._cancelled:            # <-- checked FIRST
        self._phase = "CANCELLED"
        break

    if self._ending:               # <-- checked SECOND
        self._phase = "ENDING"
        await self._drain()
        await self._maybe_replan(force=True)
        await self._run_lifecycle_actions(config.ending_actions)   # starts HarnessDocWorkflow as a child (`_start_finalize_child`, :2325-2419) and finalizes the clinical note
        self._phase = "DONE"
        break
```

**`_cancelled` is checked before `_ending`.** If a `cancel` signal (`workflows.py:1970-1975`)
and a `consultation_ending` signal (`workflows.py:1963-1968`) are both delivered before the
next loop iteration evaluates — a real possibility given `close()` is called immediately
after `audio.stop()` in the documented happy path — the workflow takes the `CANCELLED`
branch and **never runs `ending_actions`, never starts the `HarnessDocWorkflow` finalize
child, and the clinical note is never generated.** This is not a hypothetical: it is the
exact code path a naive "wire `signalLoopCancel` into `close()`" implementation would hit.
The ticket's own hard constraint — *"Cancelling a loop must never affect a consultation's
clinical record — no note, draft, gate decision or attestation may be lost"* — is violated
by option (a) unless the caller can guarantee, by construction, that `cancel` is never sent
once `ending` has been (or is about to be) signaled. No such guarantee exists today: the
gateway (NestJS) has no visibility into the harness workflow's internal `_ending` flag
short of an extra query round-trip that itself has a TOCTOU race against the same signal
delivery.

(Once a loop has already fully entered `ENDING` and is blocked on
`await handle` inside `_start_finalize_child` awaiting the `HarnessDocWorkflow` child, a
later `cancel` signal is inert — it sets `self._cancelled` but nothing re-checks that flag
until the child returns, so it cannot retroactively kill an in-flight finalize. The failure
mode above is specifically the **race window before `_ending` is observed**, not "cancel
kills an already-finalizing note".)

### 2.3 What the harness does today when a consultation is closed mid-run — and what it does NOT do

Nothing. `closeConsultation`/`reopenConsultation` never call `HarnessGatewayService`,
`LoopContextSignalService`, or any harness endpoint. Closing a consultation while its loop
workflow (if `HARNESS_LOOP_ENABLED`) or its directly-started `HarnessDocWorkflow` is
in-flight has **zero effect** on either — they keep running exactly as if `close()` were
never called. This is a second, independent confirmation that `close()` and the harness
lifecycle are not currently coupled in either direction.

### 2.4 Is the "abandoned loop burns capacity for hours" scenario live today?

Two separate document-generation pathways exist:

1. **Direct path (currently the only active one):** `HarnessInternalController`/harness
   `POST /internal/workflows/document/start` (`apps/harness/src/harness/api/endpoints/internal.py:275-299`)
   starts `HarnessDocWorkflow` directly — no `ConsultationLoopWorkflow` parent. This
   workflow's clinician-attestation gate is bounded by
   `gate_sla_seconds: float = 86_400.0` (24h; `apps/harness/src/harness/core/config.py:357`)
   with an escalation path (`workflows.py:1519-1548`, `reason="gate_sla_abandoned"`). This
   is already self-bounding — the exact mechanism the ticket calls "the gate SLA timer."
2. **Loop path (TASK-660/662/670, not yet enabled anywhere):**
   `LoopContextSignalService.loopEnabled` gates on `HARNESS_LOOP_ENABLED` and defaults OFF
   (`raw === 'true' || raw === '1'`, else `false`;
   `packages/applications/src/services/consultation/loop/loop-context-signal.service.ts:44-49`).
   Grepping `.env.dev`/`.env.sample`/`turbo.json#globalEnv` and every `*.yaml`/`*.yml` in
   this repo for `HARNESS_LOOP_ENABLED` finds it **nowhere** — only in the two source files
   above and their tests. `ConsultationLoopWorkflow.run()`'s `wait_condition`
   (`workflows.py:2029-2031`) has **no timeout at all** — a loop that never receives a
   `contextAdded`, `consultationEnding`, or `cancel` signal blocks forever (bounded only by
   whatever default Temporal cluster/task-queue retention exists outside application code,
   which this repo does not configure).

**So: the specific failure mode named in the ticket (an orphaned loop workflow burning
worker capacity) can only occur once `HARNESS_LOOP_ENABLED` is turned on somewhere, and as
far as this repo's checked-in configuration shows, it is not turned on anywhere today.**
This is a real, worth-fixing gap in a feature that is built but not yet live — not an
active production incident. It changes the urgency calculus (get the design right; there
is no fire to put out) without changing the conclusion below.

## 3. The Three Options, With Evidence

**(a) `CLOSED` is the cancel.** Ruled out. §2.1 shows `close()` is a client-driven,
reversible, happy-path session action wholly decoupled from the typed lifecycle column and
the harness workflow; §2.2 shows wiring `signalLoopCancel` into it creates a genuine race
against `recording/stop` → `consultation-ending` that can **silently drop the clinical
note** — a direct violation of this ticket's own hard constraint. Guarding against the race
(e.g. querying loop state before signaling) adds a TOCTOU window rather than closing it, and
turns a "smallest change" option into a nontrivial synchronization problem. Not adopted.

**(b) Abandonment is distinct.** This requires a new lifecycle state, its transitions, and
a UI affordance — a product decision, not a wiring task. **This is the same conclusion
TASK-670 already reached and stopped at** (`docs/implementation/TASK-670-Loop-Signal-Payload/README.md:258-275`):
*"there is genuinely no 'consultation-cancel' / 'abandon consultation' lifecycle action
anywhere in the merged `dev-2.1` codebase today... Inventing a new consultation-lifecycle
status/endpoint to give `loop-cancel` a home is a real feature, not a wiring task, and was
judged out of this ticket's scope."* Every piece of evidence gathered in §2 reconfirms that
conclusion independently: `close()` cannot safely stand in for it (§2.2), no other existing
action expresses "abandon" (§2.1: no cron, no stale-sweep, no UI button), and the enum
already has room for exactly this (`ConsultationStatus`/`CONSULTATION_STATUS` would both
need a new member, and — per rule 03/02 — a new enum member is a migration plus a
`ResourceType` dual-file update if it emits sys-events).

**(c) Neither — the loop should self-terminate.** An idle timeout inside
`ConsultationLoopWorkflow.run()`'s `wait_condition` (§2.4: today there is none) is possible
without touching `HarnessDocWorkflow` (the hard constraint only names that workflow's body).
But it is not a "narrow" change: it requires a new `workflow.patched` era, careful semantics
for what an idle timeout means for `_pending`/`carried_*` state across `continue_as_new`,
and — most importantly — a judgment call on what "idle" safely means for a still-legitimate,
long-running consultation (the workflow's own docstring already warns that a document
workflow "can sit at a clinician gate with a 24-hour SLA", so a naive idle timeout risks
false-positive-cancelling a loop that is correctly waiting). It would also make the
already-built, already-tested `loop-cancel` machinery (TASK-670) permanently dead code —
noted, per the ticket's own framing, as "its own kind of debt," not disqualifying on its
own, but not a reason to prefer (c) over doing (b) properly either. Not adopted as a
substitute for (b); see §5 for why it is also not adopted as an "interim guard."

## 4. Decision

**(b). Abandonment is a distinct lifecycle concept from `CLOSED` and must not be built
unilaterally.** The deliverable of this ticket is this design document plus the evidence
above, not a new lifecycle status or a wired caller. Building the actual feature needs
product sign-off on the questions in §5 (naming, UI affordance, whether it is
clinician-visible, what happens to `REOPENED` semantics if the record can now also be
"abandoned").

## 5. Design for the Eventual Feature (not implemented — for product review)

If/when this is picked up as its own ticket:

1. **New `ConsultationStatus` enum member(s).** Candidates: `ABANDONED` (matches the
   harness-side wording already used in `HarnessLoopCancelSignal`'s docstring and
   `gate_sla_abandoned`) or `CANCELLED`. Requires a Prisma migration
   (`packages/database/src/prisma/db_main/enums.prisma`) and, if it emits a sys-event, the
   dual-file `ResourceType` update (`audit.prisma` + `ResourceType.ts` generated enum) per
   rule 03 §Adding a New Domain Model.
2. **A genuinely distinct trigger**, not reuse of `close()`. Two credible shapes:
   - **Explicit clinician action** — a new `POST :id/abandon` (or `:id/cancel`) route,
     symmetric to `close`/`reopen`, that both flips a lifecycle marker AND calls
     `LoopContextSignalService.signalLoopCancel(id, { reason })` in the same request. Safe
     by construction because it is a NEW, single-purpose action — no ordering ambiguity
     with `recording/stop`.
   - **Systemic idle-abandonment sweep** — a scheduled job (does not exist today; would be
     new infrastructure) that finds consultations idle past a threshold in a state that
     implies nobody is coming back (e.g. `OPEN` with no `RECORDING` transition and no
     context items for N hours) and calls the same signal. This is materially the same
     shape as option (c)'s idle timeout but implemented as an external, observable,
     product-configurable policy rather than buried inside workflow determinism rules —
     easier to reason about, test, and tune without a Temporal patch era.
3. **Fix the `_cancelled`-before-`_ending` precedence in `ConsultationLoopWorkflow.run()`
   BEFORE wiring any caller.** §2.2's race is dormant today only because nothing calls
   `cancel`; the moment either shape above ships, it becomes live. The fix belongs to that
   future ticket (it touches `workflows.py`, needs a `workflow.patched` id, and must be
   proven against the replay-compat suite) — flagging it here so it is not rediscovered the
   hard way.
4. Whichever trigger is chosen must decide how it interacts with `REOPENED` — can an
   "abandoned" consultation be reopened the way a `CLOSED` one can? If yes, does reopening
   restart the loop, or is the loop cancellation permanent regardless of the record's own
   lifecycle?

## 6. Why No Interim Guard Was Added

Phase 2 of the ticket allows, "if and only if it is clearly safe," a narrow interim guard
so abandoned loops do not run indefinitely, even when the main decision is (b). I looked for
one and did not find one that is *clearly* safe:

- Wiring `signalLoopCancel` anywhere in the existing lifecycle surface (`close`, `reopen`,
  `update`) inherits the exact race in §2.2 — not narrow, and directly risks the "no note
  may be lost" hard constraint.
- Fixing the `_cancelled`/`_ending` precedence bug in `ConsultationLoopWorkflow.run()` is
  safe in isolation (today's behavior is unchanged because nothing calls `cancel`, so the
  fix is dormant), but it requires a new `workflow.patched` era, a review against Temporal
  determinism rules, and verification against the replay-compat suite for a workflow the
  ticket explicitly asks me to treat with the same care as `HarnessDocWorkflow` — not the
  "narrow" scope this section calls for, and it does not reduce today's orphaned-workflow
  exposure (§2.4 already shows that exposure is currently zero, since `HARNESS_LOOP_ENABLED`
  is off everywhere). It is recorded as a **must-fix prerequisite** in §5.3 for whoever
  implements the real feature, not shipped speculatively here.
- An idle timeout inside the workflow (option (c)) is, as established in §3, a real design
  decision with its own false-positive risk against the legitimate 24h clinician-gate wait
  — not something to bolt on as a side effect of a design-only ticket.

**No code was changed in `packages/applications`, `apps/api`, or `apps/harness`.** The
"narrow interim guard" bar was not met by anything I could construct that also survives the
hard constraint against clinical data loss.

## 7. TDD — Not Applicable

No RED tests were written because no feature code was written (Phase 1 concluded (b); Phase
2's instruction for (b) is "the deliverable is the design document" — TDD applies to the
eventual implementation ticket, not this one).

## 8. Implementation Summary

**No feature code was written.** Phase 1's investigation (§2) concluded (b) — abandonment
is a distinct lifecycle concept that must not be built unilaterally — which the ticket
explicitly names as a correct, non-failure outcome. The deliverable is:

- This README: the Phase 1 evidence (§2), the three-option evaluation (§3), the decision
  (§4), and the design for the eventual feature for product review (§5).
- The explicit reasoning for shipping no interim guard (§6), including one finding worth
  carrying into whichever ticket implements §5 — the `_cancelled`-before-`_ending`
  precedence in `ConsultationLoopWorkflow.run()` (`workflows.py:2034-2038`) must be fixed
  before any caller of `signalLoopCancel` is wired, or the fix for THIS ticket's stated
  problem would introduce a worse one (silently dropping a clinical note).

**Files changed:** none in `packages/database`, `packages/domains`, `packages/applications`,
`apps/api`, or `apps/harness`. Only this ticket README was added.

**Migrations:** none — Phase 1 concluded a migration is not warranted without product
sign-off on the new lifecycle state's name/semantics (§5.1), consistent with the ticket's
own constraint that a migration is acceptable only if Phase 1 concludes (b) **and** that is
stated explicitly, which it now is.

**API changes:** none.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-12 | Initial investigation and design document. Phase 1 evidence gathered against `dev-2.1` @ `baeb7d49b`; decision (b); no code changes. |

## 10. Gate Evidence

No `packages/applications`, `apps/api`, or `apps/harness` source files were modified.
Baselines below are captured to confirm the worktree (freshly reset to `dev-2.1` @
`baeb7d49b`, dependencies freshly installed) is green and unaffected by this ticket's
(absence of) changes.

<!-- gate evidence appended below by the agent after running the commands -->
