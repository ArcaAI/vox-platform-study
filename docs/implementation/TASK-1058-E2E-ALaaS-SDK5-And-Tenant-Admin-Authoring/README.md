# TASK-1058 — E2E: ALaaS ↔ HOPE (SDK 5, multi-encounter lifecycle) and tenant-admin authoring

| Field | Value |
|---|---|
| Status | Review |
| Type | verification (e2e test + analysis report) |
| Branch | dev-2.2 (HOPE), refactor-hope-integaration (ALaaS) — no code changes planned |
| Targets | dev cluster `api.taphuynh.dev` / `admin.taphuynh.dev` at **164b453d** (promoted 2026-10-09 15:59Z); local stack (primary tree, HEAD ≥ c928b3e74) |
| Opened | 2026-10-09 |

## Requirement Analysis

Owner request (2026-10-09): e2e-verify, with evidence, metrics and a defect report:

1. **Clinical realtime path** — ALaaS web_ui + audio-stream-svc (vox-node 5.0.0) → HOPE:
   multi-encounter consultation (recording start / pause / resume / stop; consultation open →
   close-complete → reopen → close-complete), realtime transcription, NER highlights,
   pre-summary from prior case notes, previous-encounter recap/detail, final summary, context
   propagation into agents/workflows run by the harness (Temporal durable functions).
2. **Admin console — consultation detail**: fields render and are populated (owner sees blanks).
3. **Tenant-admin authoring**: manage/build/compose agents, workflows, context schemas, prompt
   templates, document templates; realtime/verbose test runs; integration instructions on publish
   (SDK, raw HTTP, SSE, socket).
4. Parallel load (≤ 3 concurrent consultations) on the cluster; metrics from Grafana / Rancher.
5. Analysis report: metrics, defects, best-practice fixes.

## Current State Evaluation (exploration, 2026-10-09)

- Cluster: 36/36 workloads healthy; LM Studio has `gemma-4-e2b-it-qat` (ctx 32768) and
  `granite-guardian-4.1-8b` (ctx 16384) **loaded**; embeddings / e4b not loaded.
- Local: HOPE app processes and LM Studio are **down**; infra containers up. A local run needs
  LM Studio + Gemma loaded → owner approval (model rule).
- SDKs: `@arcaai/vox-node` and `@arcaai/vox` 5.0.0; ALaaS pins vox-node 5.0.0 (latest).
- ALaaS worktree `ALaaSv3.0-e2e-1053` = primary `66e89f8`, built, `.env` → `HOPE_API_URL=https://api.taphuynh.dev`.
- Driver tooling: `.e2e-tools/` (e2e-drive.mjs, fake-mmr-agent.mjs, emr-signoff.mjs, synthetic
  TTS audio e1_*/e2_* from `audio/script.json`).
- Known open defects carried in (TASK-1045): E2E-38 speaker null → "Unknown" citations, E2E-39
  duplicate failure message, E2E-41 new encounter inherits `processing=FAILED`, E2E-42 decrypt
  failure → 404. TASK-1054 cluster re-run pending (fix not yet deployed — dev-2.2 ahead of origin).
- Console surfaces: `/agents` (Test run tab: dry/live for drafts; published = blocking only),
  `/workflow-studio` (Test tab with node-by-node trace SSE; Integration tab 5-step guide),
  `/context-schemas`, `/prompt-templates`, `/document-templates`, `/quick-start`,
  `/consultations` (drawer) and `/consultations/[id]` (activity timeline).
- Suspected consultation-detail blanks (from code read, to confirm live): console type omits
  `approval`, `closedReason`, `closedAt`, `reopenCount`, `currentEncounterSeq`, `encounters`,
  `lifecycle`, `lastActivityAt`; `governingRun` null unless `metadata.governingEngine`; doctor
  name blank without `UserProfile`.

## Implementation Plan — test cases (in order)

### Track A — clinical realtime (ALaaS → HOPE), cluster first

| Id | Case | Pass criteria |
|---|---|---|
| A1 | New visit, encounter 1, synthetic cardiology dialogue, prior case notes + vitals, pause 6 s mid-way, stop | open 201 → recording → `transcript.segment/final` < 5 s after speech; `entities` frames (NER); `presummary` with prior-note content; `summary.snapshot`/`section.patch`; after stop `note.requested → note.progress → note.final`; capture-state pause/resume reflected; DB `status=STOPPED`, `processing=IDLE/NOTE_READY` |
| A2 | Same-visit encounter 2 (revisit, same eventId) | appends encounter seq 2 on same consultation; `encounter.recap` for seq 1; `visit.prequel`; final note covers both encounters; no `FAILED` inheritance (E2E-41) |
| A3 | Sign-off + reopen cycle | EMR copy → `APPROVED`/`CLOSED_COMPLETE`; reopen → recordable again (or documented refusal); close-complete again; history feed shows the cycle |
| A4 | Real web_ui (browser) + fake mmr_agent | UI renders live transcript, NER highlights, pre-summary panel, recap/detail view of previous encounter, final note; screenshots |
| A5 | Context propagation | governing workflow per department; harness run COMPLETED in Temporal; prompt-preview shows patient/vitals/prior notes variables; agents per node resolved |
| A6 | Concurrency ×3 | three consultations in parallel (different patients/departments); latencies, errors, GPU/CPU/mem from Grafana |
| A7 | Local stack repeat of A1–A3 (only with owner approval for model load) | same as A1–A3 against localhost:8868 |

### Track B — admin console (cluster, `arcaai_admin` tenant admin)

| Id | Case | Pass criteria |
|---|---|---|
| B1 | Consultation list / drawer / activity for Track A consultations | every rendered field populated or legitimately empty; blanks traced to cause |
| B2 | Context schema + prompt template + document template authoring (e2e-1058-* prefix) | create, version, publish/approve without errors; usable from an agent |
| B3 | Agent: create → draft test (dry + live streaming) → publish → published test | prompts/model/tier visible; live tokens stream; published test works |
| B4 | Workflow: compose in Studio → Test tab (node-by-node SSE, guardrail, tokens) → publish | verbose trace streams to terminal; publish gating sane |
| B5 | Integration instructions | snippets on publish (vox-node, curl, SSE, socket) executed verbatim against the published agent/workflow — they work |
| B6 | UX review | simplicity/power assessment per screen, a11y spot checks |

### Monitoring (orchestrator)
Grafana (Prometheus `prometheus`, Loki `loki`, Tempo `tempo`; dashboards `hope-platform`,
`hope-gpu`, `hope-model-residency`, `hope-k8s-workloads`), Rancher pod logs/top, Temporal,
cluster DB reads.

### Constraints
- Deployment hold sent to all dev sessions (TASK-1055 w3, TASK-1057) until this run ends.
- No model load/unload/change; no reseed/reset; test data prefixed `e2e-1058`, synthetic patients only.
- Gateway login throttle 5/60 s — reuse tokens.

## Implementation Summary — results (run 2026-10-09 16:37–17:40Z, cluster only)

Owner decisions taken before execution: **cluster only** (no local model load → A7 skipped);
test data in the **ArcaAI** tenant (all `E2E1058` / `e2e-1058-*`, authoring objects archived after).
Executors: E1 headless lifecycle (A1–A3, A5, A6), E2 real web_ui + console audit (A4, B1),
E3 tenant-admin authoring (B2–B6), R1/R2 read-only root-cause analysis. Deployment hold held by all
dev sessions (TASK-1055 w3, TASK-1057) for the whole run.

### Verdict

| Area | Verdict | One line |
|---|---|---|
| SDK 5 / ALaaS integration plumbing | **PASS** | vox-node 5.0.0 handle verbs, lifecycle SSE, recap, encounters, sign-off all wired and answering |
| Realtime transcription | **PASS** | finals 0.2–0.4 s after utterance (≤ 1.0 s under ×3); STT first-partial p95 0.98 s, commit p95 0.73 s |
| Recording start / pause / resume / stop | **PASS** | PAUSED/RECORDING in ~0.3 s; stop→transcript.final ~0.5 s |
| Multi-encounter (new eventId) | **PASS w/ defects** | seq 2 appended, `encounter.recap` delivered; processing inherited from encounter 1 (E2E-41 still open) |
| Open → close-complete → reopen → close-complete | **PARTIAL** | close-complete PASS; `reopen` refused `REOPEN_NOT_ALLOWED` (tenant policy `reopenAllowed:false` — by design); new eventId chains a new consultation (PASS) |
| Live note during recording | **FAIL** | first snapshot only after stop (60–107 s), empty |
| NER highlights | **FAIL** | 0 `entities` frames in 7 consultations (NER ran, results discarded) |
| Pre-summary from prior notes | **FAIL** | degraded (false-positive medical block / KV exhaustion) or generated-but-never-delivered |
| Final summary | **PARTIAL** | 4/7 delivered (172–215 s after stop), all AWAITING_REVIEW with coverage gaps; 3 stranded by false guardrail holds |
| Context propagation | **PASS (data) / FAIL (use)** | prior visits, vitals, investigations stored and present in the finalize prompt; omitted from several notes (penicillin, BP 150/95, HbA1c) |
| Durable workflows (harness/Temporal) | **PASS w/ defects** | governing workflow per department correct; runs complete; supersede-after-resume re-generates the blocked note and fails OUTPUT_INVALID |
| Console consultation detail | **FAIL (partly)** | drawer omits approval/closed/encounters/reopen/lifecycle; telemetry blank; impersonated tenant admin can't reach the grid |
| Tenant-admin authoring | **BLOCKED** | approve/publish refused tenant-wide `PROMPT_SCREENING_UNAVAILABLE` since 2026-10-09 14:34Z |
| Test/debug runs | **PARTIAL** | dry run excellent; live test not token-streamed; Studio trace streams but hides degrade reasons |
| Integration instructions | **PASS (docs) / UNVERIFIED (exec)** | complete & accurate vs route manifest; could not execute against a published object (publish blocked) |

### Metrics (Prometheus/Loki, 16:35–17:40Z, ≤ 3 concurrent consultations + authoring)

| Metric | Value |
|---|---|
| Consultations created | 7 (A1/A2 same, A3 chained, A4, A6 ×3) |
| Gateway responses | 2 853 GET 200, 276 POST 200, 223 POST 201, 124 POST 202; 2× 503, 2× 422, 3× 403, 13× 404 |
| STT | 18 sessions, 83 utterances; first-partial p95 0.98 s; commit p95 0.73 s; inference p95 0.36 s |
| Text generation | 51 generations, 256 k tokens; latency p50 20 s, p95 54.5 s; TTFT p50 0.38 s; 10 `invalid_request` errors (KV exhaustion) |
| Guardrail screening | 855 decisions: **807 unverified (94 %)**, 44 warn, 4 block |
| Medical judge (granite-guardian 8B) | **597 calls for 51 generations (~8.6–12 per generation)**, 10–23 s each under load; 99× `CONCURRENCY_LIMIT` (judge lane, 5 s acquire, no queue) |
| NLP | 0 NER windows recorded; 11 `/classify/tokens` 200; **1 671 `/guard/classify` 503** (PG2-86M missing) |
| LM Studio gemma-4-e2b | 32 768 tokens **unified KV across 10 slots**; BREN prompts 13–18 k tokens → 2 prompts exhaust KV, all in-flight slots fail together (16:41:48, 16:49:33, 17:31:37, 17:31:58) |
| GPU | GPU1 (LM Studio) avg 24 % / max 100 %, 8.2 GiB of 15.6; GPU0 avg 1.2 %, 9.6 GiB |
| Node | CPU avg 4 % / max 48 %; memory max 43 %; top pod LM Studio 1.96 cores, 17.7 GiB |
| End-to-end timings | open RTT 0.8–1.1 s; start→RECORDING 0.8 s alone, 4–10 s under ×3; stop→note.final 173–215 s |

**Reading:** hardware is mostly idle. Latency and failures come from software admission limits
(judge lane 10 permits/5 s, text semaphore), the shared 32 k KV, and the judge fan-out — not from
GPU/CPU capacity.

### Root causes (verified against code / logs)

| # | Root cause | Symptoms it explains | Evidence | Fix | Owner decision? |
|---|---|---|---|---|---|
| RC-1 | `guardrail.injection` elected to **Llama-Prompt-Guard-2-86M** by the TASK-1050 seed (`seed/16-ai-routing-policy.ts:116-119`); weights never published (no bucketPrefix, gated HF model, nlp offline). Reached the cluster with the 2026-10-09 ~14:33Z reset+reseed | 94 % `unverified`, tenant-wide `PROMPT_SCREENING_UNAVAILABLE` on approve/publish, prompt-preview 503 (pre-summary/live), platform-rules governance piece dropped (62× refused), "could not run" banners in web_ui | hope-nlp Loki from 14:34:00Z: `seq_cls_guard.loading … Llama-Prompt-Guard-2-86M` → `cannot find the requested files in the local cache` | publish PG2 weights (gated licence) **or** re-elect GLiGuard until published | **yes** (model/routing) |
| RC-2 | Medical judge windows **every prompt region** separately; prompt is medical only if **all** windows are (`guardrail/medical_windows.py:66-81`, `windowing.py:78`); tiny structured regions (age, dob, gender, vitals, labs) judged "administrative"; 24 h verdict cache | 422 `CONTENT_BLOCKED_NOT_MEDICAL` on pre-summary and live n_summary_new; 6–12 judge calls per generation | guardrail `medical_validate.off_scope` with `off_scope_regions: context_safe_age/dob/gender, recent_vitals, context_formatted_test_results` | coalesce data regions into ≤ 1–2 windows or exempt structured context regions (`policy.py:120-127`); flush cache | **yes** (guardrail policy) |
| RC-3 | Judge lane: 10 permits, **5 s acquire, queue 0** (`apps/text/.../runtime_defaults.py:162-170`); one shed window fails whole validate → text retries ×3 | 99× `CONCURRENCY_LIMIT`, 60–107 s before gemma starts | Prometheus/Loki | bounded queue (~30 s), per-window retry | yes (posture) |
| RC-4 | Deployment pins `LIVE_DOC_TEXT_TIMEOUT_MS=60000` (`hope-v2-deployment base/config/api.env:139`, `overlays/dev/kustomization.yaml:10773`); code default since TASK-1000 is 300 000 | live flush times out at 60 s, single-flight blocks further flushes → no live note until stop | api `Realtime lane node degraded … timeout of 60000ms` 16:41:51 while text finished at 16:42:38 (13 099 prompt tokens, 107 s) | drop the env line (config tier: global-kv) | no |
| RC-5 | `groundEntitiesToNote` returns `[]` when the note is empty (`live-documentation.service.ts:8152`) | **NER never shown** although nlp found 13 entities in 36 ms | nlp `tokens_done entity_count 13` vs flush `entityCount:0` | publish transcript-anchored entities when no note; ground later | no |
| RC-6 | gemma loaded with `n_ctx 32768, kv_unified, n_slots 10`; BREN prompts 13–18 k | `CONTEXT_WINDOW_EXCEEDED` on several requests at once; pre-summary mislabelled `context_overflow` (1 803-token prompt) | LM Studio load log 16:24:59; slot sums 34 462 / 34 794 / 32 769 | larger ctx or fewer slots / per-slot budget; KV-aware text semaphore; distinct `kv_exhausted` code; trim BREN prompt | **yes** (model load) |
| RC-7 | Warm-start pre-summary finishes after the live plane sent `summary.snapshot closed:true`; broker stops listening (`ALaaS live-plane.ts:172-186`) | pre-summary generated & persisted (1 502 chars) but never shown; Snapshot spinner forever | api `Warm-start pre-summary ready` 16:42:14 vs closed 16:41:07 | HOPE delays terminal until onStart nodes settle (or includes it), or broker reads cached pre-summary on terminal | no |
| RC-8 | `GuardrailNoticeRepository.upsertByDedupeKey` returns `created: model.id === entity.id` — always true (deterministic ids) (`packages/domains/.../GuardrailNoticeRepository.ts:46`) | a RESOLVED notice re-enters GUARDRAIL_HOLD with no open notice → consultation stranded (E1-6) | notice `ce011ac1` RESOLVED, consultation still held at 17:08 | derive `created` from pre-read / insert count | no |
| RC-9 | Outbound `pii_leak` (GLiNER2 zero-shot, `guardrail/services/screening.py:1507-1590`) flags the note's own region-key citations `[encounter_1]`, `[previous_visits]` (labels `encounter_id`, `api_key` in `labelTaxonomy`); text treats local pii_leak as detect-only yet ingest still holds | false holds on 3 of 7 consultations; note "written" but held; supersede regenerates same note → OUTPUT_INVALID | evaluation checks `{checkId:pii_leak, category:encounter_id}` | strip citation labels/region keys before span extraction; don't hold when text delivered; note writer must not overwrite hold reason; supersede carries override | partly (hold policy for local detect-only) |
| RC-10 | Encounter append never resets processing (`ConsultationEntity.ts:593-612`, `consultation-encounter.service.ts:112-150`); approve only resets on hold clear | E2E-41 class persists; closed consultation shows AWAITING_REVIEW | A2 frame seq 1 | reuse `stop`'s IN_FLIGHT rule on append; approve → IDLE | no |
| RC-11 | Heartbeat frames on lifecycle SSE dispatched as lifecycle events by vox-node (`consultation-handle.ts:~347-357`) → ALaaS adapter nulls reason (`hope-consultation.vox-node.adapter.ts:1076`) → web_ui clears hold (`reducer/guardrail.js:117-119`) | hold panel vanishes after ≤ 15 s; clinician sees "Writing the case note, 0 of 14" forever | e2 frames r3→r4 | vox-node skip heartbeat; adapter ignore status-less frames; web_ui keep hold | no |
| RC-12 | Broker resume baseline = note already written during hold (`consultation-broker.service.ts:1911, 2560-2575`) | no `note.final` after successful resume → SUMMARY_TIMEOUT contradicting "waiting for review" | A3enc3resume ack 4.7 s, timeout 184.9 s | baseline = delivered note; deliver an undelivered existing note | no |
| RC-13 | SYSTEM `TenantStorageConfig` `endpoint=https://hope-minio:9000`, `publicEndpoint` NULL; vox-node has no `/content` fallback after a failed PUT | mid-recording case note upload fails (`HOPE_UNAVAILABLE … fetch failed`), attachment stuck INTENT | SQL + A1 jsonl seq 51 | set publicEndpoint (`https://admin.taphuynh.dev` per `hope-minio-presigned` IngressRoute — verify) + vox-node fallback | no (config) |

### Defect register

Severity: B = blocker, M = major, m = minor. "RC" links to the table above.

**Clinical path (HOPE)**
| Id | Sev | Defect | RC |
|---|---|---|---|
| D-01 | B | Prompt screening down tenant-wide (PG2-86M missing) | RC-1 |
| D-02 | B | Live note empty during recording; first snapshot only after stop | RC-4, RC-2, RC-3, RC-6 |
| D-03 | B | NER entities never published | RC-5 |
| D-04 | B | Resumed guardrail hold strands consultation (re-hold on resolved notice) | RC-8, RC-9 |
| D-05 | M | False-positive pii_leak on citation/region labels | RC-9 |
| D-06 | M | 422 CONTENT_BLOCKED_NOT_MEDICAL on legitimate clinical prompts | RC-2 |
| D-07 | M | KV exhaustion fails all concurrent generations; mislabelled context_overflow | RC-6 |
| D-08 | M | Degraded pre-summary persisted as template-headings-only PRE_SUMMARY item; broker drops HOPE's degrade reason | E1-4 |
| D-09 | M | Encounter 1 finalization ~220 s > 180 s broker budget → SUMMARY_TIMEOUT, run OUTPUT_INVALID (A4) | RC-2/3/6 + budget |
| D-10 | M | Note quality: penicillin allergy, BP 150/95, HbA1c/LDL omitted in several notes; °C/°F confusion; cites an allergy from case notes as `[S4]` | prompt/model capacity (needs eval) |
| D-11 | M | New encounter inherits processing (E2E-41) | RC-10 |
| D-12 | M | Attachment upload impossible from outside cluster | RC-13 |
| D-13 | m | Closed consultation keeps AWAITING_REVIEW processing | RC-10 |
| D-14 | m | previous_case_notes re-materialized on every open (CASE_NOTE ×4) | consultation.service.ts:944-970, 1073-1110 |
| D-15 | m | FACT_LEDGER activity rows OK with stale errorCode | AiActivityRunRepository.ts:39-47 |
| D-16 | m | Usage outbox retries duplicate key until FAILED (Prisma 7 adapter error shape) | usage-outbox.drainer.ts:385-393 |
| D-17 | m | Guardrail audit events written with null author (`audit_event_missing_author`) | SysEventService |
| D-18 | m | Speaker null → "Unknown" citations (E2E-38 still open) | segment speakers [] |
| D-19 | info | EMR copy approved a consultation on a (stale) hold — by design (`consultation-approval.service.ts:314-334`); disappears with D-04 | owner: require regenerated note? |
| D-20 | info | `governingRun` RUNNING for ~1 h after note — genuinely waiting for review in Temporal; label as "waiting for review" | UX |

**ALaaS (broker / web_ui)**
| Id | Sev | Defect | Where |
|---|---|---|---|
| A-01 | B | Hold panel unmounts on heartbeat frames | RC-11 (vox-node + adapter + web_ui) |
| A-02 | M | No note.final after successful resume | RC-12 |
| A-03 | M | Late pre-summary never shown | RC-7 |
| A-04 | M | Historical guardrail notices replayed as stacked banners on reopen (12), covering recap/Generate | `consultation-broker.service.ts:2178-2182`, `guardrailModel.js:56-74` |
| A-05 | M | `buildVitalsPayload`: pain "0 of 10" → 10; `/\bbp\b/` grabs diastolic → BP "60" — flows into note | `web_ui/hooks/consultationStartContext.js:233,240,263-264` |
| A-06 | m | Mock patient `consultantId 234` unmapped → IDENTITY_UNMAPPED; age N/A without `age` | mock data, `useClinicalLogic.js:1704` |
| A-07 | m | Failure message announced twice to screen readers (E2E-39 variant) | `NoteProgressStepper.jsx:64-70` |
| A-08 | m | notification `createdAt` 7 h behind UTC; `&` saved as `&amp;`; state flicker CLOSED→APPROVED→CLOSED; `closeStreamSession` 404 (BUG-036) | broker |
| A-09 | info | Same eventId Start-after-Stop continues encounter 1; a new encounter needs a new EMR eventId | protocol semantics — document |

**Admin console**
| Id | Sev | Defect | Where |
|---|---|---|---|
| C-01 | M | Impersonated tenant admin sees cross-tenant aggregate, not the grid (reads `isElevated`/`workingTenantId`, not `effective*`). 10 other screens read `.isElevated` — audit | `consultations-screen.tsx:367`; playground-llm, harness-policy, tenant-storage, agentic-policy, allowed-origins, persona-control, prompt-templates (governance-tab, screen), site-header |
| C-02 | M | Consultation drawer omits approval, closedReason/closedAt, reopenCount/reopenAllowed, recordable, currentEncounterSeq, encounters, lastActivityAt, autoCloseAt, externalRef, language, lifecycle | `features/consultations/api/types.ts:72-96` |
| C-03 | M | Status badge hides processingReason except NOTE_READY (GUARDRAIL_HOLD, NOTE_COVERAGE_GAPS, NOTE_GENERATION_FAILED invisible); hold banner keyed on reason only | `consultation-status-badge.tsx:39-42`, `consultation-hold-banner.tsx:24-28` |
| C-04 | M | Telemetry blank: preSummary.model, finalSummary tokens/duration, guardrail NO_ACTIVITY (activity shows 17 evaluations) | telemetry source |
| C-05 | M | "View run" dead link (workflow-harness gate off; trace 404); no run→trace link on activity | `consultation-workflow-meta.tsx:54-60`, `activity-item-row.tsx` |
| C-06 | m | Relations groups miss STRUCTURED, TRANSCRIPT_SEGMENT, FULL_TRANSCRIPT, FACT_LEDGER, ENCOUNTER_RECAP | `consultation-detail-panel.tsx:41-50` |
| C-07 | m | Activity RunMeta blank workflow/agent slugs; contextWindow 0 → empty bar; "Edited items" counts machine re-versions; transcripts labelled "Attachment"; raw JSON for structured items | `activity-item-row.tsx:18-42` |
| C-08 | m | Patient mask shows only `alaas:E…` namespace | `consultation-detail-panel.tsx:27-29` |
| C-09 | M | Context-schema JSON field editor drops keystrokes (snaps back to `{}`); required editor hidden under "Advanced" | `context-schemas/components/kind-form.tsx:125-132` |
| C-10 | M | Agent Validate shows success toast on a blocking report; Publish stays enabled | `agents/components/agent-detail.tsx:673` |
| C-11 | M | Studio Validate passes a graph pinning an unpublished agent version; publish then refuses (by node id, not step name) | workflow-studio |
| C-12 | M | Studio Test hides degrade reason (`agent_unresolvable`); sandbox run row stuck RUNNING | workflow-studio test-tab |
| C-13 | M | Draft live test: 11–25 s ack, output in one chunk (not token-streamed); generic "internal error" toast on KV exhaustion | agents test panel |
| C-14 | m | Prompt variable `{{context.chief_complaint}}` refused without suggesting `context.intake.chief_complaint`; no autocomplete | prompt tooling |
| C-15 | m | Slug rules differ (`[a-z0-9_]` vs `-`); disabled buttons without reason; label/for mismatches; CodeMirror no accessible name | various |
| C-16 | m | Inconsistent version status (Draft tab vs Versions; "v2 active" vs "v2 draft"); author shown as UUID; duplicate "Versions" column | agents / prompt-templates / workflow list |
| C-17 | m | Quick start "Assign to" defaults to Whole tenant (one click from replacing the governing workflow); model list hides readiness | quick-start |
| C-18 | m | Codegen not linked from schema / agent / workflow Integration tabs (only `/developer`); browser lane uses `your-gateway.example.com` placeholder; doc text leaks `workflows.controller.ts:383-384` | developer-docs, integration panel |

### What worked well (keep)
- STT latency and pause/resume responsiveness; `encounter.recap`; chained consultation on a new event; EMR-copy sign-off with approval/attestation rows.
- Agent **dry run** (assembled prompts, EXTERNAL_DATA regions, resolved provider/model/funding) and Studio's node-by-node trace stream (first event ~0.2 s, pause/step/time-travel).
- Integration docs: auth, base URL, scopes, flat vs `{input}`, Idempotency-Key, `x-hope-run-protocol`, SSE event names and error codes all match `route-manifest.json`.
- Context-schema publish confirmation explains impact; document templates selectable from agent wizard and Studio.

### Recommendations (best practice → concrete action)

**P0 — restore the realtime path (needs owner decisions marked ★)**
1. ★ RC-1: re-elect `guardrail.injection` to GLiGuard until PG2-86M weights are published; add a **boot/seed preflight** that refuses to elect an `AiModel` whose weights are not resolvable (`internal/models/resolvable`) — a routing election must never point at an unloadable model.
2. ★ RC-2/RC-3: judge structured context regions as one window (or exempt them); give the judge lane a bounded queue (~30 s) and per-window retry; flush the verdict cache on policy change. Target ≤ 2 judge calls per generation.
3. RC-4: delete `LIVE_DOC_TEXT_TIMEOUT_MS=60000` from the deployment repo (config belongs in `consultation.realtime.textTimeoutMs` global-kv per the configuration-tier rule).
4. ★ RC-6: size LM Studio for the workload — either `n_ctx ≥ slots × max prompt` or fewer slots; make the text user-lane semaphore KV-aware; add `kv_exhausted` degrade code; trim the BREN live prompt (13–18 k tokens is the main KV consumer).
5. RC-5: publish transcript-anchored NER entities immediately; ground against the note only when it exists.

**P1 — guardrail hold correctness**
6. RC-8: fix `upsertByDedupeKey.created`; add a regression test "resolved notice + late BLOCK evaluation ⇒ no hold".
7. RC-9: strip citation labels/region keys before pii_leak span extraction; don't hold when text already delivered under local detect-only (★ owner); note writer never overwrites `GUARDRAIL_HOLD`; supersede after `acknowledged` carries the override.
8. RC-11/RC-12 (SDK + ALaaS): vox-node ignores heartbeat frames (patch release 5.0.1); adapter ignores status-less frames; web_ui keeps hold until resolved; broker resume baseline = delivered note.
9. RC-10: reset processing on encounter append and on approve.

**P2 — data/UX**
10. RC-7: deliver late pre-summary (include in terminal payload or broker reads cache on terminal); never persist a degraded pre-summary as a normal PRE_SUMMARY item.
11. RC-13: set storage `publicEndpoint` for the cluster; vox-node falls back to `…/content` on PUT network failure.
12. Console consultation detail: render the full lifecycle DTO (approval, closed*, reopen*, encounters, processingReason), show transcript / final note / pre-summary / NER previews in the drawer, link runs to the trace (or hide the link when the gate is off), fix C-01 and audit the other `.isElevated` reads.
13. Authoring: one page-level banner for infra blockers instead of per-action toasts; disable Publish when validation is blocking (C-10); make Studio Validate check pinned versions (C-11); show degrade reasons in Studio Test (C-12); stream agent live tests token-by-token with latency/tokens/guardrail decisions; fix the schema JSON editor (C-09) or add a field builder; variable autocomplete from the bound schema (C-14); codegen links on Integration tabs.
14. ALaaS vitals parser (A-05) — clinical-safety: parse BP as `systolic/diastolic` pairs and pain scores with explicit scale; add unit tests on the six seeded phrasings.

**Process**
15. Make the e2e a **release gate**: run this ALaaS replay (A1/A2/A6) against the cluster after every promote-dev, asserting `entities > 0`, `presummary` content, first snapshot < 60 s, `note.final` < 180 s, 0 unverified screening decisions.
16. Add Grafana alerts: `guardrail_screening_decisions_total{decision="unverified"}` ratio > 5 %, nlp `/guard/classify` 5xx, text `CONCURRENCY_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, live-lane `flushFailed`.
17. Seeds that change model elections must be accompanied by a weight-publish step in the same rollout (RC-1 reached the cluster only via a reseed).

### Owner decisions on the findings (2026-10-10)

| # | Topic | Decision |
|---|---|---|
| OD-1 | LM Studio load (RC-6) | `gemma-4-e2b-it-qat`: context length **65536**, **8** parallel slots. `granite-guardian-4.1-8b`: context length **16384**, **8** parallel slots. |
| OD-2 | Medical-judge policy (RC-2/RC-3) | **Prompts** (instructions, templates, composed prompt pieces) are judged only at build/compose time, before saving. At **runtime** only the **context** is judged; the prompt is never judged. |
| OD-3 | pii_leak hold (RC-9) | A **local-model** (detect-only) pii_leak finding must **not** put a consultation on GUARDRAIL_HOLD. |
| OD-4 | PG2-86M (RC-1) | **Open:** publish the weights, or re-elect GLiGuard. |

### Not covered / caveats
- A7 (local stack) skipped by owner decision. No-gating policy: no unit/integration suites were run (this was a black-box e2e).
- RC-1 masks part of the guardrail behaviour; re-run A1/A2/A6 after P0 to measure the real latency floor.
- Integration snippets were executed only against unpublished slugs (404) — re-run B5 once publish works.
- Note-quality findings (D-10) are from 7 notes on gemma-4-e2b; needs a golden-set eval before conclusions.

### Artifacts
`.e2e-tools/t1058/` (gitignored): `e1/` (drive.mjs, runs/*.jsonl + summaries, api/*.json), `e2/` (a4-webui.mjs, out-*/shots, frames, probes), `e3/` (notes.md, snippet logs, key revoked), `logs/` (fake-mmr, web_ui).

## Change History
- 2026-10-09 — opened; exploration + plan; owner: cluster only, ArcaAI tenant data OK.
- 2026-10-09/10 — executed (E1/E2/E3), RCA (R1/R2), report written; status Review.
- 2026-10-10 — owner decisions OD-1..OD-3 recorded; OD-4 open.
