# TASK-711 — Consultation Session State Chart & Legality Matrix

Status: **authored, pending owner review** (README §Phase 0 Task 1 gate — Task 2 does not start
until this is reviewed and approved by the ticket owner; database/domain-layer work in this ticket
was executed in parallel against the design already fixed by
[04-target-architecture.md](../../architecture/consultation-session-workflow/assessment/04-target-architecture.md)
§1 and [design.md](../../architecture/agentic-workflow-platform/design.md) §Error handling, per the
ticket's own instruction to "reproduce it, do not re-litigate it").

This document is derived entirely from README.md §4 Task 1 — it is not a new design, it is that
design written down as its own artifact per the Verify criteria ("both documents exist").

---

## 1. State chart — reference state → adopted member

Reference states are `dataset.xml` Times 0–24 (Open, Primed, Streaming, Degraded, Paused,
Draining, Drafting, Awaiting Review, Closed Approved, Closed, Timed Out) plus `REOPENED`, which
appears only in `user-stories-and-use-cases.md` UC-12.

| # | Adopted member | Reference state | Verdict | Rationale |
|---|---|---|---|---|
| 1 | `OPEN` | Open | adopted, exists | — |
| 2 | `PRIMED` | Primed | **adopted, NEW** | Zero `Primed` hits repo-wide; the state consent/ABAC hangs on (TASK-712) |
| 3 | `RECORDING` | Streaming | adopted, **renamed** | Code name wins; `Streaming` is the reference's word for the same phase |
| 4 | `DRAINING` | Draining | **adopted, NEW** | Also fixes `stopRecording`'s revert-to-`OPEN` erasure (§2.1 of the ticket's Current State Evaluation) |
| 5 | `DRAFT_PENDING_SENSORS` | Drafting | adopted, **renamed** | — |
| 6 | `PENDING_REVIEW` | Awaiting Review | adopted, **renamed** | — |
| 7 | `SIGNED` | Closed Approved | adopted, **renamed** | The keystone. Write site untouched (`summary.service.ts:978`) |
| 8 | `TIMED_OUT` | Timed Out | **adopted, NEW** | Terminal *absent explicit reopening*, not terminal |
| 9 | `CLOSED` | Closed | adopted, **resurrected** | Housekeeping follow-on; guarded so it presupposes `SIGNED`/`TIMED_OUT` |
| 10 | `REOPENED` | *(stories only, UC-12)* | adopted, **resurrected** | The reference's own inconsistency; the member already exists in the enum |
| — | *(none)* | **Degraded** | **REJECTED as a state** | → `Consultation.degradedReasons String[]`. The reference models it as a one-row transient while every other row is durable |
| — | *(none)* | **Paused** | **DEFERRED** | No server-side writer exists (A-20 — the only pause is client-local React state in `useArcaSessionManager.ts:192-199`). Shipping it now recreates A-46 (an enum member with no writer). Transitions are specified below reserved-but-disabled; the member itself is appended in one line by the `checkpoint-resume` epic |

All 12 reference states (11 `dataset.xml` Times + `REOPENED` from UC-12) are accounted for exactly
once above.

**Enum membership.** `ConsultationStatus` now has 10 members:
`OPEN, PRIMED, RECORDING, DRAINING, DRAFT_PENDING_SENSORS, PENDING_REVIEW, SIGNED, TIMED_OUT,
CLOSED, REOPENED`. `PAUSED` is **not** added by this ticket.

---

## 2. Legality matrix

One row per legal transition. Every unlisted `(from, to)` pair throws. `enforcement`:
`guarded` = a precondition is checked; `recorded` = unconditional but still routed through
`transitionTo` (for auditability and the single-writer guarantee).

| from | to | guard | trigger | enforcement | events |
|---|---|---|---|---|---|
| `OPEN` | `PRIMED` | consent asserted (TASK-712 wires the real assertion; a no-op stub here) | clinician (owner), `POST :id/prime` | guarded | `ResourceUpdated` + WORM `SESSION_PRIMED` |
| `PRIMED` | `RECORDING` | **flagged precondition** — `consultation.state.requirePrimedBeforeRecording` kill-switch, default OFF | clinician (owner), `POST :id/recording/start` | guarded (flag-gated) | `ResourceUpdated` |
| `RECORDING` | `DRAINING` | — | clinician (owner), `POST :id/recording/stop` | recorded | `ResourceUpdated` |
| `DRAINING` | `RECORDING` | — | clinician (owner), re-arm capture in the same visit | recorded | `ResourceUpdated` |
| `DRAINING` | `DRAFT_PENDING_SENSORS` | — | system (`persistDraft`, early-delivery path) | recorded | `ResourceUpdated` |
| `DRAINING` | `PENDING_REVIEW` | — | system (`persistDraft`, legacy/non-early path) | recorded | `ResourceUpdated` |
| `DRAFT_PENDING_SENSORS` | `PENDING_REVIEW` | — | system (`finalizeAssurance`) | recorded | `ResourceUpdated` |
| `DRAFT_PENDING_SENSORS` | `SIGNED` | authenticated human; existing `approveSummary` business gates | clinician, `POST :id/summary/:ctxId/approve` | guarded (unchanged, pre-existing) | existing `ATTEST` (+ `SIGNED_BEFORE_ASSURANCE`) |
| `PENDING_REVIEW` | `SIGNED` | as above | clinician | guarded (unchanged, pre-existing) | existing `ATTEST` |
| `PENDING_REVIEW` | `TIMED_OUT` | gate SLA exhausted | system (`recordEscalation`, terminal `GATE_ABANDONED`) | guarded | `ResourceUpdated` + WORM `SESSION_TIMED_OUT` + clinician notification |
| `TIMED_OUT` | `SIGNED` | as above — **legal by design; the clock never signs, a human still can** | clinician | guarded (unchanged, pre-existing) | existing `ATTEST` |
| `TIMED_OUT` | `REOPENED` | — | owner or `manage:Consultation` | recorded | `ResourceUpdated` + WORM `SESSION_REOPENED` |
| `SIGNED` | `REOPENED` | — | owner or `manage:Consultation` | recorded | `ResourceUpdated` + WORM `SESSION_REOPENED` |
| `CLOSED` | `REOPENED` | — | owner or `manage:Consultation` | recorded | `ResourceUpdated` + WORM `SESSION_REOPENED` |
| `REOPENED` | `PENDING_REVIEW` | — | system, on resumed HITL | recorded | `ResourceUpdated` |
| `SIGNED` | `CLOSED` | — | owner or `manage:Consultation`, `POST :id/close` | recorded | `ResourceUpdated` |
| `TIMED_OUT` | `CLOSED` | — | as above | recorded | `ResourceUpdated` |
| *any* | *itself* | — | any | no-op | **none** — idempotent, no write, `entity.hasChanges === false` |

17 legal, non-reflexive transitions; the reflexive (self-transition) row applies to all 10 members.
Every one of the 10 adopted members appears as a `to` at least once (`OPEN` is the sole exception —
it has no legal predecessor other than itself, which is correct: a consultation is *created* in
`OPEN`, never transitioned into it). This is the property Task 11's wiring gate checks.

**Reserved but disabled** (the matrix names them; `transitionTo` throws an error naming the epic
that will enable them, rather than silently accepting or silently rejecting):

- `PENDING_REVIEW → DRAFT_PENDING_SENSORS` — per-section HITL return-for-regen; belongs to
  `note-sections`.
- Every `PAUSED` edge — belongs to `checkpoint-resume`.

### The two answers this matrix forces

- **"How do I abandon an `OPEN` consultation?"** — `repository.softDelete(id)`.
  `resourceStatus` is the *record* lifecycle; `status` is the *clinical* lifecycle. Conflating
  them is what produced A-13 (a never-recorded consultation being "closed" through the untyped
  `metadata.status` tracker with no relationship to whether it was ever signed).
- **"How do I close an unsigned consultation?"** — you cannot. `CLOSED` is reachable only from
  `SIGNED` or `TIMED_OUT` (INV-174, INV-175).

---

## 3. Health flags — `degradedReasons` vocabulary

`degradedReasons String[]` is a filterable projection on the *active* phase, not a state of its
own (design.md §Error handling: "Timeout force-stops that node only; 'Degraded' is health flags,
not a state"). Append-only within a session (no duplicates); cleared unconditionally on the
`→ SIGNED` transition (a signed note is the clinician's attestation that the record is fit,
independent of what degraded along the way).

Sourced from the per-run booleans that already exist in the harness Temporal workflow (verified
against `apps/harness/src/harness/temporal/workflows.py` and `models.py` on 2026-08-16 — exact
names, not paraphrases):

| Vocabulary member | Source | Meaning |
|---|---|---|
| `mcp_degraded` | `workflows.py:642,663,667` (`McpToolCallResult.degraded`, `models.py:491`) | An MCP tool call's server/transport errored; the call degraded rather than crashing the loop |
| `policy_degraded` | `workflows.py:440,459` | The policy-resolution pass for the run degraded |
| `retrieval_degraded` | `RetrievedContext.degraded`, `models.py:644` | A retrieval backend (embeddings/Qdrant/reranker) was down; generation proceeded on whatever context existed |
| `reduced_assurance` | `models.py:802,857,894` (`reduced_assurance: bool \| None`); OR of `policy_degraded`/`mcp_degraded` at `workflows.py:680` | The inferential (assurance) pass ran in a reduced-confidence mode |
| `sensor_degraded` | `InferentialRunOutput.degraded`, `models.py:768` | An inferential/sensor backend was unavailable for one pass; that pass excluded from the aggregate |

This is a closed, platform-owned vocabulary (README §6 Q3 — revisit only if the Studio's runs tab
needs tenant-defined reasons; not decided here).

---

## 4. Backfill mapping

See [backfill-mapping.md](./backfill-mapping.md) — the observed-distribution query and per-bucket
target mapping are a separate document per the Verify criteria.

---

## 5. Traceability to the invariant register

| Mechanism | Invariants | Where in this chart |
|---|---|---|
| `CLOSED` reachable only from `SIGNED` / `TIMED_OUT` | INV-174, INV-175 | §2 matrix rows `SIGNED→CLOSED`, `TIMED_OUT→CLOSED`; no other `→CLOSED` row exists |
| Distinct, persisted, visibly-unsigned `TIMED_OUT` + notification | INV-177, INV-181, INV-182, INV-183, INV-413, INV-255, INV-147 | §2 `PENDING_REVIEW→TIMED_OUT` row (WORM + notification); `TIMED_OUT` carries no `ATTEST`/`SIGNED_NOTE` |
| `TIMED_OUT → SIGNED` remains legal | INV-413, INV-161, INV-162 | §2 `TIMED_OUT→SIGNED` row, marked "legal by design" |
| `RECORDING` unreachable before `PRIMED` | INV-003, INV-004, INV-201 | §2 `PRIMED→RECORDING` is the only `→RECORDING` row (besides `DRAINING→RECORDING` re-arm, which already presupposes having been `PRIMED` once) |
| `DRAINING` as a persisted phase | INV-121, INV-122, INV-124, INV-125, INV-130, INV-357 | §1 row 4; §2 `RECORDING→DRAINING` replaces the old revert-to-`OPEN` |
| `degradedReasons` flags ORed onto the active phase | INV-072, INV-073 | §3 |
| Single-sourced terminal representation | [ADDED-1] | §2 — every transition, including `CLOSED`/`REOPENED`, routes through the one matrix; `metadata.status` is deleted (Task 10) |
