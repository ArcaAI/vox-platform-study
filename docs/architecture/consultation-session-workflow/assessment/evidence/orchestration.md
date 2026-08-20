# HOPE Consultation Conformance Audit — Wave 1, Lane B: Orchestration & Session Lifecycle

Branch: `feat/loop`. Assessed against `docs/architecture/consultation-session-workflow/dataset.xml` and
`user-stories-and-use-cases.md` (references, not gospel — see `## Reference defects`).

## Scope & method

**Read in full by me directly:** `dataset.xml`, `user-stories-and-use-cases.md`, `harness.prisma`,
`agent-trajectory.prisma`, `consultation.prisma`, the relevant sections of `enums.prisma`
(`ConsultationStatus`, `ContextItemType`, `ContextItemSource`, `HighlightTargetKind`), `harness-loop.descriptors.ts`
(full), `useArcaSessionManager.ts` (full), `ConsultationEntity.ts` (lifecycle sections), `harness-gate.spec.ts`
(full non-full-loop section), and targeted sections of `summary.service.ts` (`approveSummary`,
`computeAttestationHash`), `harness-internal.service.ts` (`finalizeAssurance`, `applyAssuranceBackfillWithCas`,
`recordGateDecision`, `assertConsultationWritable`), `harness-admin.controller.ts` (workflow-ops routes + guards),
`workflow-action.request.ts`, `consultation.controller.ts` (`recording/start`, `recording/stop`, `close`, `reopen`,
`update`), `consultation.service.ts` (`transitionStatus`/`closeConsultation`/`reopenConsultation`),
`consultation-gates.constants.ts`, `consultation-gates.descriptors.ts`, `consultation-event.handler.ts` (trigger
section), `transcript-provenance.ts`.

**Delegated to three parallel sub-agents, each reading their files in full**, then cross-verified by me against the
primary source where the finding was safety-critical:
- **Agent A** — `apps/harness/src/harness/temporal/{workflows,activities,models,worker,client,claim_check,metrics}.py`
  + the FastAPI endpoints that start workflows / send signals + `test_replay_compat.py`.
- **Agent B** — `packages/applications/src/services/consultation/live-documentation/**`,
  `packages/applications/src/services/consultation/loop/**`, and the harness-gateway seam.
- **Agent C** — `packages/applications/src/services/consultation/{consultation,harness,summary}/**`,
  `harness-policy`, `harness-audit`, `harness-observability`, `apps/api/src/modules/{harness-admin,streaming}/**`,
  plus repo-wide greps for `SIGNED` write sites, `autoApprove`, `@Cron`/`@Interval`, and idempotency near
  approve/sign/finalize.

**Excluded from every search:** `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`,
`**/__pycache__/**` — enforced by scoping all greps through `git ls-files` (a first pass without this leaked
`.claude/worktrees/*` results and was discarded).

**Could not reach / out of lane:** the admin-console frontend (React) beyond a `useArcaSessionManager` consumer
check; the harness's non-Temporal FastAPI surfaces beyond `admin.py`/`internal.py`; running the app or querying a
live DB — everything below is static-code evidence. archived tickets describing this exact feature exist but were
deliberately **not read** per the "new sprint, code not old plans" rule.

## Subsystem map

| Component | Path | Role |
|---|---|---|
| `Consultation.status` | `packages/database/src/prisma/db_main/consultation.prisma:36` | Typed `ConsultationStatus` enum column: OPEN/RECORDING/DRAFT_PENDING_SENSORS/PENDING_REVIEW/SIGNED/CLOSED/REOPENED |
| `metadata.status` | `consultation.service.ts:640-719` | **Second, independent** open/closed tracker — legacy free-form JSON, predates the typed column |
| `LiveDocumentationService` | `packages/applications/.../live-documentation/live-documentation.service.ts` | Ephemeral, in-memory/Redis, per-consultation watcher; debounces finalized STT segments into a running SOAP draft over TEXT+NLP; never authoritative, never touches `Consultation.status` |
| `HarnessGatewayService` | `.../harness/harness-gateway.service.ts` | apps/api → apps/harness outbound HTTP client (start workflow, signal approval/edit/context) |
| `HarnessInternalService` + `harness-internal.controller.ts` | `.../harness/harness-internal.service.ts`, `apps/api/.../consultation/harness-internal.controller.ts` | Inbound, `X-Service-Token`-guarded callback surface the Python harness calls back into (persist draft/entities, finalize assurance, gate-decision, escalation, progress, live-doc start/stop) |
| `SummaryService.approveSummary` | `.../summary/summary.service.ts:824-1027` | **The single, non-bypassable clinician signing path** — writes SIGNED_NOTE + ATTEST + flips `status → SIGNED` |
| `HarnessDocWorkflow` | `apps/harness/.../temporal/workflows.py:280-1604` | Bounded `guides→generate→sensors→gate` Temporal workflow; one run per note; **frozen**, ~11 live `workflow.patched()` eras |
| `SpecialistWorkflow` | `workflows.py:1803` | Child workflow isolating one specialist-agent call; `max_attempts=1`, no retry-if-idempotent (deliberately stricter than the reference) |
| `ConsultationLoopWorkflow` | `workflows.py:1877-2116` | **New**, long-lived, signal-driven, per-consultation dispatcher; genuinely resumable (Temporal `continue_as_new` checkpointing); dispatches `livedoc.start/stop`, NER/vision/document extraction, and finally `harness.finalize` (starts `HarnessDocWorkflow` as an unmodified child). **Dormant by default** — see below |
| `loop/` TS package | `packages/applications/.../consultation/loop/**` | TS-side adapter: `LoopConfigService` (pins config at workflow start), `LoopContextSignalService` (forwards ContextAdded/ending/cancel signals), `ConsultationLoopEventService` (republishes loop events for the client SSE feed) |
| `HarnessAuditService` | `.../harness-audit/harness-audit.service.ts` | Appends to the hash-chained, DB-privilege-enforced (`REVOKE UPDATE, DELETE`) `HarnessAuditEvent` WORM table |
| `HarnessAdminController` | `apps/api/.../harness-admin/harness-admin.controller.ts` | Policy CRUD, audit read, golden-set/eval CRUD, and Temporal ops proxy (`cancel`/`terminate`/`signal`) |
| `ConsultationController` | `apps/api/.../consultation/consultation.controller.ts` | `recording/start` → `LiveDocumentationService.start()`; `recording/stop` → `LiveDocumentationService.stop()` + `loopContextSignalService.signalConsultationEnding()`; `close`/`reopen` → legacy `metadata.status` |

## State machine table

Reference's 11-state (+1 alternate-terminal) machine mapped to code. "Guarded" = a write site checks the
prior/expected state before writing; "Recorded" = the value is written unconditionally by whoever calls the
method; "Absent" = no code representation found after the searches listed.

| Reference state | Code equivalent | Guarded / Recorded / Absent | Evidence |
|---|---|---|---|
| **Open** | `ConsultationStatus.OPEN` | Recorded (default on create; `stopRecording` reverts to it unconditionally) | `consultation.prisma:36` (`@default(OPEN)`); `consultation.controller.ts:503-522` |
| **Primed** | No dedicated state. Loosely: `parentConsultationId`/`ConsultationChain` + `CASE_NOTE` context items | Absent as a gate/state | Searched `Primed`/`PRIMED` repo-wide — zero hits. No code blocks Streaming from starting until a "prior history reviewed" step completes |
| **Streaming** | `ConsultationStatus.RECORDING` | Recorded (unconditional write, no prior-state check) | `consultation.service.ts` `setRecordingStatus` (per Agent C, write site ~`:794-838`) |
| **(Degraded)** | No `Consultation`-level state. Only a per-run **boolean** `degraded`/`reduced_assurance`/`policy_degraded`/`mcp_degraded`, OR'd into `SummaryMeta`/audit | Recorded as a flag, not a state | `workflows.py:680,696-697,946-951`; `ConsultationLoopWorkflowResult.degraded: bool` (`models.py:1743,1775`) |
| **Paused** | **Absent** server-side. Only a client-side v1-compat shim (`useArcaSessionManager.pauseSession/resumeSession`) that sets local React state and touches nothing else | Absent (recorded nowhere durable) | `packages/agentic-sdk-v2/src/compat/useArcaSessionManager.ts:14,192-199` — doc comment: *"`pause`/`resume` have no v2 equivalent → local status only"* |
| **Draining** | No `Consultation.status` value. `ConsultationLoopWorkflow` has an internal, non-persisted drain sequence (dormant by default) | Recorded only as workflow-internal phase, never surfaced to `Consultation` | `workflows.py:2099-2110` (loop `_drain()`/ending sequence); `harness-gateway.service.ts` `signalConsultationEnding` |
| **Drafting** | `ConsultationStatus.DRAFT_PENDING_SENSORS` | Guarded only by tenant + soft-delete (`assertConsultationWritable`), **not** by prior status | `harness-internal.service.ts:892-895` write; `:402-406` guard (checks `resourceStatus`, not `status`) |
| **Awaiting Review** | `ConsultationStatus.PENDING_REVIEW` | **The one real per-transition guard found**: flips only `if (status === DRAFT_PENDING_SENSORS)` | `harness-internal.service.ts:1034-1038` |
| **Closed Approved** | `ConsultationStatus.SIGNED` | No prior-state guard (any status can flip to SIGNED); gated instead by identity (authenticated `requestUserId`) + business checks (final-summary flag, safety-flag override) | Single write site: `summary.service.ts:978`, inside `approveSummary` (`:824-1027`) |
| **Closed** | **`ConsultationStatus.CLOSED` exists but is never written anywhere in the repo.** The real "close" feature writes an **independent** `metadata.status` JSON field instead, via `closeConsultation()` | **Recorded, and with NO dependency on `Consultation.status` at all** — see F-02 below | Enum: `enums.prisma:284`; real writer: `consultation.service.ts:664-712`; controller: `consultation.controller.ts:431-442` (guard = ownership only) |
| **Timed Out** | No `ConsultationStatus` value. Closest: harness WORM actions `GATE_ESCALATED`/`GATE_ABANDONED`, and the loop's own non-persisted `_phase = "TIMED_OUT"` | Recorded as audit-only / workflow-local; `Consultation.status` is left untouched | `workflows.py:1520-1574` (gate SLA loop → `approved=False`, no status write); `harness-internal.service.ts:1259-1300` (`recordEscalation`, audit-only) |
| *(REOPENED — code-only, not in the reference's 11)* | `ConsultationStatus.REOPENED` declared, **never written** | Dead enum member | `enums.prisma:285`; zero write hits repo-wide |

**Structural finding, independent of any single state**: `ConsultationEntity.status` is a bare `setProperty`
setter (`packages/domains/src/entities/generated/core/ConsultationEntity.ts:109-110`) and `validate()`
(`:179-190`) checks only `patientId`/`doctorId`/`appointmentDate` — **the entity itself enforces zero transition
legality**. Every guard that exists (DRAFT_PENDING_SENSORS→PENDING_REVIEW; the identity/business checks on
→SIGNED) is bespoke, at the individual call site, not a shared FSM. This is the direct code-level answer to "is
the transition guarded" for every row above: guards are per-write-site prose discipline, not a validator any
future write path automatically inherits.

## Two-orchestrator analysis

There are, precisely, **two generations of orchestrator layered hierarchically, not two competing ones** — this
is the single most important structural finding of this audit.

**Layer 1 (always live today): `LiveDocumentationService` (TS) + `HarnessDocWorkflow` (Temporal, frozen/bounded).**
`ConsultationController.startRecording`/`stopRecording` call `LiveDocumentationService.start()`/`.stop()` directly
(`consultation.controller.ts:479,505`) — this drives only the ephemeral, non-authoritative running work-note during
Streaming (writes `PRE_SUMMARY`/`LIVE_SOAP_SNAPSHOT` context items, never `Consultation.status`). Separately, `STT`
finalization emits `TranscriptionCreated` **exactly once per consultation** (the STT aggregate row, not per
segment — confirmed at `transcript-provenance.ts:8-12`, *"the SOLE trigger for... harness note generation"*), which
`ConsultationEventHandler.handleTranscriptionCreated` (`consultation-event.handler.ts:93-172`) uses to start
`HarnessDocWorkflow` via `harnessGatewayService.start()` when `pipelineConfig.harnessEnabled` is true. So in the
**default, always-on configuration**, `HarnessDocWorkflow` runs once, at stop/finalize time — a reasonably
faithful match to the reference's Drafting→Awaiting-Review single reconciliation pass (Time 17-19).

**Layer 2 (new, dormant by default): `ConsultationLoopWorkflow`.** Gated by the `harness.loop.enabled` global-kv
kill-switch, **default `false`** (`consultation-gates.constants.ts:48`; resolved fresh on every signal per
`loop-context-signal.service.ts:67`). When enabled, `LoopContextSignalService` forwards every `ContextAdded` /
`consultation-ending` / `loop-cancel` event to a **signal-with-start** `ConsultationLoopWorkflow` per consultation
(`harness-gateway.service.ts:287`). Its pinned config declares `startActions: ['livedoc.start']` and
`endingActions: ['livedoc.stop', 'harness.finalize']`, dispatched as activities that **POST back into apps/api**
(`harness-internal.controller.ts:507-538`) — i.e. it calls the exact same `LiveDocumentationService.start()/stop()`
the direct controller path calls, and both are idempotent (`live-documentation.service.ts:550-557` no-ops if a
session already exists), so no observed race. At consultation end it hands off to `harness.finalize`, which starts
`HarnessDocWorkflow` **as an unmodified child** (`workflows.py:2386-2479`) — it does not reimplement note
generation, it composes the existing frozen workflow.

**Duplicated responsibility, by file, with agreement/disagreement:**

| Responsibility | Layer 1 (live) | Layer 2 (dormant) | Agree? |
|---|---|---|---|
| Debounce work-note updates | `LiveDocumentationService` segment-count (3) / idle-timer (5s) — `live-documentation.service.ts:850-895,1603-1609` | Same `LiveDocumentationService`, invoked as an activity — no separate implementation | Same code, called twice |
| Drain on stop | `LiveDocumentationService.stop()` bounded self-flush of its own buffer (`:783-843`) | `ConsultationLoopWorkflow._drain()` + forced final replan (`workflows.py:2099-2110`) — a genuinely different, multi-agent-aware drain | **Different mechanisms**, not a conflict today because Layer 2 is off |
| Per-agent timeout | None (single generation call) | `SpecialistWorkflow` child-workflow isolation, 5-min bound, `max_attempts=1`, degrades parent on `ChildWorkflowError` (`workflows.py:1784-1787`) | Layer 2 only |
| Checkpoint | Temporal durable execution (implicit) for `HarnessDocWorkflow`'s gate wait | Explicit `continue_as_new` checkpointing (`workflows.py:2724-2774`) | Layer 2 adds an explicit mechanism Layer 1 never had |
| Note synthesis | `HarnessDocWorkflow` (both layers ultimately call this same, unmodified workflow) | Same | **Identical** — Layer 2 does not duplicate generation |

**Verdict:** this is architecturally sound — Layer 2 is being built to *compose* Layer 1's existing bounded
workflow into a resumable session substrate, not to replace or race it. The risk is not runtime divergence today
(the kill-switch prevents it); the risk is that **most of the reference's target states (Draining, Timed Out,
Degraded-as-a-state, multi-agent drain, resumable pause) only exist in the code path that is currently switched
off**, so this audit's ABSENT verdicts above are conditional on `harness.loop.enabled` staying false. See
`## Open questions for wave 2`.

## Conformance findings

| ID | Invariant | Ref | Verdict | Evidence | Severity |
|---|---|---|---|---|---|
| F-01 | Timeout must never produce an approved/signed state | US-CL-14, T19/T21/T24, UC-12 | **IMPLEMENTED** | `summary.service.ts:875-878,978`; `workflows.py:1531-1574`; `harness-internal.service.ts:1211-1247,1259-1300` | — (positive finding) |
| F-02 | "Closed" (T23) presupposes "Closed Approved" (T21) already happened | T23 Note: *"Closed here means Closed Approved has already occurred... not a timeout close"* | **VIOLATED** | `consultation.service.ts:664-712`, `consultation.controller.ts:431-442` | High |
| F-03 | Consent + ABAC gate before any priming/capture (T0-T1) | T0/T1, US-PT-01, US-CO-03 | **ABSENT** | repo-wide grep, see below | High |
| F-04 | Contradiction detection (image-vs-speech, history-vs-current) | T6.1, T9, T12.4, UC-09, UC-10 | **ABSENT** | repo-wide grep, see below | High |
| F-05 | Pause persists a durable checkpoint; capture actually stops | T13, US-CL-16 | **ABSENT / VIOLATED** (see detail) | `useArcaSessionManager.ts:14,192-199` | Medium-High |
| F-06 | Two-phase drain: await in-flight agents, force-stop on timeout, mark sections incomplete | T15-T16 | **PARTIAL** — exists only in the dormant loop layer | `workflows.py:2099-2110` vs `live-documentation.service.ts:783-843` | Medium |
| F-07 | Clinical review/verification runs BEFORE the note is offered for sign-off | T18-T19, US-CL-12, UC-14 | **VIOLATED (deliberate divergence)** | `summary.service.ts:852-873,915-919`; `harness-internal.service.ts:1014-1017,1092-1113` | Medium-High |
| F-08 | Idempotent commit — duplicate approval never creates a second signed note | T21, US-CL-14, UC-05 | **PARTIAL** | `summary.service.ts:841-981` | Low-Medium |
| F-09 | Admin/ops surface cannot forge a gate decision's clinician identity | US-CO-01 (audit ledger integrity) | **PARTIAL** | `harness-admin.controller.ts:485-493`; `harness-internal.service.ts:1211-1247` | Medium |
| F-10 | "Primed" — reviewed prior-history gate before Streaming | T2-T3, US-CL-01 | **ABSENT** | repo-wide grep for `Primed` | Medium |
| F-11 | "Degraded" as a distinguishable session state (not just a boolean) | T10.1, UC-11 | **PARTIAL** | see Two-orchestrator table / state table | Low |
| F-12 | Event taxonomy: `session.opened`, `agent.timeout`, `contradiction.detected`, `note.revision.requested`, `hitl.edit` | T0,T6.1,T10.1,T12,T12.2 | **PARTIAL/ABSENT per-event** | see detail | Medium |

### F-02 detail — "Closed" reachable without "Closed Approved"

**Reference requires:** T23's Note is explicit: *"Closed here means Closed Approved has already occurred (Time
21). This is not a timeout close."* — i.e., the terminal Closed state is a housekeeping follow-on to a prior
SIGNED note, not an independently reachable state.

**Code does:** `Consultation` carries **two, entirely independent** notions of "closed":
1. The typed `status` column (`ConsultationStatus`), whose `CLOSED`/`REOPENED` members are declared in the schema
   but **never written by any code in the repository** (verified by Agent C's repo-wide grep and my own
   cross-check of every `ConsultationStatus.SIGNED`-adjacent write site).
2. A **separate** legacy `metadata.status` JSON field (`ConsultationLifecycleStatus`: `OPEN | CLOSED`), written by
   `closeConsultation()`/`reopenConsultation()`/`updateConsultation()` (`consultation.service.ts:640-777`).

`closeConsultation()` → `transitionStatus(id, CLOSED, 'closeConsultation')` (`:710-712`) reads and writes
**only** `metadata.status`; it never reads the typed `status` column, so it has **no dependency on whether the
consultation was ever SIGNED**. The controller guard is `verifyConsultationOwnership` only
(`consultation.controller.ts:431-442`) — the doctor who owns the consultation (or anyone holding
`manage:Consultation`) can call `POST :id/close` at **any** point in the typed lifecycle: while still `OPEN`,
mid-`RECORDING`, or sitting in `PENDING_REVIEW` with an unsigned draft.

**Concrete failure scenario:** a clinician opens a consultation, records a few seconds of audio, then calls
`POST /consultations/:id/close` before any summary is generated or approved. `metadata.status` becomes `CLOSED`;
the typed `status` column stays `OPEN`/`RECORDING`. The consultation now reads as "closed" to any client keyed off
`metadata.status` while simultaneously reading as un-signed/in-progress to any client keyed off the typed column —
and per the reference's own semantics, a "Closed" record without a prior "Closed Approved" should be impossible.

**Blast radius:** any downstream consumer of "is this consultation closed" (admin-console UI, reporting,
retention-TTL scheduling per US-AD-04) must know to check the RIGHT field for the RIGHT purpose, and the two can
diverge silently — there is no invariant anywhere forcing `metadata.status === CLOSED ⟹ status === SIGNED`.

### F-03 detail — Consent/ABAC gate is absent

**Reference requires:** T0-T1 make consent + ABAC the FIRST clinical act — *"No Summarization, Transcription, or
retrieval agents run until consent and ABAC succeed."* US-PT-01/US-CO-03 require patient-grantable/revocable
consent enforced at the tool gateway, with revocation propagating to future calls.

**Code does:** repo-wide search (`git ls-files -- '*.ts' '*.prisma' | xargs grep -ln -i '\bconsent\b'`) returns
**only** Microsoft-Clarity analytics-consent files (`packages/agentic-sdk-v2/src/core/logger/transports/
clarity.transport.ts`, unrelated website-tracking consent) and unrelated seed-content strings. `\bABAC\b`
repo-wide returns **zero hits**. `consultation.service.ts`'s session-open path (`getOrCreate`/`createRevisit`,
per Agent C) checks only tenant scoping and a monthly-consultation quota — no consent check exists anywhere.
Access control at open is plain RBAC (`@Authorize(['create','Consultation'])`), not attribute-based /
purpose-of-use / consent-scoped. `identity matching` and `minimum-necessary` are also both entirely absent as
named concepts (zero hits, repo-wide).

**Failure scenario:** there is no code path that can reject "start recording" or "load prior history" for lack of
patient consent, because there is no patient-consent record to check. Every consultation implicitly has
unconditional AI-documentation consent.

### F-05 detail — "Pause" does not durably checkpoint, and the one implementation doesn't stop capture

**Reference requires (T13, US-CL-16):** pausing durably checkpoints transcript/extraction/draft state; capture
stops accepting new audio; on resume nothing already done is re-processed; a hard cap auto-drafts to review.

**Code does:** the ONLY "pause"/"resume" implementation anywhere in the TS/Python tree (excluding audio-pipeline
buffer pause, an unrelated local concept in `packages/pipeline`/`packages/vad`) is
`packages/agentic-sdk-v2/src/compat/useArcaSessionManager.ts` — the **v1-API-compat shim**:

```
// packages/agentic-sdk-v2/src/compat/useArcaSessionManager.ts:192-199
const pauseSession = useCallback(async (): Promise<void> => {
  setLocalStatus('PAUSED');
}, []);
const resumeSession = useCallback(async (): Promise<void> => {
  setLocalStatus('ACTIVE');
}, []);
```

The file's own header documents this precisely: *"`pause`/`resume` have no v2 equivalent → local status only"*
(`:14`). Neither function touches `useArcaSession`, the audio pipeline, or any backend call — calling `pauseSession()`
sets a piece of local React state and does nothing else.

**Failure scenario:** any v1-compat consumer (`apps/example/src/compat-consultation.tsx`,
`apps/compat-playground`) that calls `pauseSession()` and shows the resulting `SessionStatus === 'PAUSED'` to a
user is presenting a **UI lie**: the underlying `useArcaSession` audio/transcription pipeline keeps running, keeps
capturing, keeps sending audio to STT — nothing "pauses." This directly contradicts US-CL-03's *"Mute/unmute is
obvious and immediately stops sending audio"* and T13's *"Transcription Agent stops accepting new audio."*

**Mitigating context:** usage is confined to the v1-compat layer (`apps/example`, `apps/compat-playground`) — not
the primary admin-console clinical workflow, which is presumably built on `useArca`'s own `pauseTranscription`
(a genuine, real audio-pipeline pause, distinct from this session-level stub — `useArca.ts:1348-1356`). The gap is
specifically in the *session-level* pause exposed to v1 API consumers migrating to v2, not in the raw audio
control. Severity is Medium-High because real external tenants integrated against the v1 contract may depend on
session-level pause semantics that are silently non-functional.

### F-06 detail — Two-phase drain exists only in the dormant loop

Already covered in the Two-orchestrator table. In the always-on Layer 1 path, "drain" means
`LiveDocumentationService.stop()` repeatedly flushing its OWN transcript buffer until caught up or stalled
(`live-documentation.service.ts:783-843,803`) — there is no concept of "await in-flight NLP/Vision/Verifier
agents with a bounded timeout, force-stop stragglers, mark sections incomplete" in this path, because Layer 1
only ever runs one `HarnessDocWorkflow` generation pass after stop, not several parallel agents to await. That
genuine multi-agent two-phase drain (`_drain()` + forced final replan + `ending_actions`,
`workflows.py:2099-2110`) exists only in `ConsultationLoopWorkflow`, gated off by default.

### F-07 detail — Sign-off can precede full safety/groundedness verification

**Reference requires (T18-T19, US-CL-12, UC-14):** *"Verifier/Quality and Compliance run medication, allergy,
laterality, dosage, negation, and patient-identity checks"* BEFORE the candidate is presented for review; a
verifier confidence below threshold or an unresolved safety-critical conflict **blocks** finalization
(UC-14 Main flow step 1: *"Safety checker blocks FINALIZED"*).

**Code does:** HOPE's "optimistic two-phase delivery" deliberately allows the opposite sequencing. When
`gate.optimistic_delivery_enabled` is on (`workflows.py:724-726`), the computational sensors settle and the draft
is delivered (`persist_draft`, status → `DRAFT_PENDING_SENSORS`) **before** the costly inferential pass
(groundedness + safety) has even started (`workflows.py:1216-1224`). `SummaryService.approveSummary` explicitly
permits signing at this point:

```
// packages/applications/src/services/consultation/summary/summary.service.ts:815-819
//   Q2a — signing BEFORE assurance lands is allowed with no acknowledgement;
//         a `SIGNED_BEFORE_ASSURANCE` WORM annotation is appended so the
//         late-verdict path (`finalizeAssurance` Q2b) can correlate.
```

The ONLY hard block is a **COMPLETED** safety FLAG (`:868-873`, `overridingSafetyFlag` — requires
`draftMeta.assuranceCompletedAt` to be set); if assurance is merely still *running* (not yet completed), signing
proceeds with **no acknowledgement banner required at the API level** (`:867`, `signedBeforeAssurance` is computed
and later only used to annotate the audit trail, `:956-973` — it never blocks). If the verdict later turns out
adverse (FLAG/REGEN), `finalizeAssurance` explicitly does **not** regress the already-signed note — it only
appends a `POST_SIGN_FLAG` WORM row for follow-up (`harness-internal.service.ts:1086-1113`).

**Failure scenario:** a clinician can click "approve" the instant the readable draft appears, before the
groundedness/safety judge has run at all. If that judge would have flagged the note (e.g. an unsupported dosage
claim), the note is *already signed and immutable* by the time the flag exists — the system's remedy is a
follow-up alert, not a block. This is a genuine, deliberate architectural trade-off ("RELAXED sign-off governance
(clinician autonomy + full audit)" per the code's own comment) rather than an oversight, but it is a real
divergence from the reference's stricter "verify-then-review-then-approve" ordering and from UC-14's "no
committed note contains an unresolved blocked safety item" for the specific case of a still-in-flight (not yet
completed) safety check.

### F-08 detail — Idempotent commit has a narrow TOCTOU race

`approveSummary`'s idempotency is a **read-then-check**, not a key or a transaction:
`getVersionsByChangeReason(contextItemId, 'approved')` (`summary.service.ts:841-850`) — if non-empty, return the
first approval's data with no new write. A genuinely concurrent double-submit (both requests read zero existing
approvals before either commits) computes the same `versionNumber = currentVersionNumber + 1`
(`:880`) and both attempt `ContextItemVersion.create`; the DB-level `@@unique([contextItemId, versionNumber])`
(`consultation.prisma:519`) rejects the second insert, so **a second `SIGNED_NOTE` cannot land** — but the loser
gets an unhandled DB error (500), not the graceful "already approved" response a genuine idempotency key would
give. There is also **no transaction** (`$transaction`/`runInTransaction`) around the version create, the WORM
audit appends, and the status flip (`:890-994`) — the code compensates by ordering fail-closed (WORM append before
the status flip, `:940-941` comment: *"any error propagates and aborts the approval BEFORE the consultation is
signed"*), but a failure between "SIGNED_NOTE version created" and "ATTEST WORM row written" leaves an orphaned,
un-audited `ContextItemVersion` with `changeReason='approved'` and no matching audit trail — worth a wave-2 look
at whether that orphan is ever cleaned up or merely invisible.

### F-09 detail — Generic ops signal endpoint can forge audit-trail attribution

`POST /admin/harness/workflows/:id/signal` (`harness-admin.controller.ts:485-493`), gated
`@Authorize(['manage','HarnessWorkflow'])` (tenant-admin-reachable, not super-admin-only), forwards an
**arbitrary, unrestricted** `signalName` + JSON `payload` straight to the Temporal workflow handle
(`harness-ops.client.ts` → `apps/harness/.../api/endpoints/admin.py: await handle.signal(...)`). Nothing stops an
operator from naming the signal `approval` with a payload shaped like `ApprovalSignal`
(`workflows.py:336-339`), resolving `HarnessDocWorkflow`'s gate wait condition. Traced precisely:

- This does **not** flip `Consultation.status` to `SIGNED` and does **not** create a `SIGNED_NOTE` — those live
  exclusively in `SummaryService.approveSummary`, never triggered by workflow gate resolution.
- The workflow's only post-gate write-back is `record_gate_decision` → `recordGateDecision`
  (`harness-internal.service.ts:1211-1247`), which appends **only** a `GATE_DECISION` WORM audit row, using
  `clinicianId`/`attestationHash` taken directly from the caller-supplied payload with **no cross-check** against
  any real `SIGNED_NOTE`/attestation.

So the practical impact is bounded — this cannot forge a signed clinical record — but it **can** let a
tenant-admin-privileged actor inject a `GATE_DECISION` WORM row with a fabricated clinician identity, which is a
genuine dent in US-CO-01's *"every... HITL decision recorded on an immutable, tamper-evident ledger"* (the entry
is tamper-EVIDENT once written, but not tamper-PROOF at write time for this one field). Severity Medium: requires
a specific elevated ability, and doesn't touch the clinical record itself.

### F-10, F-11, F-12 — brief

- **F-10 (Primed absent):** searched `Primed`/`PRIMED` repo-wide, zero hits. There is no gate that blocks
  Streaming from starting until prior-history review is acknowledged; `ConsultationChain`/`CASE_NOTE` provide
  the DATA linkage for prior visits but no PROCESS gate.
- **F-11 (Degraded is a flag, not a state):** see state table — functionally reasonable (the clinician-visible
  effect, "verification unavailable" labeling, is present per Agent A's read of `mcp_degraded`/`reduced_assurance`
  folding into `PersistDraftInput`), but there is no first-class `Consultation`-level "Degraded" status a
  dashboard or SLA query could filter on.
- **F-12 (event taxonomy):** `session.opened` — **ABSENT**, no distinct session-open event exists separate from
  workflow/context-item creation. `agent.timeout` — **CONFLATED**, `LOOP_EVENT_SPECIALIST_FAILED` is the closest
  named event but fires on any specialist failure, not specifically a timeout. `contradiction.detected` —
  **ABSENT** (see F-04). `note.revision.requested` — **ABSENT** as a named event; the functional regen loop exists
  (`regen_feedback`/`RegenFeedback`) but is never emitted as a discrete event. `hitl.edit` — **PARTIAL**: a real
  `edit` Temporal signal (`workflows.py:341-357`) crosses the TS→Python boundary from `summary.service.ts`'s
  `signalEdit` call and IS captured on the `ContextItemVersion` audit trail, but per Agent A it "is never itself
  emitted as a `loop_event`/trajectory event" — the boundary-crossing signal exists; the named taxonomy event does
  not.

## VIOLATED — ranked

1. **F-02 — "Closed" reachable without "Closed Approved."** Worst because it is the cleanest, fully-reproducible
   contradiction of an explicit reference invariant, with a one-line repro: call `POST :id/close` on a fresh,
   never-recorded consultation. Fix requires either wiring `closeConsultation()` to check
   `status === SIGNED` (or explicitly documenting that "close" is an unrelated administrative record-lifecycle
   action, distinct from clinical sign-off, and renaming/relabeling it so it stops overloading the reference's
   "Closed" vocabulary).
2. **F-07 — Sign-off can precede completed safety verification.** A deliberate, documented design trade-off, not
   a bug, but it is a genuine, non-trivial divergence from the reference's ordering guarantee, and it is the kind
   of thing a conformance review must surface explicitly rather than let ride as "already known internally."
   Repro: enable optimistic delivery (the code path exists whether or not the flag currently defaults on in this
   environment — Agent A did not confirm the default), approve the instant the readable draft appears, then watch
   the inferential pass return FLAG afterward — the note stays signed.
3. **F-09 — Ops signal endpoint can forge `GATE_DECISION` attribution.** Bounded blast radius (cannot fake a
   signed note) but a real audit-integrity gap reachable by a tenant-admin-scoped ability, not just a
   super-admin. Fix: either scope `signalName` to a safe allowlist (exclude `approval`), or cross-validate
   `clinicianId`/`attestationHash` against an actual `SIGNED_NOTE` version before writing `GATE_DECISION`.

## Divergences

- **F-07** (sign-before-assurance) — see above; a deliberate "clinician autonomy" trade-off vs. the reference's
  stricter sequencing.
- **TEXT generation failure propagates and fails the whole run** (`workflows.py` — `generate` has no
  `except ActivityError:` wrapper, per Agent A, "TEXT failure propagates (never silently downgrade)") — arguably
  reasonable (there is no content to review without a successful generation), but it means the reference's
  "independent tasks continue" philosophy (UC-11) applies to auxiliary sensors, not to the primary generation
  step itself. Not a violation, but worth naming as a boundary the reference doesn't draw as sharply.
- **Two independent "closed" trackers** (F-02) is architecturally a divergence in KIND, not just in
  implementation completeness — the reference imagines one state machine; the code has a pre-existing generic
  open/closed toggle plus a newer, harness-specific typed lifecycle bolted on afterward, and nothing unifies them.

## [ADDED] invariants

- **[ADDED-1]** A consultation's terminal "closed" representation MUST be single-sourced — no second,
  independently-writable field may represent the same semantic state. (Motivated directly by F-02; the reference
  doesn't discuss internal representation mechanics, only the semantic ordering.)
- **[ADDED-2]** Any admin/ops endpoint capable of resolving a durable workflow's clinical-gate wait condition
  (however indirectly) must either be excluded from generic signal-forwarding, or its resulting audit write must
  cross-validate the asserted clinician identity against a real, existing attestation record before persisting.
  (Motivated by F-09.)
- **[ADDED-3]** A session-level "pause" API surface must either genuinely stop upstream capture or must not
  expose a status value that claims it did. A UI-only relabeling masquerading as a lifecycle state is worse than
  no pause feature at all, because it creates a false sense of privacy/safety control. (Motivated by F-05.)
- **[ADDED-4]** Worth preserving from the current code as a GOOD pattern for any redesign: the idempotency-key
  discipline Agent A found on the Python side — execution-scoped keys (`workflow_run_id:activity_id`) for
  activity-retry duplicates, vs. content-hashed write-scoped keys (`sha256(content)` keyed to `consultation_id`)
  for cross-execution duplicates (two `document:start` calls) — is a genuinely well-reasoned two-tier idempotency
  model that a unified session workflow should keep, not flatten into one key scheme.

## Reference defects

- **`dataset.xml`'s `Consultation_Session_State` column implies mutually-exclusive states**, but Time 10.1's
  Note says *"Session enters Degraded, not Failed, if a safe draft remains possible"* and Time 11 immediately
  reverts to `Streaming` — the XML models Degraded as a single-row transient annotation rather than a state the
  machine actually occupies for a duration, which is inconsistent with every other row's framing (one row = one
  state, in effect until superseded). The reference would benefit from explicitly saying whether Degraded is a
  sub-state/flag ORed onto Streaming/Draining, or a true state — HOPE's own code (a boolean flag folded into the
  active phase, F-11) actually resolves this ambiguity more cleanly than the reference does.
- **"Closed Approved" (T21) and "Closed" (T23) as two separate top-level states** is arguably over-specified: T23's
  own Note says *"Closed here means Closed Approved has already occurred"* and its Activity describes an
  automatic system action (archive, TTL-expire scratch, write an anonymized episodic summary) with no additional
  human gate — i.e., "Closed" reads as a housekeeping FOLLOW-ON to the one real clinical event (signing), not an
  independently reachable state requiring its own transition guard. A future revision of the reference could
  merge these into one state with a "housekeeping complete" sub-flag, which would also have made F-02 impossible
  to misread as "two states, so two independent write paths are fine."
- **`REOPENED` appears only in `user-stories-and-use-cases.md` (UC-12's alternate flow), not in `dataset.xml`'s
  11-state enumeration** — an inconsistency between the two reference documents' state inventories.
  Interestingly, HOPE's OWN `ConsultationStatus` enum already has a (currently dead/unwritten) `REOPENED` member
  (`enums.prisma:285`), suggesting either prior awareness of this need or coincidental convergent naming — worth
  confirming which with the team before treating it as validation of the reference.
- **"Timed Out" is labeled a "terminal alternate"** but UC-12 immediately describes a non-terminal continuation
  (*"Clinician later reopens → REOPENED / resume HITL from the retained draft"*) — the terminology "terminal"
  is imprecise; it is better described as "terminal absent explicit reopening."

## Open questions for wave 2

1. **Cutover plan for `harness.loop.enabled`.** Most of this wave's ABSENT/PARTIAL verdicts for Draining,
   Timed-Out-as-state, multi-agent drain, and per-agent-timeout isolation become IMPLEMENTED once the kill-switch
   flips. Wave 2 should find out whether there's a migration plan, and specifically whether `LiveDocumentationService`
   staying a SEPARATE, un-migrated ephemeral-note engine (rather than being absorbed into the loop's own dispatch)
   is a permanent architecture decision or a temporary seam.
2. **Consent/ABAC (F-03) and contradiction detection (F-04) were searched repo-wide, not just in this lane** — if
   they genuinely don't exist anywhere in the monorepo, that is a platform-level gap outside "orchestration," and
   wave 2 (or a dedicated compliance-lane pass) should confirm with a fresh, independently-scoped search rather
   than trusting this lane's negative result alone.
3. **Who actually calls `useArcaSessionManager.pauseSession()` in production**, and whether any real (non-demo)
   tenant integration depends on it — determines whether F-05 is a documentation gap or a live safety issue.
4. **Whether `ConsultationStatus.CLOSED`/`REOPENED` are truly 100% dead**, including migration/backfill scripts
   and any Python-side write path this lane didn't scan (`apps/harness` writes to apps/api exclusively via the
   internal HTTP surface this lane DID cover, but a direct-DB backfill script would not show up in those greps).
5. **The Specialist/reasoning lane** (`plan_reasoning`, `run_specialist`, `record_adjudication`,
   `AdjudicationConflict` in `models.py:1525-1533`) is the closest existing scaffolding to contradiction handling
   — it reconciles disagreeing SPECIALIST OPINIONS by confidence, not clinical facts from transcript vs.
   image/history, but a dedicated wave-2 pass on it might find it's a nearer starting point for F-04 than "build
   contradiction detection from scratch."
6. **MCP/tool-gateway consent enforcement (US-CO-03).** The terminology-validation MCP call path is read-only and
   PHI-screened (`phi_enabled`/`phi_fail_closed`), but this lane found no per-patient consent-scope check gating
   it — confirm there's no separate compliance layer this lane missed before treating US-CO-03 as ABSENT
   platform-wide.
