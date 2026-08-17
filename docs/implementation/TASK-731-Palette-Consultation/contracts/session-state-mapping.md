# TASK-731 — Session-state ↔ interpreter-phase mapping (Phase A, Task 3)

**The state machine is authoritative. The interpreter never writes `Consultation.status`
directly — it requests a transition through `ConsultationEntity.transitionTo` via a gateway
activity, and reads the current phase through a query. A rejected transition is an error the run
surfaces, never a silent skip.**

Re-verified against the LANDED `ConsultationEntity.transitionTo` legality matrix
(`packages/domains/src/entities/generated/core/ConsultationEntity.ts:25-90`), which differs from
the README's own anticipated shape (11 status members, not 7+3; `CLOSED_COMPLETE`/
`CLOSED_INCOMPLETE` split the old `CLOSED`) — see `palette-contract.md` §0.

| Interpreter event | Requested transition | Legal per `CONSULTATION_TRANSITIONS`? | Notes |
|---|---|---|---|
| `consultation.consentGate` SUCCEEDED | `OPEN → PRIMED` | Yes — `OPEN → {PRIMED}` (`:29`) | Guard: consent asserted (the activity's own `ConsentDecision.allowed`). |
| `consultation.captureBinding` (`livedoc_start`) SUCCEEDED | `PRIMED → RECORDING` | Yes — `PRIMED → {RECORDING, CLOSED_INCOMPLETE}` (`:31-34`) | |
| `consultation.captureBinding` (`livedoc_stop`) SUCCEEDED | `RECORDING → DRAINING` | Yes — `RECORDING → {DRAINING}` (`:35`) | |
| Draft persisted early (optimistic delivery on) | `DRAINING → DRAFT_PENDING_SENSORS` | Yes — `DRAINING → {..., DRAFT_PENDING_SENSORS, ...}` (`:37-43`) | |
| Draft persisted, no early delivery | `DRAINING → PENDING_REVIEW` | Yes — same row, `PENDING_REVIEW` is also a member of `DRAINING`'s target set | |
| `consultation.finalizeAssurance` SUCCEEDED | `DRAFT_PENDING_SENSORS → PENDING_REVIEW` | Yes — `DRAFT_PENDING_SENSORS → {PENDING_REVIEW, SIGNED, CLOSED_INCOMPLETE}` (`:45-50`) | |
| Gate SLA exhausted (terminal abandon) | `PENDING_REVIEW → TIMED_OUT` | Yes — `PENDING_REVIEW → {SIGNED, TIMED_OUT}` (`:52-54`) | Pairs with WORM `SESSION_TIMED_OUT` + notification (unchanged from README). |
| Gate approved | **No transition requested** | — | `SIGNED` is written only by `approveSummary` (`summary.service.ts:978`), outside the substrate — `palette-contract.md` §1.4. |
| Any node terminal `DEGRADED` | Append to `Consultation.degradedReasons`; **phase unchanged** | N/A (not a `transitionTo` call) | `IConsultationEntity.degradedReasons` (`:117`) — a health-flag projection, not a state. |
| `TIMED_OUT` later resolved (clinician still signs) | `TIMED_OUT → SIGNED` | Yes — `TIMED_OUT → {SIGNED, REOPENED, CLOSED_INCOMPLETE}` (`:61-67`) | Outside the interpreter's own event set (driven by the same `approveSummary` HTTP path as any other sign), listed for completeness since it is the row a timed-out run's eventual resolution actually uses. |

## Rows this palette does NOT drive (listed so a future reader does not have to re-derive it)

- `PENDING_REVIEW → DRAFT_PENDING_SENSORS` — **reserved but DISABLED**
  (`RESERVED_DISABLED_TRANSITIONS`, `:84-90`, owning epic `'note-sections'`). No interpreter event
  maps to it. If a future rule needed it, that is a finding against the `note-sections` epic, not
  a row to add here (README's own instruction, restated).
- `CLOSED` — dead, superseded, zero outgoing edges (`:69-71`). Never a `transitionTo` target
  anywhere, including from this palette.
- `SIGNED → REOPENED`, `SIGNED → CLOSED_COMPLETE`, `CLOSED_COMPLETE/CLOSED_INCOMPLETE → REOPENED`,
  `REOPENED → PENDING_REVIEW`/`CLOSED_INCOMPLETE` — all legal rows in the matrix, none driven by an
  interpreter event; they belong to manual close/reopen flows outside this ticket's scope.
- `PAUSED` — never added to `ConsultationStatus` (TASK-711 §1 deferred it); correctly, no
  interpreter event maps to it here either.

## Illegal-transition handling

`transitionTo` throws `BusinessException` (or the RESERVED_DISABLED variant, which the entity
throws with the owning epic named — not yet independently re-verified this pass which exact
exception TYPE the reserved-disabled path throws; the gateway activity that calls it, per §Task 12
below, must NOT be attempted this pass — see README §7) on any pair not in the matrix. The
gateway-side activity that wraps `transitionTo` (Task 12, NOT implemented this pass — §7) must
propagate that as a run-terminal error naming the illegal `(from, to)` pair, never continue as if
the transition happened. This document specifies the contract; it does not implement Task 12 or
Task 13 (see `palette-contract.md` §7 and the ticket README §7 for what remains).

## Which mappings are `guarded` vs `recorded` (TASK-711 vocabulary)

Not independently re-verified against TASK-711's own state-machine.md this pass (out of the file
set actually read) — flagged rather than guessed. The gateway activity built in a future Task 12
pass must confirm this distinction against `state-machine.md` before wiring the guard condition
for `OPEN → PRIMED` (listed above as "guard: consent asserted") into code.
