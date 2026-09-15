# TASK-972 — Close the consultation after summary finalize, and capture the clinician's edit as training feedback

| Field | Value |
|---|---|
| **Status** | Review — all six code lanes merged to `dev-2.2`; verified end to end against a live gateway (§5). ALaaS-side work (Lane 6) is a documented change list for the other repo, not yet built |
| **Type** | feature (+ one bugfix: TASK-933 H3-6) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-15 |
| **Ticket number** | TASK-972 — directory was reserved and empty; highest under `docs/implementation/` is TASK-975 |
| **Related** | TASK-933 (H3-6, OD-14 — the open defect this ticket closes), TASK-946 (D3 terminal state), TASK-951 (ALaaS realtime contract), TASK-974 (DNA ingest — the reusable ingest pattern) |
| **Rules** | `00`, `01`, `02`, `03`, `04`, `05`, `06`, `08`, `14` |
| **Cross-repo** | `ALaaSv3.0` (`apps/web_ui`, `apps/audio-stream-svc`) — changes there are a documented change list, not edits made from this repo |

## 1. Requirement Analysis

Owner ask (2026-09-15, verbatim):

> we need to understand when the end-user/clinician update and submit the summary > that will be
> the feedback, we need to capture the updated summaries as feedback for further model training
> action. now we need to capture the signal to close the consultation session, currently the
> durable function keep running the open sessions.

Restated:

| # | Behaviour |
|---|---|
| **R1** | The moment a clinician updates and submits a summary is captured as a first-class event in HOPE, not only in the consuming product. |
| **R2** | The `(original AI draft, clinician-edited)` pair from that moment is retained as supervised training feedback, under the platform's PHI, consent and curation rules. |
| **R3** | That same moment closes the consultation session — the row reaches a terminal state AND the governing durable execution stops. |
| **R4** | A consultation abandoned without a submit does not hold a durable execution open indefinitely. |

**R1–R3 are one event, not three.** The clinician's submit is the only moment at which the original
and the edited note both exist, the gate can be released and the session can be closed. The design
consequence is that they must be satisfied by one call path, not three independent features.

## 2. Current State Evaluation (verified 2026-09-15 on `dev-2.2` @ `9d619aeaa`)

Six read-only lanes: ALaaS `web_ui`, ALaaS `audio-stream-svc`, the two SDKs, the HOPE
consultation/summary backend, the harness Temporal layer, and the training/feedback storage side.
Every claim below carries its own evidence; orchestrator-verified claims are marked **[V]**.

### 2.1 The clinician's actual journey today

| # | Step | Where | Evidence |
|---|---|---|---|
| 1 | Recording popup opens; audio + live sections over WS | ALaaS `web_ui` → `audio-stream-svc` | `ClinicalUIPopUp` / `useClinicalLogic.js` |
| 2 | `audio-stream-svc` opens the HOPE consultation under a **service account** | `hope.consultations.open` | `src/consultation/live-plane.ts` |
| 3 | Clinician clicks Stop → WS `{type:'stop'}` → `recording.stop` on HOPE | broker | `ConsultationBrokerService.stop()` |
| 4 | HOPE: `RECORDING → DRAINING` → interpreter finalize → `ReviewGate` child → `PENDING_REVIEW` | HOPE | TASK-946 §5.1 live evidence |
| 5 | ALaaS **auto-approves** the `n_review` gate with no edited content | ALaaS | `autoApproveReviewGates()`, TASK-933 OD-14 |
| 6 | **Separately and later**, a 5 s notification poll opens a **decoupled browser tab** where the clinician actually edits and saves | ALaaS `web_ui` | `AIGeneratedSummaryPage`; no live connection to step 1 |
| 7 | Save sends the **whole document as one blob** → append-only `updated_summary` row | ALaaS Postgres | keyed by ALaaS `sessionId`/`eventId` — **no HOPE `consultationId`** |
| 8 | "Submit feedback" → `POST /api/v1/summary/feedback` → HOPE v1-compat → **404** | ALaaS | three duplicate call sites; payload carries no `original_summary` |

So the clinician's edit **never reaches HOPE at all**, and the pair that would train a model is
stranded in ALaaS's own database with no join key back to the note HOPE generated.

### 2.2 Root cause — the finish half of the consultation plane was never opened to machines

TASK-933 opened the *run* half of the realtime consultation plane to service accounts. The *finish*
half was not. From `apps/api/route-manifest.json`, the authorization oracle **[V]**:

| Route | API key | Service account |
|---|---|---|
| `POST /consultations/{id}/recording/stop` | `consultation:session:write` | `svc:consultation:session:write` |
| `PATCH /consultations/{id}/summary/{summaryId}` — the edit | `consultation:report:write` | **`[]` → 403** |
| `POST /consultations/{id}/summary/{id}/approve` — the sign-off | `consultation:session:write` | **`[]` → 403** |
| `POST /consultations/{id}/close` | `consultation:session:write` | **`[]` → 403** |

Deny-by-default on an absent scope declaration (`05-nestjs-api.md` §API Test Standard), so these are
403s today, not oversights that happen to work. ALaaS is *structurally unable* to submit the edit,
sign the note, or close the session — which is precisely why it keeps the note locally and
auto-releases the gate instead.

`@arcaai/vox-node` compounds it: `close`, `approve`, `summary/{id}/versions` and `diff` are not
wrapped at all. `close` is real and OCC-guarded at the gateway — proven because the **browser** SDK's
`useArcaSession().close()` already calls it — so this is an SDK-surface gap, not a missing capability.
Both SDKs are at **3.4.0**, matching ALaaS's pin: there is no version gap to close (`.claude/rules/08-vox-sdk.md` still says 3.1.0 and is stale).

### 2.3 Why the durable execution keeps running — two substrates, one wired

Consultations run on one of two exclusive substrates (`Consultation.metadata.governingEngine`):

| Substrate | Workflow | Close signal | Wired to? |
|---|---|---|---|
| **A** | `ConsultationLoopWorkflow` / `HarnessDocWorkflow` | `consultationEnding` | `recording/stop` — **yes** |
| **B** | `WorkflowInterpreter` (tenant workflows, incl. all ArcaAI) | `cancel` only | **nothing** |

`SummaryService.approveSummary` forwards the sign-off to
`POST /internal/workflows/{consultationId}/signal/approve`, documented in `internal.py:8-9` as
forwarding "to the running workflow's `approval` signal" — i.e. `harness-doc-<consultationId>`,
**Substrate A**. On a Substrate-B consultation that execution does not exist and the failure is
swallowed (`summary.service.ts:1341`) **[V]**. This is TASK-933 **H3-6**, still open.

Three further findings bound the blast radius:

1. **`PENDING_REVIEW` is deliberately never swept** — `consultation-timeout-sweep.service.ts:52` **[V]**:
   *"`OPEN` and `PENDING_REVIEW` are deliberately never swept here"*. TASK-946's note that stranded
   consultations "will exit through the 1,440-minute sweep" does **not** hold for the state ALaaS
   consultations actually park in. They stay `PENDING_REVIEW` indefinitely.
2. **The sweep cannot end an execution anyway** — it holds no Temporal client, so a swept row and a
   live workflow simply disagree.
3. **The orphan path is unguarded and is the likeliest source of the reported symptom** — if the
   browser disappears without sending `stop`, ALaaS tears down locally after a 60 s grace and never
   notifies HOPE. The interpreter then sits in its live-handoff poll (bounded at 2 h) with `OPEN`
   counting as still-live; `signalLoopCancel` still has **no production caller**.

### 2.4 The training-feedback store already exists — and receives nothing from ALaaS

`GateEditExemplar` (`harness.prisma:466-524`) already mines PHI-redacted `(original, edited)` pairs,
classifies edit burden (`APPROVED_CLEAN` / `HEAVILY_EDITED`), gates on human curation, and exports a
versioned JSONL fine-tuning corpus (`hope.gate-edit.finetune.v1`, `provenance: 'CLINICIAN_EDIT'`) at
`GET admin/gate-edit-exemplars/fine-tuning-export`. **Do not build a second training store.**

It is enqueued from exactly one place: `approveSummary` (`summary.service.ts:1371`) **[V]**. No
sign-off ⇒ no `ATTEST` ⇒ no exemplar. **ALaaS therefore contributes zero training pairs today**, and
will continue to contribute zero even if the close signal alone is fixed.

Two further gaps that a plan must not paper over:

- **`DocumentSection` edits are unrecoverable and unmined** — no version table, and the sys-event body
  deliberately excludes content. A section-authored tenant produces no training pairs at all. ALaaS
  currently saves whole-document blobs, so this is latent rather than active, but the new
  `ConsultationWorkspace` is per-section.
- **No consent check exists anywhere in the mining pipeline** — zero `ConsentGrant` references —
  despite `ConsentPurpose.STYLE_LEARNING` / `QUALITY_REVIEW` existing for exactly this use, and
  despite the DNA writing-style precedent checking a three-state opt-out before touching a doctor's
  text. Routing a second, higher-volume source into this pipeline widens an existing gap.

### 2.5 One capability is already plumbed and unused

The review-gate decide route already accepts `editedPayload`, honoured when the node is authored with
`allowEdit` (`workflows.controller.ts:308-311`); `ReviewGateWorkflow` carries it into its result
(`review_workflow.py:116`); the interpreter stores the whole result in its node-output cache, so it is
templating-addressable downstream (`interpreter/workflow.py:1083`) **[V]**. **All 11 ArcaAI graphs
author `n_review` with `allowEdit: true`** **[V]**, and that route *is* reachable by a service account
today.

But **no seeded graph consumes `editedPayload`** — zero references outside one comment **[V]** — and
releasing the graph's gate is explicitly *not* the clinical sign-off (TASK-933 OD-14), so it neither
reaches `SIGNED` nor triggers mining. The capability exists end-to-end and is inert.

### 2.6 Verified absences

1. No SDK method anywhere closes or terminates a HOPE consultation (both `HopeRealtimePort` and vox-node).
2. No `ConsultationSession` table; the only durable consultation→run link is the client-writable,
   forgeable `Consultation.metadata.governingEngine.workflowRunId`. `WorkflowRun` has no
   `consultationId` column.
3. `AuditLog` cannot serve as a feedback source — `scrubPhiForAudit` replaces content with
   `[REDACTED:PHI]`; only field names survive.
4. Nothing captures an edit that is never signed.
5. No open-session-age metric; the admin workflow list is hard-wired to the doc-workflow prefix, so
   `consultation-loop-*` and `workflow-interpreter-*` are not findable by consultation.

## 2b. Live cluster evidence (measured 2026-09-15, `hope-v2-dev`)

The owner reported *"all consultation sessions are still open now, even in the deployed cluster"*.
Measured directly; the report is right about the symptom and the cause is NOT what it looks like.

| Evidence | Finding |
|---|---|
| 13 `Consultation` rows: 11 `OPEN`, 1 `PENDING_REVIEW`, 1 `DRAINING` | — |
| The 11 `OPEN` rows all carry ids `90000000-…` with identical `updatedAt` | **Seed fixtures**, not leaked sessions. `90000000-xxxx → Consultations` is the reserved seed prefix (`seed/00-constants.ts:84`) |
| `09-consultation.ts:75` writes `status` inside **`metadata`**, never the column | **Seed defect.** Every fixture falls to `@default(OPEN)`, and the blob values (`CLOSED`, `REVIEW`, `SUMMARIZING`, `TRANSCRIBING`) are a RETIRED vocabulary — not members of `ConsultationStatus`. The file header claims "full lifecycle coverage across 6 statuses"; the column says `OPEN` nine times |
| `01a09d8e` `PENDING_REVIEW`, idle **29.4 h**, governing run present | A REAL stranded session — the H3-6 mode, in the one state the sweep never touches |
| `01a09e8e` `DRAINING`, idle 19 h | Real; sweep-eligible, closes at the 24 h threshold |
| `temporal workflow count --query "ExecutionStatus='Running'"` → **`Total: 0`** (namespace `default`, the only one) | **No durable execution is running.** The executions ended; the ROWS leak. This supports OD-3: the fix belongs on the row lifecycle, not on Temporal |
| `ConsultationTimeoutSweepService` logs, every 15 min, `eligible: 0` | The sweep is alive and behaving exactly as designed — the DESIGN excludes the states that strand |

Two structural facts from the transition matrix (`ConsultationEntity.ts:29-81`) decide the timeout design:

1. **`OPEN` is unclosable** — its only edge is `OPEN → PRIMED`. No sweep and no manual `POST /close` can ever clear an `OPEN` row.
2. **`TIMED_OUT` is recoverable, `CLOSED_INCOMPLETE` is not** — `TIMED_OUT → SIGNED` is legal and `approveSummary` already accepts it as a predecessor (`summary.service.ts:1303`: *"the clock never signs, a human still can"*), whereas `CLOSED_INCOMPLETE → REOPENED` only.

Corollary for Lane 6: `PENDING_REVIEW → CLOSED_*` is NOT a legal edge, so ALaaS cannot "just close" after submit. The sequence **update → approve → close** is mandatory, not stylistic.

## 3. Owner decisions (answered 2026-09-15)

| # | Decision | Answer |
|---|---|---|
| **OD-1** | System of record for the finished note | **Open the finish half of the consultation plane to service accounts.** The clinician's submit saves to ALaaS's DB and ALaaS then submits it INTO HOPE; no new ingest plane. |
| **OD-2** | Retire ALaaS's blind auto-approve (TASK-933 OD-14)? | **Keep as-is.** Consequence accepted: the graph gate is released before review, so `n_output` publishes the unedited note and the sign-off's gate-release is a no-op that must tolerate an already-closed gate. Corpus quality is unaffected — mining is enqueued from `approveSummary`, not the gate, and the signal is computed from `ai_draft_v1` → signed note. |
| **OD-3** | Must a close terminate the Temporal execution? | **Accept the current bounds.** Supported by §2b: `Running = 0`. Orphan-session termination is FU-1. |
| **OD-4** | Consent for training capture | **Wire a doctor/tenant opt-out now, mirroring DNA.** Full `ConsentGrant` binding is FU-4. |
| **OD-5** | Pair granularity | **Whole-document pairs.** `DocumentSection` history is FU-3. |
| **OD-6** | Where a `PENDING_REVIEW` consultation lands on the 2 h timeout | **`TIMED_OUT`, not `CLOSED_INCOMPLETE`** — recoverable, so a late submit still signs, still closes, and still yields its training pair. |
| **OD-7** | `OPEN` rows, which nothing can close | **Add the `OPEN → CLOSED_INCOMPLETE` matrix edge and sweep it.** |
| **OD-8** | The consultation seed defect | **Fix in this ticket** — seeded status belongs on the column, so seeded rows stop masking real stranded ones. |

## 4. Implementation Plan

**No migration.** The doctor toggle is a `UserSettings` key/value/namespace row (`user.prisma:117-129`)
and the tenant gates are settings-registry descriptors. `ConsultationStatus` already contains every
state used; OD-7 changes only the in-code transition matrix, not the enum.

Order follows the layer chain — domain → services → apps/api → SDK → seed → ALaaS change list. TDD
throughout (`01-development-workflow.md` §Phase 4): failing test first, watch RED, minimal GREEN.

### Lane 1 — Machine sign-off attribution (`packages/applications`)

`approveSummary` stamps `approvedBy = this.requestUserId` and throws when absent
(`summary.service.ts:1167`), so a service account cannot sign even once the scope exists. A machine
must never be recorded as the clinician who attested a clinical note.

Adopt TASK-974's rule verbatim on `updateSummary`, `approveSummary` and `closeConsultation`:

| Caller | `clinicianUserId` |
|---|---|
| Human JWT | omit ⇒ self; may name another only while holding `SUPER_ADMIN` / `TENANT_ADMIN` (else 400) |
| Service account | **REQUIRED** (400 otherwise); any clinician of its working tenant |
| API key | only the human it is bound to, unless that human holds `SUPER_ADMIN` / `TENANT_ADMIN` |
| Any | clinician outside the tenant ⇒ **404** (`assertUserBelongsToTenant`) |

The named clinician lands on `approvedBy` / `attestedBy` and the `SIGNED_NOTE` version; the
credential is recorded beside them as actor in the WORM `ATTEST` row. Reuse the
`resolveIngestClinician` shape (`dna-writing-style.service.ts:291`).

### Lane 2 — Training-capture opt-out (`packages/applications`)

Mirror `ConfigResolver.resolveEffectiveDnaStyleEnabled` (`config-resolver.service.ts:205-214`) with
`resolveEffectiveTrainingCaptureEnabled({ tenantId, doctorId })`, `effective = tenantEnabled &&
(doctorToggle ?? true)`: a new `UserSettings` key for the doctor toggle (three-state, unset ⇒
implicit opt-in) and a settings-registry descriptor for the tenant gate (`global-kv`, tenant →
SYSTEM, default **ENABLED** — mining runs unconditionally today, so defaulting off would silently
disable a shipped feature).

Checked at the mining enqueue in `approveSummary` **and** re-checked inside
`GateEditMiningProcessor`, fail-closed (`dna-writing-style.processor.ts:235`).

**The opt-out suppresses CAPTURE ONLY** — an opted-out clinician still signs, still closes; nothing
is mined. A clinical action is never failed for a training-data reason.

### Lane 3 — TASK-933 H3-6: route the sign-off to the governing run (`packages/applications`)

`signalApproval` targets `harness-doc-<consultationId>` (Substrate A) per `internal.py:8-9`. When
`Consultation.metadata.governingEngine.workflowRunId` names a Substrate-B run, also release that
run's review child through the existing decide path (`WorkflowExposureService`) rather than adding a
harness endpoint. Best-effort and idempotent: under OD-2 pointer-absent, gate-already-closed and
run-already-completed are all NORMAL — log and continue, never fail the sign-off. No workflow code
change (`review` already exists), so no replay exposure.

### Lane 4 — Scope grants and artifacts (`apps/api`)

| Route | Add |
|---|---|
| `PATCH /consultations/{id}/summary/{summaryId}` | `svc:consultation:report:write` |
| `POST /consultations/{id}/summary/{contextItemId}/approve` | `svc:consultation:session:write` |
| `POST /consultations/{id}/close` | `svc:consultation:session:write` |

Declare each in the service-account scope catalogue, then regenerate **all five** artifacts
(`api:build` → `api:route-manifest` → `api:openapi` → `api:portal` → `vox-node gen:admin`) with the
three `:check` gates green.

### Lane 5 — `@arcaai/vox-node` (3.5.0)

Add `hope.consultations.summaries.approve()` and `hope.consultations.close()` — neither is wrapped
today, though `close` is real and OCC-guarded (the browser SDK already calls it). `summaries.update()`
exists and needs only the server-side scope. Override `assertCredentialClass()` per the
`ConsultationWorkflowsResource` template. Family lockstep is a RELEASE decision, not taken here.

### Lane 6 — ALaaS change list (documented here; NOT edited from this repo)

Verified against `ALaaSv3.0` on 2026-09-15. **The order below is forced by two constraints, not style.**

**Constraint A — the edit and the consultation id live in different paths.** `audio-stream-svc` runs
two disconnected summarization paths. The REALTIME path (`src/consultation/`) holds the HOPE
`consultationId`; the BATCH path (`src/medical_summary/`) is where the clinician's edit actually
arrives (`POST update_summary_by_session/:sessionId/:eventId`,
`medical-summary.controller.ts:239` → append-only row in `updated_summary`). Neither
`generated_summary` nor `updated_summary` carries a HOPE `consultationId`. **At edit time ALaaS does
not know which HOPE consultation the note belongs to**, so step 1 is a prerequisite for steps 2-3,
not a cleanup.

**Constraint B — `PENDING_REVIEW → CLOSED_*` is not a legal transition.** The sign-off is what makes
the close legal, so `approve` must precede `close`.

| # | Change | Where |
|---|---|---|
| 1 | **Carry the HOPE `consultationId` onto the batch tables.** Add the column to `generated_summary` (and expose it through `updated_summary`'s FK) and populate it when the realtime path opens the consultation, so an edit can be resolved back to a HOPE consultation. | `src/medical_summary/entities/*.entity.ts`; note the tables are `synchronize: true`-managed in dev with no dedicated TypeORM migration |
| 2 | **On submit, after saving locally, call HOPE in order:** `summaries.update(...)` → `summaries.approve({ clinicianUserId })` → `close()`. The two existing "clinician is done" flags — `POST mark_copied_to_emr/:sessionId/:eventId` (`:265`) and `POST mark_updated_summary_copied/:id` (`:293`) — are the natural trigger points; they are local-only DB flags today with no HOPE call. | `medical-summary.controller.ts` + `updated-summary.service.ts` |
| 3 | **Extend the port and adapter.** `HopeRealtimePort` (`hope-realtime.port.ts:354-443`) and the pinned `VoxNodeRealtimeSurface` (`hope-realtime.vox-node.adapter.ts:148-210`) declare no `close`/`approve` — both must gain them once the SDK ships 3.5.0. | `src/consultation/` |
| 4 | **Retire the dead feedback route.** `POST /api/v1/summary/feedback` (`medical-summary.controller.ts:158-179`) forwards to a HOPE v1-compat path that 404s, and has live `web_ui` callers. Its own comment block already records that "HOPE v2 has no route that records a clinician's correction of a summary" — this ticket is what makes that false. Repoint it at step 2 or delete it with its callers. | `medical-summary.controller.ts`, `web_ui/utils/feedbackHelper.js` |

**Not requested, recorded as a consequence:** `stop()` (`consultation-broker.service.ts:577`) already
auto-approves HOPE's `n_review` gate with **no edited content**, though that gate is authored
`allowEdit: true` in all 11 ArcaAI graphs and was designed to carry exactly this. Under OD-2 that
stays. Once step 2 ships, the clinician's real edit arrives by the `approve` route instead, and the
gate release remains the no-op Lane 3 already tolerates.

**Out of scope here (FU-1):** `teardown()` (`:649-663`) tears down a vanished browser's session
locally after a 60 s grace and calls **no** HOPE endpoint, so an abandoned recording is never
reported. HOPE now self-heals this via the Lane 8 `OPEN`/`PENDING_REVIEW` timeouts; a proactive ALaaS
notification is still the better fix.

### Lane 7 — The unclosable `OPEN` state (`packages/domains`) — OD-7

Add `OPEN → CLOSED_INCOMPLETE` to `CONSULTATION_TRANSITIONS` (`ConsultationEntity.ts:29`) and extend
the pinned matrix test. Entity files are hand-authored (`03-domain-layer.md` §Generated Code
Discipline) — edit by hand, then re-run `gen:entity` / `gen:factory` `:check` for barrel and
schema-coverage parity. **Never run `gen:mapper`.**

### Lane 8 — Timeout legs that cover the stranding states (`packages/applications`) — OD-6

Two new sweep legs on `ConsultationTimeoutSweepService`, each with its own descriptor:

| Leg | Threshold | Target |
|---|---|---|
| `PENDING_REVIEW` idle | `consultation.state.reviewTimeoutMinutes`, default **120** | `TIMED_OUT` (recoverable) |
| `OPEN` idle | `consultation.state.openTimeoutMinutes`, default **120** | `CLOSED_INCOMPLETE` (needs Lane 7) |

The existing `sessionTimeoutMinutes` (1440, covering `PRIMED`/`DRAINING`/`DRAFT_PENDING_SENSORS`/
`TIMED_OUT`/`REOPENED`) is **left as-is** — it is a live-tunable `GlobalSetting`, so it can be moved
to 120 with no redeploy if the owner wants one uniform 2 h horizon. Flagged, not silently changed.

Each leg reuses the existing per-row pattern: `transitionTo` → `updateWithVersion` → `ResourceUpdated`
sys-event → WORM append, wrapped in `clsService.run()` with the row's own `tenantId`.

### Lane 9 — Consultation seed defect (`packages/database`) — OD-8

Move the fixture lifecycle onto the `status` column with real `ConsultationStatus` values, and drop
the retired `metadata.status` vocabulary. Audit which suites depend on seeded consultation statuses
BEFORE changing them — with Lane 8 live, a seeded `OPEN` row would otherwise be swept mid-suite and
make those tests flaky.

### Follow-ups filed, not built

| # | Item |
|---|---|
| FU-1 | Orphan-session termination — ALaaS tears down locally after 60 s without notifying HOPE (OD-3) |
| FU-2 | A first-class durable consultation↔run link; today only the client-writable `metadata.governingEngine.workflowRunId` exists and `WorkflowRun` has no `consultationId` |
| FU-3 | `DocumentSection` version history → section-aligned training pairs (OD-5) |
| FU-4 | Full `ConsentGrant` binding for mining (OD-4) |
| FU-6 | Notify the clinician when the sweep times a review out, mirroring `recordEscalation`'s "A later approval still commits" |
| FU-5 | Whether `n_output` should wait for the real sign-off — under OD-2 it publishes the UNEDITED note downstream |

### Verification criteria

| # | Criterion |
|---|---|
| V1 | Service account: 403 on all three routes before, 200 after; cross-tenant id still 404 |
| V2 | Machine caller omitting `clinicianUserId` ⇒ 400; foreign clinician ⇒ 404; API key naming another human without an admin role ⇒ 400 |
| V3 | `approvedBy` / `attestedBy` / `SIGNED_NOTE` carry the **clinician**; the WORM `ATTEST` row names the **credential** |
| V4 | A service-account sign-off yields a `GateEditExemplar` with both redacted halves populated |
| V5 | An opted-out clinician yields **no** exemplar — and the sign-off still returns 200 and still closes |
| V6 | `update → approve → close` reaches `SIGNED` then `CLOSED_COMPLETE` |
| V7 | Sign-off succeeds unchanged when the review gate is already closed (the OD-2 common case) |
| V8 | A `PENDING_REVIEW` row idle > 120 min becomes `TIMED_OUT`; a submit AFTER that still signs, closes and mines (the OD-6 recovery path) |
| V9 | An `OPEN` row idle > 120 min becomes `CLOSED_INCOMPLETE`; the matrix test pins the new edge |
| V10 | Seeded consultations carry their intended `status` on the column; no suite depends on a seeded row being `OPEN` |
| V11 | Gates green: `@arcaai/domains`, `@arcaai/applications`, `apps/api` build/test/lint; five artifacts regenerated; `task-776-route-authz-matrix` green; e2e suite |

## 4b. Execution log (2026-09-15)

Six writers, one worktree each, merged into `dev-2.2` in dependency order. Every merge re-verified in
the PRIMARY checkout, not on the writer's report.

| Lane | Branch | Merge | Post-merge gate (orchestrator-run) |
|---|---|---|---|
| 7 — matrix edge | `task-972/w1-domains` | `ea8c117e6` | domains build clean; transitions 152/152 |
| 5 — vox-node 3.5.0 | `task-972/w5-voxnode` | `d7d9f8e76` | 543/543; 3 builds; lint clean |
| 9 — seed status column | `task-972/w6-seed` | `d615f3dff` | database 1825/1825 |
| 8 — sweep legs | `task-972/w3-sweep` | (merged) | domains 1986 passed; applications 14008 passed, **1 known red** (below) |

### Findings from execution that change the record

1. **A regression the orchestrator's own gate missed.** Merging lane 7, only `@arcaai/domains` was
   re-run. The matrix edge also invalidates a DOWNSTREAM assertion:
   `consultation.service.test.ts:1606` pins "closing a still-`OPEN` consultation throws 409", which
   OD-7 deliberately made legal. Writer W3 found it, proved it pre-existed its own branch by
   reverting and re-running at base, and correctly declined to edit a file another writer owned.
   **Fix belongs to the lane-1 integration step: the assertion is wrong, not the code.**
2. **A no-op guard was removed before merge.** Lane 5 shipped `assertCredentialClass()` as a no-op on
   two resources, citing `workflows.ts:279` — which is a REAL guard (`assertApiKeyPlane`) overriding
   an abstract base those resources do not have. It ran on every call and read like a check that did
   not exist. Removed (`bdb9c64b2`); 543/543 still green.
3. **Stale `dist/` fails a gate that passed in the worktree.** vox-node asserts its BUILT bundle
   carries the version literal, so the primary's pre-3.5.0 bundle failed on merge and passed after a
   rebuild. Not a regression — but it is invisible unless gates are re-run after merging.
4. **Lane 9 newly exposes seeded rows to the EXISTING sweep.** With fixtures on real statuses,
   `ER_RECORDING` becomes eligible for the already-shipped 30-minute stale-recording leg and moves to
   `DRAINING`; three more become eligible for the 1440-minute leg. Pre-existing behaviour, newly
   reachable. Seeded consultations now decay unless reseeded.
5. **Lane 8's `OPEN` predicate is stronger than the plan specified.** Eligibility requires idle age
   **AND** no `ContextItem` created in the window, because `ContextService` only READS the
   consultation row — age alone would close a consultation a clinician was actively loading context
   into, and `CLOSED_INCOMPLETE` reaches only `REOPENED`.
6. **Residual risks accepted, recorded (lane 8):** editing an EXISTING `ContextItem` does not protect
   an `OPEN` row (only `createdAt` is checked); and a clinician reviewing for >2 h WILL be timed out,
   because reviewing writes the summary/section plane rather than the consultation row. Tolerable
   only because OD-6 made the target recoverable.
7. **No clinician notification on the sweep-driven `TIMED_OUT`**, unlike the sibling
   `HarnessInternalService.recordEscalation` path which notifies with "A later approval still
   commits." Deliberately not added (new DI dependency, unsanctioned by the plan) — filed as FU-6.
8. **`@arcaai/database` has no `lint` script** and sits outside the lint graph; `build` + `typecheck`
   + `test` are the real gates for lane 9.

## 5. Implementation Summary

All six code lanes merged to `dev-2.2`. No schema change, no migration. Every merge was re-verified
in the PRIMARY checkout; the evidence below is the orchestrator's own runs, not a writer's report.

| Lane | What shipped |
|---|---|
| 1 | Machine sign-off attribution on `updateSummary` / `approveSummary` / `closeConsultation`. A machine MUST name `clinicianUserId`; the clinician lands on `approvedBy`/`attestedBy` and the `SIGNED_NOTE` version, the credential is recorded beside them as ACTOR. An API key may name only its own bound human unless that human is an admin. |
| 2 | Training-capture opt-out: tenant descriptor `consultation.feedback.trainingCapture.enabled` (`global-kv`, default ENABLED) × doctor `UserSettings` toggle `trainingCapture:enabled` (three-state). Checked at the mining enqueue AND re-checked in the processor, fail-closed. Suppresses CAPTURE only — never the clinical action. |
| 3 | TASK-933 **H3-6 closed**: the sign-off now also releases the governing Substrate-B run's review child through the existing decide path. Best-effort by construction. |
| 4 | Three `svc:` scope grants + `caller` read off the REQUEST (so an API key is never misclassified as a human JWT) + `clinicianUserId` declared on the approve/close DTOs + all five artifacts regenerated. |
| 5 | `@arcaai/vox-node` 3.5.0: `summaries.approve()` and `close()`, both requiring `If-Match`. |
| 7 | `OPEN → CLOSED_INCOMPLETE` — `OPEN` was structurally unclosable. |
| 8 | Two sweep legs: `PENDING_REVIEW` → **`TIMED_OUT`** (recoverable) and `OPEN` → `CLOSED_INCOMPLETE`, both 120 min, live-tunable. `OPEN` needs two signals: idle age AND no `ContextItem` created in the window. |
| 9 | Seed fixtures onto the typed `status` column. |

### Evidence

**Unit / integration (orchestrator-run, primary checkout)**
```
CI=true npx vitest run packages/applications packages/domains
  Test Files  1043 passed | 2 skipped (1045)
  Tests       16047 passed | 4 skipped | 9 todo (16060)

npx vitest run apps/api --project workspace      → 318 files / 4620 tests passed
pnpm --filter @arcaai/vox-node test              → 37 files / 543 tests passed
pnpm --filter @arcaai/database test              → 92 files / 1825 tests passed
```

**Artifact gates**
```
pnpm api:openapi:check   → OK — every served route documented or deliberately excluded
pnpm api:portal:check    → no drift (admin 667 ops, business 202 ops)
gen:admin:check          → no drift (49 areas, 425 routes, 438 schemas)
```

**The grant, from the merged manifest** — exactly three routes moved from `svc=[]`; all 749 routes diffed, no other `svcScopes` changed:
```
POST  /consultations/{id}/close                           svc=['svc:consultation:session:write']
POST  /consultations/{id}/summary/{contextItemId}/approve svc=['svc:consultation:session:write']
PATCH /consultations/{id}/summary/{summaryId}             svc=['svc:consultation:report:write']
```

**End to end, against a live gateway on 8968** (test infra on 5433/6380, DB reset + `RUN_SEED=all`, gateway healthy):
```
npx playwright test task-972-consultation-finish-plane        → 10 passed (3.1s)
  ✓ close: naming a clinician OF ITS OWN TENANT closes the row, and the machine is not the actor
  ✓ close: a machine that names NO clinician is 400 CLINICIAN_REQUIRED — never the account itself
  ✓ close: a clinician in ANOTHER tenant is 404
  ✓ close: naming ANOTHER clinician is 400 CLINICIAN_NOT_ALLOWED           (API key)
  ✓ close: naming its OWN bound human is allowed                            (API key)
  ✓ approve / PATCH summary: the grant landed — 404, not the old deny-by-default 403
  ✓ close: a doctor closes their own consultation, naming nobody            (human JWT)
```

**Lane 9 against a real database** — 8 distinct statuses across 12 seeded consultations, where every
fixture previously read `OPEN`:
```
OPEN 3 | CLOSED_COMPLETE 2 | PENDING_REVIEW 2 | DRAFT_PENDING_SENSORS 1
DRAINING 1 | REOPENED 1 | RECORDING 1 | CLOSED 1
```

**Lane 2 live in the running gateway**
```
GET admin/settings/registry/consultation.feedback.trainingCapture.enabled
{ "tier": "global-kv", "value": true, "sourceScope": "code-default", "version": 0 }
```

**Lane 8 predicates against real data (read-only, dev DB)** — 1 `PENDING_REVIEW` row (idle 29.4 h)
would move to `TIMED_OUT`; 11 `OPEN` rows would move to `CLOSED_INCOMPLETE`, unchanged by the
two-signal guard because none has a recent `ContextItem`.

### Two pre-existing reds, verified as NOT caused by this ticket

| Red | Proof it predates the ticket |
|---|---|
| `npm-publish-policy.contract.test.ts` — vox family lockstep | The family is 7 packages; before this ticket `vox`+`vox-node` were 3.4.0 and the other five 3.3.0 — **two** versions, and the contract asserts exactly one. It was already failing. Lane 5's bump makes it three. Fixing it means bumping the family, which is the release decision this ticket deliberately did not take. |
| `task-776-route-authz-matrix` A5b — `@Public() /internal/*` inventory pinned at 34 | The manifest carries **35 such routes both before and after** this ticket; total routes unchanged at 749. We added scopes, not routes. |

### Not done, and why

**Lane 6 (ALaaS) is documented but not built.** Until those calls land, lanes 1-5 create the
capability and nothing exercises it in production: the clinician's edit still stops at ALaaS's
database. The close-signal half, however, is self-healing from HOPE's side as of Lane 8 — a stranded
consultation now times out rather than sitting open forever, which is the half the owner observed.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-15 | Ticket opened. Six read-only discovery lanes run. Root cause established: the finish half of the consultation plane was never opened to service accounts, so the clinician's edit never reaches HOPE — which simultaneously starves the existing `GateEditExemplar` training pipeline and leaves the consultation parked in `PENDING_REVIEW`, a state the timeout sweep deliberately excludes. |
| 2026-09-15 | OD-1..OD-5 answered. Plan written: six lanes, no schema change, five follow-ups filed. |
| 2026-09-15 | **Live cluster measured (§2b)** after the owner reported all sessions still open. 11 of 13 rows are SEED fixtures stuck on `@default(OPEN)` because `09-consultation.ts` writes status into `metadata` using a retired vocabulary; only ONE row is a genuinely stranded session (`PENDING_REVIEW`, 29.4 h). Temporal `Running = 0` — no durable execution is running, so the leak is rows, not workflows (supports OD-3). Two structural findings: `OPEN` is unclosable (only edge `OPEN → PRIMED`), and `TIMED_OUT` is the recoverable timeout target since `approveSummary` already accepts it as a predecessor of `SIGNED`. OD-6..OD-8 answered; lanes 7, 8, 9 added; V8..V11 added. |
