# TASK-711 — Consultation Session State Chart & Legality Matrix

Status: **revised 2026-08-16 — owner decisions on Q1/timeout incorporated** (see §1a below).
Database layer (this document + `enums.prisma` + migrations) is owner for this pass; domain-layer
(`CONSULTATION_TRANSITIONS` in `ConsultationEntity.ts`) still reflects the pre-revision design
(generic `CLOSED`) and needs a follow-up pass to consume `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` —
flagged in README §7, not silently left inconsistent.

This document is derived from README.md §4 Task 1, revised per the owner's answers to §6 Q1/Q2/Q3
and the follow-on instruction on session timeouts (README §7/§8 Change History has the exact
wording). §1/§2 below are the **current** design; the original (`CLOSED`-only) design is preserved
in git history for anyone auditing the change.

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
| 9 | ~~`CLOSED`~~ | Closed | **SUPERSEDED before ever going live** | Split into two terminal members per owner decision (§1a) — never targeted by `transitionTo`. Retained in the enum only because Postgres cannot drop a value; this migration never applied to a real environment before the split, so nothing is "un-resurrecting" it — it simply stays what it always was, dead, but now *deliberately and documented* rather than an A-46 oversight |
| 9a | `CLOSED_COMPLETE` | *(none — new split of "Closed")* | **adopted, NEW** | A human gave clinical feedback (signed the note) before the record closed |
| 9b | `CLOSED_INCOMPLETE` | *(none — new split of "Closed")* | **adopted, NEW** | The record closed — by a timeout sweep or a manual admin close — with no clinical sign-off ever recorded. Replaces the speculative `ABANDONED` member from §6 Q1: same real-world case, better name (the record isn't "abandoned" as a *resource* — `resourceStatus` still governs that — it is clinically *incomplete*) |
| 10 | `REOPENED` | *(stories only, UC-12)* | adopted, **resurrected** | The reference's own inconsistency; the member already exists in the enum |
| — | *(none)* | **Degraded** | **REJECTED as a state** | → `Consultation.degradedReasons String[]`. The reference models it as a one-row transient while every other row is durable |
| — | *(none)* | **Paused** | **DEFERRED** | No server-side writer exists (A-20 — the only pause is client-local React state in `useArcaSessionManager.ts:192-199`). Shipping it now recreates A-46 (an enum member with no writer). Transitions are specified below reserved-but-disabled; the member itself is appended in one line by the `checkpoint-resume` epic |

All 12 reference states (11 `dataset.xml` Times + `REOPENED` from UC-12) are accounted for exactly
once above; `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` have no reference-state counterpart of their own
— they are a refinement of reference state #9 ("Closed"), not a 13th reference concept.

**Enum membership.** `ConsultationStatus` now has 12 members:
`OPEN, PRIMED, RECORDING, DRAINING, DRAFT_PENDING_SENSORS, PENDING_REVIEW, SIGNED, TIMED_OUT,
CLOSED (superseded, dead), REOPENED, CLOSED_COMPLETE, CLOSED_INCOMPLETE`. 11 of the 12 are live
targets; `CLOSED` is the one documented, deliberate exception. `PAUSED` is **not** added by this
ticket.

### 1a. Owner decision — `CLOSED_COMPLETE` / `CLOSED_INCOMPLETE` instead of `ABANDONED` (§6 Q1)

README §6 Q1 asked whether the backfill's "closed but never signed" bucket needs a distinct
`ABANDONED` member. The owner's answer, verbatim: *"We need sessions to be timed-out, the state
must be somehow CLOSED_INCOMPLETE - that there is no human feedback, or CLOSED_COMPLETE, that
there is a human feedback to close the session properly."*

This is a strictly better answer than `ABANDONED` for three reasons: (1) it names the *general*
mechanism — every path to a terminal closed state, not just the backfill's one bucket — so
`TIMED_OUT → CLOSED` (which already existed in the pre-revision matrix, reachable without a
signature) gets the same correct treatment as the backfill rows; (2) it keeps `resourceStatus`
doing record-lifecycle work and `status` doing clinical-lifecycle work, which is exactly the
distinction §2's "two answers this matrix forces" already established — a third overloaded meaning
("abandoned" as *both* a resource state and a clinical outcome) does not need to exist; (3) it
gives Task 12's backfill a real typed home for the `OPEN + meta=CLOSED + unsigned` bucket instead
of the resourceStatus-only `ARCHIVED` workaround — see backfill-mapping.md §3, revised.

**Session timeout — settings-registry value, not a hardcoded constant, plus a scheduled sweep.**
Per the same instruction, "the timeout window must be a settings-registry value with a documented
default... plus a scheduled sweep transitioning stale sessions to `CLOSED_INCOMPLETE`." This is an
**application/worker-layer feature** (a `SettingDescriptor` + a cron/Temporal sweep), out of
`packages/database`'s ownership — this document specifies the design so the next phase implements
against a fixed contract rather than inventing one:

| Field | Value | Rationale |
|---|---|---|
| Descriptor key | `consultation.state.sessionTimeoutMinutes` | Mirrors `consultation.state.requirePrimedBeforeRecording` naming (README §4 Task 9) |
| Tier | `global-kv` (`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers) | A platform-wide tuning knob, not a secret, not per-tenant — the SLA is a platform policy |
| `failMode` | `open-to-default` | A tuning knob, not a secret or provider/model selection — an absent value must not fail closed and stall every sweep run |
| Documented default | **1440 minutes (24h)** | No existing SLA constant for *general session idleness* was found in the repo (the harness gate's own SLA, which drives `PENDING_REVIEW → TIMED_OUT`, is a separate, already-existing mechanism — see below); 24h is a conservative, clinically-safe starting point that a product owner can tune down once real abandonment-rate data exists. Document it as provisional, not final |
| Sweep-eligible states | `PRIMED, DRAINING, DRAFT_PENDING_SENSORS, TIMED_OUT, REOPENED` | States where clinical work started (so there is something to be "incomplete") but no note is fixed yet. `RECORDING` is deliberately **excluded** — an active capture session is not "idle" by definition, and force-terminating live audio is a distinct failure mode outside this ticket. `PENDING_REVIEW` is deliberately **excluded** from the *general* sweep — it already has its own dedicated, narrower SLA path (`PENDING_REVIEW → TIMED_OUT`, existing/unchanged) which is the harness gate's concern, not the general idle-session concern; `TIMED_OUT` itself is in the general sweep's set precisely so a timed-out gate that *also* goes unattended past the general window still terminates |
| Sweep-**in**eligible | `OPEN` | Preserves the existing answer in §2 ("How do I abandon an `OPEN` consultation?" → `repository.softDelete(id)`) unchanged. A consultation that was never even primed has no clinical content to be "incomplete" about — this is a resource-lifecycle concern, not a clinical one, exactly the distinction §1a's first rationale point makes |
| Mechanism (not built this pass) | A scheduled job (NestJS `@Cron` in `packages/applications` or a Temporal workflow in `apps/harness`, whichever the implementing phase's owner prefers — no existing periodic-sweep precedent was found to bind this choice) queries for sweep-eligible-state rows whose most recent `updatedAt` (or a dedicated `lastActivityAt`, if the implementing phase decides `updatedAt` is too coarse) exceeds the descriptor's window, then calls `entity.transitionTo(CLOSED_INCOMPLETE, 'system', 'session-timeout-sweep')` per row | Reuses the existing `updateWithVersion` + sys-event + WORM pattern this ticket already establishes for every other transition — no new persistence mechanism |

---

## 2. Legality matrix

One row per legal transition. Every unlisted `(from, to)` pair throws. `enforcement`:
`guarded` = a precondition is checked; `recorded` = unconditional but still routed through
`transitionTo` (for auditability and the single-writer guarantee).

| from | to | guard | trigger | enforcement | events |
|---|---|---|---|---|---|
| `OPEN` | `PRIMED` | consent asserted (TASK-712 wires the real assertion; a no-op stub here) | clinician (owner), `POST :id/prime` | guarded | `ResourceUpdated` + WORM `SESSION_PRIMED` |
| `PRIMED` | `RECORDING` | **flagged precondition** — `consultation.state.requirePrimedBeforeRecording` kill-switch, default OFF | clinician (owner), `POST :id/recording/start` | guarded (flag-gated) | `ResourceUpdated` |
| `RECORDING` | `DRAINING` | — | clinician (owner), `POST :id/recording/stop`, **or** system (consent revoked mid-capture — TASK-712 enforcement is explicitly permitted to force this same edge; in-flight capture is allowed to reach `DRAINING`, never held at `RECORDING`) | recorded | `ResourceUpdated` |
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
| `CLOSED_COMPLETE` | `REOPENED` | — | owner or `manage:Consultation` | recorded | `ResourceUpdated` + WORM `SESSION_REOPENED` |
| `CLOSED_INCOMPLETE` | `REOPENED` | — | owner or `manage:Consultation` — authority is preserved identically for both terminal-closed variants (§6 Q2) | recorded | `ResourceUpdated` + WORM `SESSION_REOPENED` |
| `REOPENED` | `PENDING_REVIEW` | — | system, on resumed HITL | recorded | `ResourceUpdated` |
| `SIGNED` | `CLOSED_COMPLETE` | — | owner or `manage:Consultation`, `POST :id/close` — a human gave clinical feedback (the signature) before this close | recorded | `ResourceUpdated` + WORM `SESSION_CLOSED_COMPLETE` |
| `TIMED_OUT` | `CLOSED_INCOMPLETE` | session-timeout window elapsed with no clinician sign-off, **or** manual `POST :id/close` before the sweep fires | system (scheduled sweep, `consultation.state.sessionTimeoutMinutes` — §1a) **or** owner/`manage:Consultation` (manual close preserves existing authority, §6 Q2) | recorded | `ResourceUpdated` + WORM `SESSION_CLOSED_INCOMPLETE` |
| `PRIMED` \| `DRAINING` \| `DRAFT_PENDING_SENSORS` \| `REOPENED` | `CLOSED_INCOMPLETE` | session-timeout window elapsed with no clinician activity (§1a "sweep-eligible states") | system (scheduled sweep) | recorded | `ResourceUpdated` + WORM `SESSION_CLOSED_INCOMPLETE` |
| *any* | *itself* | — | any | no-op | **none** — idempotent, no write, `entity.hasChanges === false` |

22 legal, non-reflexive transitions (the reflexive self-transition row applies to all 12 members,
including the superseded `CLOSED`, which is still a no-op self-transition even though it is never a
legal `to`). Every adopted member appears as a `to` at least once **except** `OPEN` (a consultation
is *created* in `OPEN`, never transitioned into it — unchanged) and `CLOSED` (superseded, §1 row 9
— documented and deliberate, not an oversight). When Task 11's wiring gate is built (a later
phase), it must allow-list `CLOSED` explicitly as the one intentional exception, or it will
(correctly, per its own stated purpose) flag it — the gate should assert *"every member is wired,
or is named in a documented supersession list,"* not just *"every member is wired."*

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
- **"How do I close an unsigned consultation?"** — revised by the owner's §6 Q1 answer: you now
  *can*, but the record types itself honestly as `CLOSED_INCOMPLETE` rather than the plain
  `CLOSED` INV-174/175 originally named — the invariant's *intent* (a signed close and an unsigned
  close must never be indistinguishable) is preserved, its *literal wording* (naming a single
  `CLOSED` member) is updated to name the split. `CLOSED_COMPLETE` is reachable only from `SIGNED`
  (a human gave feedback); `CLOSED_INCOMPLETE` is reachable only from `TIMED_OUT` or from the
  narrower sweep-eligible set in §1a (no human feedback ever recorded). Neither is reachable from
  `OPEN` directly — the first answer above is unchanged for a session that never even started.

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

This is a closed, platform-owned vocabulary (README §6 Q3, confirmed as this pass's design call: "a
closed platform-owned union is simpler and filterable" — matches the standard house pattern for
enum-like string fields, e.g. `HarnessAuditAction`/`NotificationType`, which are also
platform-owned Prisma enums rather than tenant-extensible tables; revisit only if the Studio's runs
tab needs tenant-defined reasons — not needed today).

---

## 4. Backfill mapping

See [backfill-mapping.md](./backfill-mapping.md) — the observed-distribution query and per-bucket
target mapping are a separate document per the Verify criteria.

---

## 5. Traceability to the invariant register

| Mechanism | Invariants | Where in this chart |
|---|---|---|
| `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` reachable only from `SIGNED` / `TIMED_OUT` (or the narrower sweep set) — never directly from `OPEN` | INV-174, INV-175 (wording updated per §1a/§2 "two answers", owner-approved split) | §2 matrix rows `SIGNED→CLOSED_COMPLETE`, `TIMED_OUT→CLOSED_INCOMPLETE`, sweep-set `→CLOSED_INCOMPLETE`; no `→CLOSED` (legacy) row exists |
| Distinct, persisted, visibly-unsigned `TIMED_OUT` + notification | INV-177, INV-181, INV-182, INV-183, INV-413, INV-255, INV-147 | §2 `PENDING_REVIEW→TIMED_OUT` row (WORM + notification); `TIMED_OUT` carries no `ATTEST`/`SIGNED_NOTE` |
| `TIMED_OUT → SIGNED` remains legal | INV-413, INV-161, INV-162 | §2 `TIMED_OUT→SIGNED` row, marked "legal by design" — unaffected by the `CLOSED` split; a human can still rescue a timed-out gate all the way to a proper `CLOSED_COMPLETE` close |
| `RECORDING` unreachable before `PRIMED` | INV-003, INV-004, INV-201 | §2 `PRIMED→RECORDING` is the only `→RECORDING` row (besides `DRAINING→RECORDING` re-arm, which already presupposes having been `PRIMED` once) |
| `DRAINING` as a persisted phase; consent revocation may force `RECORDING→DRAINING` | INV-121, INV-122, INV-124, INV-125, INV-130, INV-357 | §1 row 4; §2 `RECORDING→DRAINING` replaces the old revert-to-`OPEN` and explicitly names the TASK-712 consent-revocation trigger alongside the manual stop |
| `degradedReasons` flags ORed onto the active phase | INV-072, INV-073 | §3 |
| Single-sourced terminal representation | [ADDED-1] | §2 — every transition, including the two `CLOSED_*` terminals and `REOPENED`, routes through the one matrix; `metadata.status` is deleted (Task 10) |
| Session must time out; terminal state names whether a human gave feedback | §6 Q1 owner answer (no invariant register ID — a new requirement introduced by this decision, not a pre-existing INV) | §1a (settings-registry timeout design) + §2 sweep rows |
