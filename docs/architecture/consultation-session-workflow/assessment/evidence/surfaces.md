# HOPE Consultation Conformance Audit — Wave 1, Lane E: Surfaces

Gateway API (`apps/api`) · Vox SDK (`packages/agentic-sdk-v2`, `packages/vox-node`) · Admin console (`apps/admin-console`) · UI (`packages/ui`)

## Scope & method

Read in full: `docs/architecture/consultation-session-workflow/user-stories-and-use-cases.md` (40 stories / 18 use-cases) and `dataset.xml` (24-step session timeline). Both are treated as references, not gospel — gaps against them are findings, not automatically bugs, and places where the reference itself is unimplementable/over-specified are logged separately.

Research was split into three parallel deep-dive passes over the code as it exists today on `feat/loop`, each returning file:line evidence, no ticket numbers, no `docs/implementation/**`/`docs/archive/**` citations:

1. **Gateway API** — `apps/api/src/modules/consultation/**`, `.../streaming/**`, `.../consultation-context-schema/**`, plus every WS/SSE route touching sessions/transcripts/notes/summaries found by broad grep (`stt-ws.gateway.ts`, `stt-compat.gateway.ts`, `text-proxy.controller.ts`, `harness-internal.controller.ts`, `harness-admin.controller.ts`, `agent-trajectory.controller.ts`, `prompt-management/*`), and the `packages/applications`/`packages/database` layers those controllers call into.
2. **Vox SDK** — `packages/agentic-sdk-v2/src/{hooks,store,core,types}`, `packages/vox-node/src`, and (following the trail) `packages/room`, `packages/stt`, `packages/vad`, `packages/noise-filter` for the mute/audio-pipeline trace.
3. **Admin console + UI** — `apps/admin-console/src/{app,features}` (consultation/playground/AI/governance screens) and `packages/ui/src/components/{live-transcript,editor,timeline,data-grid,custom,elevenlabs,shared,shadcn}`.

All three excluded `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`. `apps/harness` (Python/Temporal — where the actual agentic loop, drafting, and verifier logic runs) and `apps/nlp` were **not** in this lane's scope; every place that boundary matters is flagged explicitly below and repeated in "Open questions for wave 2."

Verdict legend: **IMPLEMENTED** / **PARTIAL** / **ABSENT** / **VIOLATED** (code today actively does what the reference forbids). "ABSENT-in-scope" means the three surfaces audited here show no trace of the capability, but the actual logic may live in `apps/harness` or `apps/nlp`, which this lane did not read.

---

## Surface map

### Gateway API (`apps/api`)

| Route / Gateway | File | Role |
|---|---|---|
| `POST consultations/open`, `GET/PATCH :id`, `POST :id/recording/{start,stop}` | `apps/api/src/modules/consultation/consultation.controller.ts` | Session lifecycle (get-or-create), recording boundary toggles |
| `GET :id/live-summary/stream`, `:id/harness-progress/stream`, `:id/harness-assurance/stream`, `:id/trajectory/stream`, `:id/loop/stream` | `consultation.controller.ts:526-674` | SSE: live running-summary, draft-generation progress, per-claim safety verdicts, agentic trajectory, loop-workflow events |
| `PATCH :id/context/:contextId`, `POST :id/context`, `POST :id/highlights`, `POST :id/recordings` | `consultation.controller.ts` | Context-item CRUD (case notes, worknotes, transcriptions, attachments), manual highlights, dual-capture recording attach |
| `PATCH :id/summary/:summaryId`, `POST :id/summary/:contextItemId/approve`, `GET :id/summary/:contextItemId/provenance`, `.../versions`, `.../diff` | `consultation.controller.ts:981-1026` | Note edit, whole-document sign-off, QA provenance graph, version history/diff |
| `GET :id/named-entities` | `consultation.controller.ts:1301-1311` | Aggregate NER read (closest thing to a terminology surface found in scope) |
| `WebSocketGateway /ws/stt/stream` | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | Primary live-transcription WS: handshake/ticket auth, audio ingest, partial/final relay, resume/reconnect, backpressure |
| `WebSocketGateway /stt` | `apps/api/src/modules/stt-compat/stt-compat.gateway.ts` | Legacy v1-compat STT WS |
| `POST audio/transcription-jobs/stream/session`, `.../switch-to-fallback`, `.../switch-to-primary` | `apps/api/src/modules/streaming/transcription-job.controller.ts` | Streaming session mint, mid-session ASR engine switch |
| `POST internal/harness/consultations/:id/{entities,assemble,draft,gate-decision,escalation,assurance,progress,loop-event}` | `apps/api/src/modules/consultation/harness/harness-internal.controller.ts` | Service-token-only inbound half of the apps/harness↔apps/api adapter — WORM-audits generation/gate/escalation, **never itself signs a note** |
| `GET/PATCH admin/harness/policy[,/global]`, `GET admin/harness/audit`, `.../gate-queue`, `.../edit-burden`, `.../gate-edit-exemplars`, `.../golden-sets`, `.../workflows*`, `.../live/{sessions,config}` | `apps/api/src/modules/consultation/harness/harness-admin.controller.ts` | Tenant/global harness policy (incl. `guideline-retrieval` toggle), WORM audit reader, gate backlog, edit-distance/completeness signal, golden-set/eval management, Temporal workflow proxy |
| `GET admin/agent-trajectory/{sessions,sessions/:id/steps,metrics/generation}` | `apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts` | Tool-call/agentic trajectory reader (QA provenance component #3) |
| `GET/PATCH/DELETE admin/consultation-context-schemas*`, `GET tenant/me/context-schema` | `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts` | Versioned, immutable-per-version context-schema declaration + tenant discovery |
| `POST/PATCH prompt-templates*` | `apps/api/src/modules/prompt-management/prompt-template.controller.ts` | Clinician template selection + personal-template CRUD, OCC-protected |
| `POST text/generate[,/assembled]`, `GET text/tasks/:id[,/stream]` | `apps/api/src/modules/streaming/text-proxy.controller.ts` | Text generation proxy with cross-tenant/cross-doctor ownership checks |
| `GET/PATCH admin/consultations*`, `.../aggregate` | `apps/api/src/modules/consultation/admin-consultation.controller.ts` | Tenant-wide consultation listing + volume aggregation |

### Vox SDK (`packages/agentic-sdk-v2`, `packages/vox-node`, `packages/room`)

| Hook / Client | File | Role |
|---|---|---|
| `useArcaSession` | `src/hooks/useArcaSession.ts` | `open` (get-or-create only — no separate create/pause/resume lifecycle), `addContext`, `getPatientHistory`, `loadConsultation`, `close`, `reopen` |
| `useArcaAudio` | `src/hooks/useArcaAudio.ts` | `start`/`stop`/`mute`/`unmute`, multi-source add/remove/gain, provider switch/fallback, `sttConnectionState`, dropped-frame/bitrate telemetry |
| `useArcaPipelines` | `src/hooks/useArcaPipelines.ts` | `pauseTranscription`/`resumeTranscription` (local pipeline-stage disable, not a session-level pause) |
| `useArcaContext` | `src/hooks/useArcaContext.ts` | Case notes/worknotes/attachments/transcriptions CRUD, entity extraction trigger |
| `useArcaSummary` | `src/hooks/useArcaSummary.ts` | `generateSummary`/`generatePreSummary`(Async), `updateSummary`, `approveSummary`, version compare/diff, tags — all whole-document |
| `useArcaLiveSummary` | `src/hooks/useArcaLiveSummary.ts` | SSE subscription to `LiveSummarySnapshot` while recording |
| `useConsultationEvents` | `src/hooks/useConsultationEvents.ts` | SSE `LoopEvent` stream (generic workflow-progress, no approval taxonomy) |
| `useHarnessAdmin` (`listGateQueue` etc.) | `src/hooks/useHarnessAdmin.ts` | Read-only ops view of the harness gate backlog |
| `useDnaStyle`/`useDnaDashboard` | `src/hooks/` | Writing-style ("DNA") profile CRUD + tenant admin dashboard |
| `SttWebSocketClient` | `src/core/SttWebSocketClient.ts` | Streaming STT transport: reconnect/backoff, seq-cursor resume handshake, backpressure queue |
| `AgenticClient` | `src/core/AgenticClient.ts` | REST transport: single-slot 401 refresh, idempotency keys, ETag/If-Match OCC support (client-side capability exists even where server routes don't use it — see F-06) |
| `TranscriptionPipeline` / `PluginManager` | `src/core/` | Client-side NoiseFilter→VAD→STT orchestration; `sttIsProcessing` flag |
| `types/citations.ts` (`CitationClaim`, `ClinicalReviewData`, utils) | `src/types/citations.ts`, `src/utils/citations.ts` | Fully-typed per-clause citation/confidence contract — **zero hook or consumer wires it up anywhere**, including admin-console (see F-19) |
| `AudioTrack.mute()` | `packages/room/src/core/AudioTrack.ts:238-244` | Lower-level primitive implementing the same `track.enabled = false` pattern |
| `HopeClient` + `ConsultationSummariesResource`/`SummarizationResource`/`JobsResource` | `packages/vox-node/src/` | Server-side API-key SDK — generate/list/latest/update, no approve/section/consent methods |

### Admin console (`apps/admin-console`) + `@arcaai/ui`

| Route (under `(console)/`) | Tier | Role |
|---|---|---|
| `(tenant)/playground/consultation` | 50-59 | Consultation Scribe workspace — live capture, transcript, personalized SOAP draft, whole-note sign-off |
| `(tenant)/playground/live-transcription` | 50-59 | Raw STT streaming/batch playground |
| `(tenant)/playground/{voice-profiles,dna-writing-style,llm}` | 50-59 | Voice enrollment, writing-style DNA, prompt-template test bench |
| `(tenant)/consultations` | 30-49 | Tenant-admin read-only list + lineage detail sheet |
| `(tenant)/consultation-review` | 30-49 | Per-consultation claim→transcript-span citation viewer |
| `(tenant)/prompt-templates` | 30-49 | Fallbacks / Templates / Governance (versions, diff, clinical approval, eval gate) |
| `(tenant)/dna-writing-styles`, `context-schemas`, `agentic-policy`, `harness/policy`, `harness/pipeline-policy`, `audio/pipelines`, `audio/transcription-jobs`, `ai-configuration` | 30-49 | Tenant-scoped AI/governance config screens |
| `(tenant)/harness/observability` | 30-49 | **QA/provenance dashboard**: WORM audit trail, eval runs, gate queue, golden sets, edit-burden, gate→golden-case promotion |
| `(tenant)/harness/workflows` | 30-49 | Temporal workflow observability |
| `(global)/ai-operations/{metrics,runs,consumption,reconciliation}` | 10-19 (+ WorkingTenantGate) | LLM throughput/latency dashboard, per-run trajectory inspector, usage/cost |
| `(shared)/settings` | 20-29 | Generic `GlobalSetting` grid where retention-TTL/audit-retention keys surface generically |

| `@arcaai/ui` component | Path | Role |
|---|---|---|
| `LiveTranscript`, `TranscriptSegment`, `TranscriptWord`, `SegmentEditor`, `ListeningPulse`, `JumpToLive` | `packages/ui/src/components/live-transcript/` | Virtualized live transcript, final/partial styling, per-word karaoke highlight, inline transcript correction |
| `AudioMeter` | `packages/ui/src/components/custom/audio-meter.tsx` | Level meter, supports `isMuted` prop — unused live |
| `ConversationBar`, `MicSelector` | `packages/ui/src/components/elevenlabs/` | Working mute/mic-picker widgets — **not consumed anywhere in admin-console** |
| `HistoryTimelineList`, `ScrollSpyTimeline` | `packages/ui/src/components/timeline/` | Generic timeline — only consumer is the `changelog` feature, not any consultation surface |
| `StatusBadge` | `packages/ui/src/components/shared/status-badge.tsx` | Icon+label badge, house pattern for "never color alone" |
| Lexical `Editor` shell | `packages/ui/src/components/editor/` | Bare content-editable + theme; only wired consumer is `SegmentEditor` (transcript correction), **not** the generated note |

---

## Story coverage table

Y = surface has a real, wired implementation; P = partial/typed-but-unwired/coarser-than-required; N = not found in this lane's scope.

| Story ID | Title | Persona | API | SDK | UI | Verdict |
|---|---|---|---|---|---|---|
| US-CL-01 | Load relevant prior history | Clinician | P (`getPatientHistory` exists, unverified depth) | P | N | **PARTIAL** |
| US-CL-02 | Control historical retrieval scope | Clinician | N | N | N | **ABSENT** |
| US-CL-03 | Start ambient capture safely | Clinician | P | Y (mute) / P (fallback) | Y (record) / N (mute UI) | **VIOLATED** (consent gate) |
| US-CL-04 | See safe partial transcription | Clinician | Y | P (no segment id) | Y | **PARTIAL** |
| US-CL-05 | Attach imaging or radiology report | Clinician | P (generic attach only) | N | N | **ABSENT-in-scope** |
| US-CL-06 | Maintain an evolving work note | Clinician | P | P | P | **PARTIAL** |
| US-CL-07 | Ask evidence-grounded questions | Clinician | P | P (rich types, thin wiring) | P | **PARTIAL** |
| US-CL-08 | Live CDS without interrupting note | Clinician | N | N | N | **ABSENT** |
| US-CL-09 | Bind codes only through terminology tools | Clinician | N (in scope) | N | N | **ABSENT-in-scope** |
| US-CL-10 | Override AI with authoritative correction | Clinician | P (`changeSource`, versions) | P | N | **PARTIAL** |
| US-CL-11 | Learn documentation style safely | Clinician | P | Y | Y | **PARTIAL** |
| US-CL-12 | Review a candidate final note | Clinician | P | P | P | **PARTIAL** |
| US-CL-13 | Approve, edit, or reject by section | Clinician | N | N | N | **ABSENT** |
| US-CL-14 | Finalize only with explicit responsibility | Clinician | Y | Y | Y (no confirm dialog) | **IMPLEMENTED** |
| US-CL-15 | Get a template-conformant summary | Clinician | Y (render) / N (reformat-on-switch) | P | P | **PARTIAL** |
| US-CL-16 | Pause and resume without losing work | Clinician | P (reconnect only) | P | N (no pause UI) | **PARTIAL** |
| US-CL-17 | See where each clause came from | Clinician | N | N | N | **ABSENT** |
| US-CL-18 | Receive assisted coding suggestions | Clinician | N (in scope) | N | N | **ABSENT-in-scope** |
| US-SP-01 | Open a specialty briefing | Specialist | N | N | N | **ABSENT / open question** |
| US-SP-02 | Cite guidelines with version/effective date | Specialist | N | N | N | **ABSENT** |
| US-SP-03 | Leave a structured handoff | Specialist | N | N | N | **ABSENT / open question** |
| US-NU-01 | Extract follow-up tasks | Nurse | N | N | N | **ABSENT / open question** |
| US-TH-01 | Resume a dropped remote session | Telehealth clinician | P (same as US-CL-16) | P | N | **PARTIAL** |
| US-SC-01 | Review a cited draft efficiently | Scribe | Y (provenance) | P | Y | **PARTIAL** |
| US-SC-02 | Switch templates without full regen | Scribe | N | N | N (inert control) | **ABSENT** |
| US-SC-03 | Draft/verified/approved labels | Scribe | P (whole-doc only) | P | P | **PARTIAL** |
| US-QA-01 | Provenance graph of a finalized note | QA reviewer | Y | — | Y | **IMPLEMENTED** |
| US-QA-02 | Quality trends across the tenant | QA reviewer | P | — | P | **PARTIAL** |
| US-AD-01 | Configure and version note templates | Tenant admin | Y | — | Y | **IMPLEMENTED** |
| US-AD-02 | Configure audio pipeline and fallback | Tenant admin | Y | Y | Y | **IMPLEMENTED** |
| US-AD-03 | Control the guideline library | Tenant admin | P (toggle, no allowlist) | — | P | **ABSENT (vs spec) / PARTIAL** |
| US-AD-04 | Set retention TTLs by artifact class | Tenant admin | P (2 classes, platform-wide) | — | P | **PARTIAL** |
| US-AD-05 | Operate quality/throughput dashboards | Tenant admin | P | — | Y (for what exists) | **PARTIAL** |
| US-CO-01 | Keep an immutable audit ledger | Compliance/DPO | Y | — | Y | **IMPLEMENTED** |
| US-CO-02 | Honor data-subject rights (GDPR) | Compliance/DPO | N (not investigated) | N | N | **open question** |
| US-CO-03 | Enforce consent at the tool gateway | Compliance/DPO | N | N | N | **ABSENT** |
| US-PT-01 | Grant/revoke AI-documentation consent | Patient | N | N | N | **ABSENT** |
| US-PT-02 | See which parts were AI-drafted | Patient | N | N | N | **ABSENT** |
| US-PT-03 | Prior visits inform this one | Patient | P (same as US-CL-01) | P | N | **PARTIAL / ABSENT-leaning** |
| US-PT-04 | After-visit info only from approved notes | Patient | N | N | N | **ABSENT** |

No admin-console/SDK column applies to compliance/QA/admin dashboard stories in the same way as clinician stories — marked `—` where the surface genuinely doesn't apply (e.g. a patient-facing SDK hook).

---

## Conformance findings

| ID | Invariant | Ref | Verdict | Evidence | Severity |
|---|---|---|---|---|---|
| F-01 | Record does not start until AI-documentation consent + ABAC succeed | US-CL-03 AC1, T1 | **VIOLATED** | No consent check anywhere on open/audio-start path | Critical |
| F-02 | A patient AI-documentation consent model exists at all | US-PT-01, US-CO-03, T1 | **ABSENT** | No `Consent` Prisma model, no controller, no SDK type, no screen | Critical |
| F-03 | Mute is obvious and immediately stops sending audio | US-CL-03 AC2, T4 | **PARTIAL** | SDK mute is real (`track.enabled=false`); zero UI surface exposes it | High |
| F-04 | Approve/edit/reject/return-for-regen per section, each a separate audit event | US-CL-13, UC-05, T19-20 | **ABSENT** | Only one whole-document `POST .../approve` exists across API/SDK/UI | Critical |
| F-05 | Each clause labeled by origin (patient-reported/clinician-observed/imported/AI-derived) | US-CL-17 | **ABSENT** | No origin-class field anywhere in DTOs, store types, or UI | High |
| F-06 | User-authored text protected from automatic overwrite; commit uses optimistic concurrency | UC-05 postcondition, US-CL-06/13 ACs, T5/T8/T16 | **VIOLATED** | Note/section writes use plain `.update()`, not `.updateWithVersion()`, no `@RequiresIfMatch` | Critical |
| F-07 | Coded findings bound only through a verified terminology tool | US-CL-09, US-CL-18, UC-03 | **ABSENT-in-scope** | No terminology-binding endpoint found in `apps/api` consultation/streaming scope | Medium (needs wave 2) |
| F-08 | Switching templates reformats existing evidence rather than regenerating | US-CL-15 AC4, US-SC-02 | **ABSENT** | No reformat operation exists; admin-console's template selector is a hardcoded no-op | Medium |
| F-09 | Pause persists a checkpoint distinct from stop; resume avoids re-processing | US-CL-16, UC-13, T13-14 | **PARTIAL** | Reconnect-resume (network drop) is solid; user-initiated pause is dead code + no UI | Medium |
| F-10 | Priming brief shows source, date, link, imported-vs-current, retrieval scope, widen-scope action | US-CL-01/02, US-PT-03, T2-3 | **PARTIAL** | `getPatientHistory` SDK hook exists; zero UI screen consumes it | High |
| F-11 | Guideline sources are an explicit allowlist with defined precedence | US-AD-03, US-SP-02 | **ABSENT (vs spec)** | Only a single on/off `guideline-retrieval` toggle exists | Medium |
| F-12 | Retention TTL configurable per artifact class, per jurisdiction | US-AD-04 | **PARTIAL** | Only `AuditLog` (365d) and `AgentTrajectory` (30d), both platform-wide; no TTL on transcripts/recordings/notes | High |
| F-13 | Per-clinician rejection rate / per-template completeness / per-guideline citation frequency dashboard | US-QA-02, US-AD-05 | **PARTIAL** | LLM ops metrics + per-consultation edit-burden exist; no tenant-wide aggregate of the specific signals asked for | Medium |
| F-14 | Confirmation before an effectively-irreversible clinical action | [ADDED], spirit of US-CL-14 | **PARTIAL** | Sign-off fires the mutation on click with no `ConfirmDialog`, unlike the equivalent "Activate version" action elsewhere in the same app | Low-Medium |
| F-15 | Superseded partial spans remain in the ledger and are addressable | US-CL-04 AC4 | **PARTIAL** | `TranscriptSegment` has no stable id; supersession is positional only | Medium |
| F-16 | Timeout produces a distinct, visibly-unsigned state with clinician notification | US-CL-14, UC-12, T24 | **PARTIAL** | No `TIMED_OUT` status in the enum; no notification pathway found in this lane's scope | Medium |
| F-17 | Session state machine models Primed/Draining as distinct states | dataset.xml | **PARTIAL** (informational) | Enum is `OPEN→RECORDING→DRAFT_PENDING_SENSORS→PENDING_REVIEW→SIGNED→CLOSED(→REOPENED)` | Low |
| F-18 | A patient-facing surface exists for consent, transparency, after-visit info | US-PT-01/02/03/04 | **ABSENT** | No patient app anywhere in `apps/` | Structural |
| F-19 | Citation/provenance client contract is actually consumed | [ADDED], US-SC-01 | **PARTIAL** | `ClinicalReviewData`/`citations.ts` fully typed, zero consumers; admin-console reimplements its own highlight logic | Low |
| F-20 | Contradictions (image-vs-speech, history-vs-current) are surfaced, not silently merged | US-CL-10 deps, UC-09/10, T6.1/12.4 | **ABSENT-in-scope** | No contradiction-handling endpoint found in `apps/api` scope | High (needs wave 2) |
| F-21 | Imaging intake prefers an authenticated report over image-only interpretation and isolates image-derived suggestions | US-CL-05, UC-02 | **ABSENT-in-scope** | Only generic `ATTACHMENT`/dual-capture-recording attach found; no vision/report-preference pipeline in scope | High (needs wave 2) |

### Detail — every PARTIAL / ABSENT / VIOLATED item

**F-01 — Consent gate before capture (VIOLATED).** The reference is explicit: *"Record does not start until consent for AI-drafting and ABAC scope succeed; failure aborts and audits"* (US-CL-03 AC1); T1 makes this the first compliance gate before anything else runs. In the code, `ConsultationController.open` (`apps/api/src/modules/consultation/consultation.controller.ts:342`) is gated only by `@Authorize(['create','Consultation'])` and `ConsultationService.getOrCreate` (`packages/applications/src/services/consultation/consultation/consultation.service.ts:98-158`) runs a tenant check + entitlements quota check — no consent field exists on `OpenConsultationRequest`. `POST audio/transcription-jobs/stream/session` (`transcription-job.controller.ts:571-691`) and the WS handshake in `SttWsGateway.handleConnection` (`stt-ws.gateway.ts:425-603`) check concurrency quota, origin, ticket scope, and tenant binding — never consent. The SDK has no consent field on `OpenSessionInput`/`AudioStartOptions` and never checks one before calling the API. Admin-console's Record button (`handleStart`, `apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx:309-325`) is enabled purely by `canRecord={!!consultation && !isClosed}`. **Failure scenario:** any authenticated clinician opens a consultation and starts live capture for any patient in their tenant; PHI audio streams into the AI pipeline with no record, anywhere in the stack, that AI-documentation consent was ever obtained. Classified VIOLATED rather than merely ABSENT because the reference states a specific runtime behavior ("does not start until...") and the shipped Record control's actual behavior is the direct negation of that — it always starts.

**F-02 — Patient consent model (ABSENT).** No `Consent`-named Prisma model exists (`grep "^model " packages/database/src/prisma/db_main/*.prisma | grep -i consent` → none). No consent controller/service exists in `apps/api` or `packages/applications`. The only trace anywhere in the codebase is two dead `HarnessAuditAction` enum members, `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` (`packages/database/src/prisma/db_main/harness.prisma:24-25`, mirrored in `packages/domains/src/enums/generated/HarnessAuditAction.ts:10-11`) — a repo-wide grep of both strings finds zero write call sites; their only two non-generated references are filter-dropdown options on the audit-log admin screen (`apps/admin-console/src/features/harness-ops/{api/types.ts, components/harness-observability-screen.tsx:27-28}`). This underpins F-01, US-CO-03, and the entire US-PT-* epic.

**F-03 — Mute UI surface (PARTIAL).** Full trace (SDK lane): `useArcaAudio.muteAudio()` (`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:1560-1566`) calls `applyEnabledToAllSources(false)` (`:1545-1558`), which sets `MediaStreamTrack.enabled = false` on every audio track across every source stream the session owns, de-duplicated by track identity. Per the Media Capture spec this zeroes the samples at the `MediaStreamAudioSourceNode` level for every downstream DSP stage (`packages/stt/src/core/audioCapture.ts:94-95`, `packages/vad/src/processors/VADProcessor.ts:238`, `packages/noise-filter/src/processors/NoiseFilterProcessor.ts:125` all build their graph from the same track object) — this is enforced by the browser, not bypassable pipeline code. A code comment at `useArcaAudio.ts:1527-1543` documents this was fixed from a real prior bug where mute only touched the first source. This is a genuinely correct mute. The gap: `AudioMeter`'s `isMuted` prop is hardcoded `false` at its only admin-console call site (`apps/admin-console/src/features/playground-live-transcription/components/streaming-tab.tsx:153`), and the working `ConversationBar`/`MicSelector` mute widgets in `packages/ui/src/components/elevenlabs/` are never imported by admin-console. **Failure scenario:** a clinician using the shipped Consultation Scribe screen today has no way to mute at all — not a fake mute, an absent one — so the only way to stop capture mid-conversation is a full Stop (losing session continuity) or leaving the mic open through a sensitive moment.

**F-04 — Section-level HITL (ABSENT).** All three lanes independently confirm the same shape: `PATCH :id/summary/:summaryId` and `POST :id/summary/:contextItemId/approve` (`consultation.controller.ts:981-997, 1288-1297`) both operate on the whole `contextItemId` document; `SummaryApprovalRequest` carries only `overrideSafetyFlag`, no section identifier; `SummaryService.approveSummary` (`summary.service.ts:824-1001`) writes one `SIGNED_NOTE` version and flips `Consultation.status → SIGNED` for the entire note. No `regenerat*` route exists anywhere in the module. `useArcaSummary.approveSummary(contextItemId)` (`packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts:316-339`) mirrors this exactly — one id, no section discriminator. In the UI, `case-note-column.tsx:378-385` and `documentation-review-panel.tsx:237-243` each expose exactly one action, "Sign & save" / "Approve & sign-off," over the entire draft; the only section-shaped rendering is a read-only live SOAP preview with no buttons attached per section. Note: a per-SOAP-section **diff** does exist (`ContextItemVersion.fieldChanges`, `content-diff.util.ts:6-48`) — a clinician can *see* what changed per section, but cannot *decide* per section. **Failure scenario:** a clinician who agrees with Subjective/Objective but wants only the Plan section regenerated has no way to express that short of manually editing the whole text block; there is also no per-section audit trail for QA to later determine which sections were AI-accepted vs. rewritten (US-QA-01's "which sections were AI-accepted versus rewritten" is consequently unanswerable at the section level — only at the whole-document level via version history).

**F-05 — Clause origin labeling (ABSENT).** `LiveSummarySection` (`packages/agentic-sdk-v2/src/types/liveSummary.ts:21-25`) is `{ title: string; content: string }` — no status/origin/id field. `SummaryResponse.status` (`types/summary.ts:76-77`, `DRAFT`/`APPROVED`/`LOCKED`) and `CitationClaim.status` (`'verified'|'unverified'|'flagged'`, `types/citations.ts:33,66`) are the closest analogues, but the former is whole-document and the latter means "did the harness's sensors ground this claim in the transcript," not "who authored this text." The one authorship-adjacent field, `UpdateSummaryOptions.changeSource: 'doctor_edit'|'ai_regeneration'|'system'` (`types/summary.ts:287,300`), is recorded per version-history *event*, not rendered per clause in the live document. In the UI, AI badges exist only on auxiliary panels — vitals block and the citation-evidence panel (`case-note-column.tsx:314-319`, `citation-evidence-panel.tsx:57-59`) — while the note *body* itself renders as one undifferentiated block (`<article aria-label="Personalized draft note">{draft.content}</article>`, `case-note-column.tsx:271-274`) with **no edit affordance on the note text at all**, so there is no mechanism to even produce a clinician-edited clause to label in the first place.

**F-06 — Optimistic concurrency on note/section writes (VIOLATED against the house pattern and the reference).** None of the three content-mutation routes use the OCC pattern this exact module family uses everywhere else: `SummaryService.updateSummary` → `this.contextItemRepository.update(...)` not `.updateWithVersion(...)` (`summary.service.ts:767`); `approveSummary` → same (`:994`); `ContextService.updateContext` → same (`context.service.ts:519`). By contrast, `ConsultationContextSchemaAdminController.update`, `PromptTemplateController.updatePersonal`, and `HarnessAdminController.updatePolicy` all correctly carry `@RequiresIfMatch()` + `@ExpectedVersion()` — proving the pattern is known and used in sibling controllers, just not on the note-content path. This directly contradicts a recurring, four-times-independently-stated reference invariant ("User-authored text, when present, is protected from automatic overwrite" appears at T5, T8, T16, and as US-CL-06 AC4/US-CL-13 AC4) and the UC-05 postcondition "Commit uses idempotency keys and optimistic concurrency." **Failure scenario:** clinician A opens the note; clinician B (or the same clinician in a second tab, or a stale retry after a network blip) edits and saves; A's subsequent save on stale content silently last-write-wins over B's edit — no 412, no warning, no merge prompt. This is the sharpest gap in the whole audit because it is a *regression relative to code that already exists two files away* — the pattern was clearly available and simply wasn't applied here.

**F-07 — Terminology binding (ABSENT-in-scope).** A repo-wide search inside `apps/api/src/modules/{consultation,streaming,consultation-context-schema}` found no terminology-MCP-style binding endpoint; `GET :id/named-entities` (`consultation.controller.ts:1301-1311`) is a read of an aggregate NER result, not a bind-through-tool-gateway write with `system/code/display/lookupTimestamp`. Neither the SDK nor admin-console expose anything resembling US-CL-09's "coded findings mapped to approved terminology through a controlled tool" or US-CL-18's post-verification coding-suggestion step. This may legitimately live in `apps/nlp` (medical NER/classification service) which this lane did not read — flagged for wave 2, not asserted as a platform-wide gap.

**F-08 — Template switch does not reformat (ABSENT).** `GenerateSummaryRequest`/`GeneratePreSummaryRequest` accept a `template` field per generation call (`consultation.controller.ts:1156,1193`), so a *future* generation can use a different template — but there is no operation anywhere (confirmed absent by grep across the consultation module) that takes existing evidence/sections and re-projects them into a new template's structure. In admin-console, the only UI surface that looks like a template switch is the scribe footer's "Note assistant" `ModelSelector` (`scribe-footer.tsx:88-90`), whose options list is hardcoded to contain only the one model that already produced the current draft (`consultation-demo-screen.tsx:393-399`, comment: *"The note model isn't a picker endpoint yet"*) and whose `onNoteChange={() => undefined}` (`:483`) is a true no-op — the control renders as a normal, non-disabled `<Select>`, visually indistinguishable from a working one. Not clinically deceptive today (there is only ever one option), but it is an inert-looking-interactive control worth fixing before it ships with >1 option.

**F-09 — Pause vs. stop (PARTIAL).** Server: `writeControlCommand` accepts `'finalize'|'pause'|'resume'|'cancel'` (`streamingAudioBridge.service.ts:298`), but a grep of every gateway call site shows only `'finalize'` is ever sent (`stt-ws.gateway.ts:1084`, `stt-compat.gateway.ts:183`) — `pause`/`resume`/`cancel` are unreachable dead code from the WS layer. What *is* real and correctly implemented is reconnect: `SttWsGateway.handleResume` (`stt-ws.gateway.ts:1156-1208`) replays only buffered transcripts with `seq > lastSeq` from a bounded 200-entry buffer and explicitly rejects a false resume on a freshly-created session, matching the SDK's mirrored seq-cursor resume handshake (`SttWebSocketClient.ts:1267-1268`, `sendResumeHandshake`) — network-drop resume genuinely avoids re-transcription. Client-side: `useArcaPipelines().pauseTranscription()/resumeTranscription()` exist (`useArcaPipelines.ts:55-81`) but only disable/enable local DSP stages, not a session-durable pause; `useArcaSession.ts` doc-comments outright: *"No pause/resume/end lifecycle management."* No session/store state persists outside the in-memory Zustand store, so a page reload during a pause loses everything client-side (server-persisted `TranscriptSegment` rows survive, but the client has no rehydrate-on-reload path confirmed in this lane). In the UI, no pause button exists anywhere (grep confirms only a static "VAD auto-pause on" config description string, not a control) — the only user-visible state is a reconnect banner, which communicates connection loss, not clinician-initiated pause.

**F-10 — Priming/history UI (PARTIAL, needs wave 2).** `useArcaSession` includes a `getPatientHistory` method (`hooks/useArcaSession.ts`, per the SDK surface inventory) but this lane did not trace its backend implementation or find any admin-console screen that consumes it. `ConsultationDetailPanel` (`apps/admin-console/src/features/consultations/components/consultation-detail-panel.tsx:136-146`) shows a `parentConsultationId` with a copy button on a "Read-only — no mutations" admin audit sheet — pure lineage metadata, not a clinician-facing priming brief, and it carries no date-range/source-system scope display or widen-scope control. Grepping `priming|prior consult*|prior visit|previous visit` across admin-console returns nothing. **This is a genuine capability gap in the shipped product regardless of what wave 2 finds in the backend**: even if `getPatientHistory` is fully implemented server-side, no clinician-facing screen surfaces it today.

**F-11 — Guideline allowlist (ABSENT relative to the specific requirement).** The only "guideline" control anywhere is a single tri-state `guideline-retrieval` boolean on `HarnessPolicy` (`packages/applications/src/services/harness-policy/dto/update-harness-policy.request.ts:131`, editable via `apps/admin-console/src/features/agentic-policy/components/agentic-knobs.ts:36`) — enable/disable retrieval wholesale. US-AD-03 requires "an explicit allowlist" of sources plus "defined precedence for conflicts" — neither exists at any layer.

**F-12 — Retention TTL (PARTIAL).** `AuditRetentionService` (`packages/applications/src/services/audit-retention/audit-retention.service.ts:21-27,58-74`) and `AgentTrajectoryRetentionService` (`.../agent-trajectory-retention/agent-trajectory-retention.service.ts:17-27`) are the only two retention jobs in the codebase, both explicitly documented as "platform-wide, tenant-less" using the unscoped `baseClient`, covering `AuditLog` (365d default) and `AgentTrajectory` (30d default) only. There is **no TTL of any kind for transcripts, audio recordings, notes/summaries, or style-profile exemplars** — the PHI-heaviest artifact classes the reference cares about most (US-AD-04: "session scratch, drafts, and finalized notes expire correctly"). The generic `GlobalSetting` grid (`apps/admin-console/src/app/(console)/(shared)/settings`) surfaces the two existing keys among hundreds of unrelated settings; there is no dedicated per-artifact-class, per-jurisdiction retention screen.

**F-13 — Quality-trend dashboard (PARTIAL).** `GET admin/harness/edit-burden` gives edit-distance/deferral-rate/time-to-sign but is scoped to one `consultationId` (`harness-admin.controller.ts:354`, `required: true`) — not a tenant aggregate. `GET admin/consultations/aggregate` is volume-only. `GET admin/agent-trajectory/metrics/generation` is LLM latency/throughput, not clinical quality. No endpoint computes a tenant-wide "% approved without edit," "% timed out," or "safety-block frequency" number, and no per-guideline citation-frequency metric exists at all (consistent with F-11 — there's no per-source allowlist to attribute citations to).

**F-14 — No sign-off confirmation (PARTIAL, [ADDED] against `11-ux-ui-principles.md`, not a literal reference story).** `handleApprove` (`consultation-demo-screen.tsx:363-376`) fires `approve.mutate(...)` directly on click; success sets `approved=true`, disables the button, and toasts `'Note signed'`. The *same app* gates its "Activate version" action on a prompt-template with an explicit `ConfirmDialog` (`apps/admin-console/src/features/agents/components/version-diff-panel.tsx:205-213`) — a lower-stakes action getting stronger UI protection than clinical sign-off. Not itself a safety violation (a human still clicks it, matching F-nothing on the VIOLATED list), but worth flagging given the project's own rule that destructive/critical actions require confirmation.

**F-15 — No stable transcript segment id (PARTIAL).** `TranscriptSegment` (`packages/agentic-sdk-v2/src/types/audio.ts:246-266`) has `text/startTime/endTime/isFinal/speakerLabel?/confidence?/language?/words?/pipelineId?` — no `id`. `agenticStore.ts:570`'s `addTranscriptSegment` appends as-is; identity is array position only. US-CL-04 AC4 requires superseded spans to "remain in the event ledger" addressably (e.g., for QA to later open a specific superseded span) — positional identity makes that fragile once segments are inserted/reordered/reconciled.

**F-16 — No `TIMED_OUT` status (PARTIAL).** The actual enum (`packages/database/src/prisma/db_main/enums.prisma:278-288`) is `OPEN → RECORDING → DRAFT_PENDING_SENSORS → PENDING_REVIEW → SIGNED → CLOSED (→ REOPENED)`. There is no `TIMED_OUT` value anywhere. Positively: `HarnessInternalService.recordEscalation` (`harness-internal.service.ts:1259-1298`) only ever appends a WORM audit row (`GATE_ESCALATED`/`GATE_ABANDONED`) and never touches `ConsultationStatus`, and the only place `SIGNED` is ever set requires `this.requestUserId` — so a timed-out session cannot be silently auto-signed (this is the good half, covered under F-nothing/IMPLEMENTED for US-CL-14). The gap is narrower: the reference wants a state that is *visibly* distinct from "still being actively reviewed," plus a clinician/coverage-pool notification (UC-12 main flow step 2) — neither a distinct status nor a confirmed notification call was found in this lane's scope (the actual SLA timer lives in the Python Temporal workflow, out of scope here).

**F-19 — Unused citation contract (PARTIAL, [ADDED]).** `packages/agentic-sdk-v2/src/types/citations.ts` defines a complete provenance contract (`CitationClaim`, `ClaimEvidence`, `SensorScores`, `ClinicalReviewData`) with matching pure utilities in `utils/citations.ts` (`sortClaimsByAttention`, `buildTranscriptHighlights`, `confidencePercent`, etc.) — but `ClinicalReviewData` is referenced only inside its own defining/barrel files monorepo-wide; there is no hook and no consumer, including admin-console. `apps/admin-console/src/features/consultation-review/lib/transcript-highlights.ts` independently reimplements highlight-building logic rather than importing the SDK's version. Not a safety defect, but a maintainability/consistency gap worth flagging — two implementations of the same "highlight the cited transcript span" logic can drift.

**F-20 — Contradiction handling (ABSENT-in-scope, needs wave 2).** The dataset gives contradiction detection first-class treatment (T6.1 image-vs-speech, T12.4 history-vs-allergy) with an explicit "neither source is silently preferred" rule and a safety-critical finalization block. No contradiction-detection or contradiction-resolution endpoint was found in `apps/api`'s consultation/streaming scope. This logic plausibly lives in the Python harness's NLP/Reasoning agent (out of scope for this lane) — flagged, not asserted absent platform-wide.

**F-21 — Imaging/vision intake (ABSENT-in-scope, needs wave 2).** Same caveat as F-20: only a generic `ATTACHMENT` context-item type and a separate dual-capture audio-recording attach route were found; no report-first-preference logic, no image-derived-suggestion isolation, no metadata-mismatch degrade-safely path was found within this lane's `apps/api` scope. Flagged for wave 2 to check `apps/nlp`/`apps/harness`.

---

## VIOLATED — ranked

1. **F-06 — No optimistic concurrency on note/section content writes.** Ranked first because it is the only finding where the negative outcome (silent loss of a clinician's edit) can happen today on the *happy path*, during ordinary concurrent use, with a pattern that is demonstrably already implemented and proven elsewhere in the same module (`ConsultationContextSchemaAdminController`, `PromptTemplateController`, `HarnessAdminController`). No malicious actor or edge case is required — two open tabs is enough.
2. **F-01 — Consent gate before capture is entirely absent, and Record actively works without it.** Ranked second (not first) because, unlike F-06, exploiting it requires no adversarial condition either — it's simply *always* true that Record works with no consent check — but its remediation is architecturally larger (a whole new consent domain, not a missing guard clause on an existing endpoint), and its blast radius is regulatory/consent exposure rather than direct data loss.

No other finding rose to VIOLATED under the audit's rubric (active violation of a stated forbidden behavior) — the rest are ABSENT/PARTIAL capability gaps where the code does not yet claim to do the thing, rather than code that does the thing incorrectly while appearing to do it correctly. F-03 (mute) was the closest additional VIOLATED candidate and did **not** qualify: the SDK-level mute is genuinely correct; the gap is pure UI unavailability, not a fake control.

---

## API-vs-client gaps

- **`getPatientHistory` (SDK) has no consuming UI screen** (F-10). If the backend behind it is real, this is a capability stranded one layer below the product — wave 2 should confirm what `getPatientHistory` actually returns before deciding whether this is a UI-only fix or deeper.
- **`ClinicalReviewData`/citations.ts (SDK) has no consuming hook**, and admin-console independently reimplements equivalent logic (F-19) — capability exists in the SDK, is unused, and is silently duplicated downstream instead.
- **Mute (SDK) has no UI affordance in the shipped product** (F-03) — capability exists two layers down (`packages/room` → `useArcaAudio`) and dead-ends before reaching any screen; `packages/ui`'s `ConversationBar`/`MicSelector` mute widgets are also unused by admin-console, so the gap isn't "nothing was ever built," it's "three different mute-capable things exist and none are wired to the one screen that needs it."
- **`AgenticClient`'s ETag/If-Match OCC support (SDK) has no server route on the note-content path to exercise it** (F-06, inverse direction) — the client is ready for optimistic concurrency on this path; the server-side routes simply don't ask for it.
- **Server-side `pause`/`resume`/`cancel` WS control commands exist and are dead** (F-09) — the transport-layer contract supports them; no gateway caller and no SDK/UI trigger reaches them. This is a capability that was clearly designed for but never finished end-to-end in either direction.
- **`useArcaPipelines().pauseTranscription()` (SDK) exists with no UI trigger** — same shape as the previous item, one layer up.

---

## [ADDED] invariants

The reference is written for a generic single-tenant harness and does not address HOPE's specific multi-tenant SaaS architecture. These properties are load-bearing for HOPE and were spot-checked as part of this audit even though no reference story names them:

- **[ADDED] Tenant isolation on client-side session/store state.** `agenticStore.ts:639-671`'s `clearTenantSessionData()` resets consultation/transcript/summary/DNA/audio state (deliberately preserving auth/impersonation state) and is called synchronously from `AgenticProvider.tsx:802` before the async re-hydrate for a newly-selected tenant resolves, closing a documented race. Verdict: **IMPLEMENTED**, matches the documented pattern in `.claude/rules/08-vox-sdk.md`.
- **[ADDED] 404-over-403 cross-tenant posture on every consultation-path route.** Spot-checked across `assertParentInScope`, `assertEqualTenants`, `@TenantOwnedResource` on every `@Sse()` route in `consultation.controller.ts`, and `assertWorkflowOwnership` on the harness-admin Temporal proxy. Verdict: **IMPLEMENTED**, no violation found in the routes checked.
- **[ADDED] CDN/weak-ETag awareness for routes that *do* use `If-Match`.** F-06 means this specific risk (a CDN rewriting a strong `ETag` to a weak one, silently breaking the `If-Match` compare) doesn't apply to the note-content path today — there's no ETag gate there to break. It **does** apply to the OCC-protected sibling routes this audit found (`PromptTemplateController`, `HarnessAdminController`, `ConsultationContextSchemaAdminController`) and was not re-verified end-to-end (on the wire, through any CDN/proxy in front of `apps/api`) in this lane — flagged for wave 2.

---

## Reference defects

- **The four-artifact split (work note / candidate final note / approved note / committed record) from Paper A doesn't map cleanly onto the shipped two-tier model** (live `LiveSummarySnapshot` during recording, then a single versioned `ContextItem`/summary with `DRAFT→APPROVED→LOCKED` status after). This isn't necessarily wrong — a simpler state model can satisfy the same safety properties — but the reference's insistence on four distinct named artifacts doesn't match how any of the three layers actually model note lifecycle, so grading strictly against "four artifacts" would produce false negatives. Treated here as an architecture-mismatch, not folded into the ABSENT verdicts above.
- **US-CL-09's mechanism ("a controlled tool," "the terminology MCP server," "clinical tool gateway") presumes an MCP-tool-calling harness architecture** that this lane found no trace of inside `apps/api` — HOPE's actual harness is a Python/Temporal workflow system (per `.claude/rules/06-python-services.md`), and whether code-binding happens via an MCP-style tool call, a direct NLP-service call, or something else entirely is unverified from this lane. The reference may be describing a specific implementation pattern (from the source papers) that doesn't match HOPE's chosen stack even if the underlying safety property (no free-generated codes) is eventually satisfied a different way.
- **UC-06 (multidisciplinary shared evidence board) and US-SP-03 (structured handoff) describe a multi-agent, multi-specialist collaboration surface** for which this lane found zero trace anywhere in `apps/api`, the SDK, or admin-console — not even a stub. Given the product today is a single-clinician ambient scribe, these read as aspirational stories from the source papers describing a materially different (larger) product than what exists, rather than gaps in an otherwise-matched feature. Flagged so wave 2 doesn't spend time hunting for a feature that may not be on any near-term roadmap.

---

## Open questions for wave 2

1. **Does `apps/harness` (Python/Temporal) implement section-level HITL gating that `apps/api` simply doesn't proxy yet?** F-04 is the single highest-severity finding in this lane; before treating it as a green-field gap, confirm the harness's `gate-decision`/`gate-queue` machinery (`harness-internal.controller.ts`, `harness-admin.controller.ts`) really does operate at whole-document granularity server-side, not just at the TS-gateway boundary this lane read.
2. **Does `apps/nlp` implement terminology/coding binding (F-07) or contradiction detection (F-20) outside `apps/api`'s consultation/streaming scope?** Both were confirmed absent only within this lane's boundary.
3. **Does `apps/harness` implement imaging/vision intake with report-first preference and image-derived isolation (F-21)?** Only generic attachment was found in `apps/api`.
4. **What does `getPatientHistory` (`useArcaSession`) actually return server-side** — is US-CL-01's minimum-necessary/source-linked/date-range/audited-retrieval bundle implemented one layer below the UI (F-10), or is the hook itself thin/unimplemented too?
5. **Is there a GDPR/data-subject-rights erasure job anywhere** (US-CO-02) — cascading into Qdrant vector stores, DNA style exemplars, caches? Not investigated by any of the three lanes; likely belongs to a data/compliance-focused wave-2 lane rather than "surfaces."
6. **Does the live-summary/work-note update path actually debounce on a silence-window or clinical-episode boundary**, per US-CL-06 AC1, or does it fire more eagerly? SDK lane found the SSE subscription mechanism (`useArcaLiveSummary`) but did not verify server-side debounce timing.
7. **Is the actual SLA/approval-timeout timer and clinician notification implemented in the Python harness** (F-16)? This lane confirmed timeout can never auto-sign, but not that a distinct visible state or notification exists.
8. **Verify the CDN/weak-ETag risk end-to-end** for the routes that do carry `@RequiresIfMatch()` (prompt templates, harness policy, context schemas) — is there a reverse proxy/CDN in front of `apps/api` in any deployed environment that could rewrite a strong ETag to weak, and if so, does `RequiresIfMatchGuard` reject a weak `If-Match` outright or silently accept it?
9. **US-NU-01 (nurse action items), US-SP-01/03 (specialist briefing/handoff), US-TH-01's video/chat channel** — confirm these are genuinely unbuilt rather than living in a part of the codebase none of the three lanes' greps surfaced (e.g., a differently-named feature folder).
