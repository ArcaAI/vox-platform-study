# TASK-1045 — Consultation session lifecycle simplification (HOPE + SDKs + console + ALaaS)

| Field | Value |
|---|---|
| Status | **In Progress** (planning wave) |
| Type | feature (multi-repo) |
| Repos | `hope-v2` (`dev-2.2`), `ALaaSv3.0` (`refactor-hope-integaration`; merge target confirmed at merge time), `hope-v2-deployment` (`main`, local) |
| Owner go | 2026-10-05: "approve the recommendations and the plan … you can go ahead" |
| Supersedes | TASK-1020 **OD-1** ("one consultation per visit, chained") — see D-3 |
| Related | TASK-1008 (EMR copy = sign-off), TASK-1020 (visit chain, `externalRef`), TASK-1022 (finalizer headings), TASK-1000 (live-summary budget), TASK-1035 (prompt inspector gate), TASK-1039 (SDK 5), TASK-1042 (live audio runs) |

Design artifacts (private until shared by the owner):

- Console consultation timeline: <https://claude.ai/artifact/QYbTwSdCT2JVUpV6SzypXv>
- ALaaS consultation workspace + function map: <https://claude.ai/artifact/Q7xjWNxqDZFEet4vSuTNdZ>

## 1. Requirement

Integrators (SDK users, ALaaS) must drive a consultation with a small, stable set of actions, and
the platform must keep a complete, versioned, decrypt-on-read history of everything that happened.

| Action | Meaning |
|---|---|
| `open` | Open by (doctor, patient, department). Visit type selects the summary prompt and is **not** part of the identity key. |
| `start` | Start capture and stream audio for realtime transcription. |
| `pause` | Pause capture; the last bytes sent are still finalized; nothing is processed while paused. |
| `stop` | Flush, finalize, and **resolve only after the final transcript for the last bytes has returned**. |
| `gen_summarize` | Generate the summary from all transcripts as a time series. |
| `send_attachment` | PDF / image (if the workflow can parse them), audio file (batch transcription → one context item holding the full transcript, no segments), case note (plain-text context item). Pre-signed upload, tenant buckets, media records, errors, retries, quotas. |
| `send_feedback` | Segment edit → new version of that segment item; full-transcript edit → new version of that item; free-text feedback with or without media → feedback record. Ratings (thumb up/down) on note, sections, transcript lines, named entities. |
| `approve` | The end user acknowledges that everything generated and edited so far is final. |
| `close` | `CLOSED_COMPLETE` if approved, else `CLOSED_INCOMPLETE`. Auto-close after 12 h without activity (platform default), tenant-configurable (duration or a daily time). |
| `reopen` | `CLOSED_INCOMPLETE` by default; `CLOSED_COMPLETE` only if the tenant allows it. |

Plus: transcript segments are context items with timestamps against the stored recording; the
full recording is one media context item (no audio segments); the full transcript is one plain-text
context item; history is decrypted on read, latest version by default; the admin console shows the
consultation as an oldest-first time series of activities, each item opening its version history
and its run metadata (model, agent, workflow, duration, tokens, cost, context budget).

### 1.1 Owner directives received during design (2026-10-05)

1. A real consultation can be **doctor → tests → doctor again** (same day or next day). It is one
   consultation with a gap; the visit type changes `new-visit` → `revisit`. The 12 h idle window is
   what keeps it open.
2. **Copy to EMR happens once, at the end**, when the final note is generated — for one-encounter
   and two-encounter consultations alike. Copy to EMR = reviewed, approved, closed.
3. A next-day return after auto-close is **never implicitly reopened**.
4. The re-visit note must cover **all** transcripts of the consultation with no information lost;
   best practices for accuracy and performance.
5. **Always** Gemma 4 E2B (`lms-gemma-4-e2b-it-qat`), **32 768** context, **10** parallel requests,
   **KV cache quantized to 4-bit**, **temperature 0**.
6. ALaaS: layouts, interfaces and components may be realigned; **no function may be removed**, and
   **nothing may be invented** beyond what the owner asked for. Copy to EMR must not break. Earlier
   case notes keep being sent automatically for pre-summary. The note request is sent automatically
   **after Stop, once the final transcript has returned and been displayed**. Loading/progress
   indicators. Recording and generation keep running across tab switches. Feedback: thumbs on hover
   (note, sections, transcript lines, named entities), corrections saved as feedback, captured for
   reporting, analysis and improvement.
7. Encounter 2 shows the clinician encounter 1 (transcript + a short recap).
8. Process: lanes never run gating tests; the orchestrator runs the single gate pass after everything
   is merged into `dev-2.2`, then removes worktrees and branches.

## 2. Current state (code-verified 2026-10-05)

| Area | Today | Gap |
|---|---|---|
| Statuses | `ConsultationStatus` has 12 members (`enums.prisma:296`): OPEN, RECORDING, DRAFT_PENDING_SENSORS, PENDING_REVIEW, SIGNED, CLOSED (dead), REOPENED, PRIMED, DRAINING, TIMED_OUT, CLOSED_COMPLETE, CLOSED_INCOMPLETE. Matrix `ConsultationEntity.ts:40-77`. | Collapse to 7 public statuses + `processing` |
| open | `POST consultations/open` → `getOrCreate` (`consultation.service.ts:1143`). Key (tenant, patient, doctor, `externalRef`) or legacy (tenant, patient, UTC date, doctor). Visit type in `metadata`. | Key (doctor, patient, department) over non-closed; `externalRef` selects the **encounter** |
| pause | Not present anywhere (status, route, SDKs). ALaaS pauses `mmr_agent` over HTTP only. | New |
| stop | `recording/stop` answers ~50 ms while the first flush is in flight; the finalizer can sign off an empty note (ALaaS works around with `ALAAS_STOP_FIRST_SECTION_GRACE_MS`). | Resolve after the final transcript |
| approve | Per summary: `POST :id/summary/:contextItemId/approve` → SIGNED. | Session-level approval snapshot |
| close / reopen | Close only SIGNED→COMPLETE, TIMED_OUT→INCOMPLETE; reopen from SIGNED/TIMED_OUT/CLOSED_*. No tenant reopen policy. | Close from any open state; tenant policy |
| Timeouts | Sweep `consultation-timeout-sweep.service.ts` (session 1440 min, open 120, review 120, stale recording 30) on `updatedAt`; BullMQ completion timeout 5 min after the note is persisted. | One policy, 12 h default, `lastActivityAt`; the 5-min completion timeout closes a two-encounter consultation while the patient is at the lab |
| Segments | `TranscriptSegment` stores offsets (`t0Ms/t1Ms`, char range) into one encrypted TRANSCRIPT item. | Per-segment context items |
| Recording | `AudioRecording` + `Media` (bytes in object storage), `sequenceNumber` per take. | One full recording per consultation |
| Versions | `ContextItemVersion` exists (append-only by convention, Transit-encrypted, `changedBy/changeReason/changeSource`, attestation columns); no immutability trigger. | Trigger; segment/ledger/recap items |
| Attachments | Multipart `POST media` + ATTACHMENT item; per-tenant buckets `hope-attachments-*`, `hope-recordings-*` (TASK-1025); plan storage quota gate (409); presigned PUT exists only as a service primitive; no Idempotency-Key on uploads; image vision TASK-1017 Pending; no PDF parsing. | Pre-signed flow, idempotency, audio-file item |
| Feedback | No feedback model. `gate-edit-mining` mines `ContextItemVersion` from `approveSummary`. | Feedback model + quality loop |
| Summarization input | `buildAssembleParams` (`harness-internal.service.ts:1401-1530`) joins ALL TRANSCRIPT rows flat (no speaker/time/encounter/segment ids); governed ArcaAI finalizer writes from live section snapshots, not the transcript (TASK-1022 §2); attachment cut 20 000 chars, prior visit 15 000, prequel 6 000; no context-window check; `pre_summary_text` unbounded; resume read failure silently finalizes without the earlier session. | Section 3.5 |
| Model serving | `LMS_PRELOAD_PLAN` gemma `contextLength: 65536`, `kvCacheQuant f16`, parallel 10 (`hope-v2-deployment/deployment/k8s/base/lmstudio.yaml:350`). Each slot gets the full context. | 32 768 + q4_0 |
| Telemetry | `GET admin/consultations/:id/telemetry` (8 blocks); `SummaryMeta`, `AiUsageEvent` (with cost columns), `WorkflowRun` (no `consultationId`, no per-node rows), `AgentTrajectoryStep` (pruned nightly). | Per-activity run record |
| Console | `/consultations` list + `ConsultationDetailPanel` (Overview, Prompt inspector). `HistoryTimelineList` exists (no per-item versions). History routes exist only on the business plane. | Admin activity/version routes + timeline page |
| SDKs | vox 4.1.0 / vox-node 4.1.0 (SDK 5.0 in flight, TASK-1039). Browser `audio.start` never calls `recording/start`; vox-node needs three calls; no pause; naming differs. | One vocabulary in 5.x |
| ALaaS | audio-stream-svc on vox-node 4.1.0, no SDK bypass, codegen wired, in-process session store; web_ui live screen `ClinicalUIPopUp` + `useClinicalLogic` (3 107 lines), unrouted `ConsultationWorkspace`, ~160 user-facing functions inventoried, notifications bell commented out. | Package F |

## 3. Design (approved 2026-10-05)

### 3.1 Lifecycle

- **Public `status`**: `OPEN · RECORDING · PAUSED · STOPPED · APPROVED · CLOSED_COMPLETE · CLOSED_INCOMPLETE`.
- **`processing`** sub-status: `idle · finalizing_transcript · summarizing · processing_attachment · awaiting_review · failed` (+ `processingReason` on `failed`).
- Migration map: PRIMED→OPEN, DRAINING→STOPPED (+`finalizing_transcript`), DRAFT_PENDING_SENSORS→STOPPED (+`summarizing`), PENDING_REVIEW→STOPPED (+`awaiting_review`), SIGNED→APPROVED, TIMED_OUT→CLOSED_INCOMPLETE, REOPENED→OPEN (+`reopenCount`), CLOSED→CLOSED_COMPLETE.
- **Consultation = episode; encounters inside.** `ConsultationEncounter(seq, visitType, externalRef, startedAt, endedAt, recordingStartMs, recordingEndMs)`.
- **open**: key (tenant, doctor, patient, department) among **non-closed** consultations. Same key + new `externalRef` or `visitType=revisit` → appends an encounter; same `externalRef` → idempotent. A closed match → new consultation chained via `parentConsultationId` (prequel keeps working). The appointment date leaves the key.
- **Commands**: `POST consultations/:id/{start|pause|stop|approve|close|reopen}`. `recording/start|stop` and per-summary approve stay one release as deprecated aliases.
- **stop** flushes and resolves after the final transcript; **close** works from any non-closed state (recording/paused are flushed first) → COMPLETE if APPROVED else INCOMPLETE.
- **approve** writes `ConsultationApproval` = snapshot `{contextItemId → versionNumber}` across all encounters and **locks content** (edits → 409 `CONSULTATION_APPROVED`); feedback records stay allowed. Copy to EMR (ALaaS) = approve then close.
- **reopen**: CLOSED_INCOMPLETE → OPEN; CLOSED_COMPLETE only if tenant `consultation.reopen.allowClosedComplete` (default false). Never implicit.
- **Auto-close**: tenant setting `consultation.autoClose = {mode: idle|daily, idleMinutes (SYSTEM default 720), dailyAt}` in the tenant appointment-day timezone; new `lastActivityAt` (any lifecycle call, audio bytes throttled, content/feedback write, summary job). The open/review/completion clocks retire; a stale recording (no bytes 30 min) auto-**pauses**.
- **Pause on the wire**: same STT session (`{type:'pause'}` / `{type:'resume-capture'}`); a long pause re-handshakes a new STT stream on the same consultation and recording timeline.

### 3.2 Record model

- **Segments**: each final is a `TRANSCRIPT_SEGMENT` context item (`seq`, `speaker`, `t0Ms/t1Ms` on the recording timeline, `capturedAt`, `encounterSeq`), persisted as finals arrive (Transit batch encrypt).
- **Full transcript**: `FULL_TRANSCRIPT` item rebuilt at each stop; a segment edit appends a derived full-transcript version (`changeSource=segment_edit`); a direct edit is its own version.
- **Recording**: one `AUDIO_RECORDING` item per consultation; a later encounter extends it as a new version; gaps and pauses excluded.
- **Fact ledger**: `FACT_LEDGER` item per encounter — structured, every fact cited to segment ids, records supersession; keyed to the segment versions it was built from.
- **Recap**: `ENCOUNTER_RECAP` item per encounter, rendered from the ledger by template (no model call), **display-only**, never a note input.
- **Versions**: all edits via `ContextItemVersion` (+ immutability trigger, If-Match/ETag OCC).
- **Feedback**: `ConsultationFeedback` (+ media link) — rating `up|down|cleared`, `reasonCodes[]`, encrypted comment, target `{kind: NOTE|SECTION|SEGMENT|ENTITY|TRANSCRIPT|RECAP, contextItemId, versionNumber, sectionKey?, entityRef?}`, actor, client app/surface, idempotency key, **provenance snapshot** (agent version, model, prompt version, workflow run/node). Latest per actor+target wins; history kept. Corrections are `ContextItemVersion` rows (`changeSource=feedback`) linked to the feedback row.
- **Activity run record**: per AI activity — consultation, encounter, activity kind, workflow slug+version, run id, node id, agent slug+version, model, provider, deployment, start/end/duration, tokens in/out, context used/window, output cap, stop reason, cost micros + cost basis.

### 3.3 Attachments

Intent → pre-signed PUT → complete:
`POST consultations/:id/attachments` `{mime, size, sha256, kind}` + Idempotency-Key → `{attachmentId, uploadUrl (PUT, 10 min, bound content-type + length)}` → client PUT → `POST …/attachments/:aid/complete` → server HEAD + size/sha256/magic-bytes check → `Media` + context item → processing dispatch. Gateway multipart fallback ≤ tenant cap (10 MB default). Kinds the governing workflow cannot process → 422 `ATTACHMENT_KIND_UNSUPPORTED` at intent (lists supported kinds). Audio → one transcript item, no segments. Case note → plain-text item. Object keys carry ids only: `consultations/{yyyy}/{MM}/{consultationId}/{recording|attachments|feedback}/{id}/…`; bucket default SSE. Unfinished intents reaped after 24 h. Errors: 413, 415, 409 quota, 410 intent expired, 422 checksum. SDKs retry 5xx/429/network with backoff + jitter, honour `Retry-After`, never retry other 4xx.

### 3.4 History, console, API

- Business plane: latest version decrypted by default, `/versions` and `?include=versions`.
- Admin plane: `GET admin/consultations/:id/activity` (oldest first, cursor-paginated, latest versions decrypted, kind filters, segment runs grouped), `…/items/:itemId/versions[/:n][/diff?against=m]`, run records per activity; gate = TASK-1035 `assertPromptInspectorAccess` shape (super admin, tenant admin of the working tenant from tenant-scoped role assignments, service account).
- Console page `/consultations/[id]`: ScreenTemplate, oldest-first time series, encounter sections, gap bands, recording strip, filter chips (incl. AI runs, Edited), non-modal version panel with diff and per-step Run table, AI usage stat, feedback rows inline. Mockup: artifact above.

### 3.5 Summarization completeness (Gemma 4 E2B · 32k · KV q4 · T0)

Note inputs (re-visit), in fixed prompt order (stable prefix first for KV reuse): instructions → pre-summary of earlier case notes → encounter 1 block → results → encounter 2 block.

| # | Input | Role |
|---|---|---|
| 1 | E1 + E2 transcripts labelled by encounter, speaker, recording time, segment id — **latest corrected** versions | Source of truth; statements cite segments |
| 2 | Fact ledgers E1 + E2 with supersession | Coverage checklist; latest encounter wins |
| 3 | Results that arrived (structured) | Source, cited by file |
| 4 | Earlier draft note — clinician-edited parts | Clinician-verified facts |
| 5 | Earlier draft note — AI-only parts | Draft to verify, never a source alone |
| 6 | Pre-summary of earlier case notes (auto, unchanged) | Background history, separated from today |
| ✗ | Recap | **Never an input** (test-pinned) |

- Budget: tokenizer count before every call; output reserve sized from the template; if 1–6 fit ≤ ~60 % of 32k → single pass; else E1 = ledger + its cited segments, E2 verbatim; long templates → parallel section-group calls over the 10 slots; never silent truncation — `processing=failed` with a reason. Fixed char cuts (20k/15k/6k) are replaced by this step.
- Ledger per encounter is extracted at that encounter's stop (E1 during the gap — off the critical path).
- Coverage check before persist (critical facts present, numbers/doses match a cited segment, citations resolve, groundedness sensor); one repair pass; remaining gaps → `processing=awaiting_review` with the list.
- Live snapshots and governed finalizer stop being a source (fixes TASK-1022 loss path). Resume-read failure becomes a hard failure.
- Golden set (multi-encounter replays + scripted cases) wired to agent `evalGate`: critical-fact recall 100 %, dose accuracy, unsupported-claim rate, p95 stop→note.
- Deployment: `LMS_PRELOAD_PLAN` gemma `contextLength: 32768`, `kvCacheQuant {k: q4_0, v: q4_0}`, parallel 10 (flash attention already on); Gemma `AiModel` context length 32768; agents' temperature 0.

### 3.6 SDKs and codegen (5.x, alongside TASK-1039)

One vocabulary in both SDKs: `const c = await hope.consultations.open({...})` → `c.start() · c.pause() · c.stop() · c.generateSummary() · c.sendAttachment() · c.sendFeedback() · c.approve() · c.close() · c.reopen() · c.history() · c.recap(seq)`; browser `useConsultation()` exposes the same verbs. vox-node `start()` composes STT session + recording + socket. Old methods deprecated one release (deprecation register). Codegen: lifecycle/status/processing/feedback types exported; `vox-node-codegen` regenerated for new admin routes.

### 3.7 ALaaS (package F) — see `ALaaSv3.0/docs/ALAAS_WORKSPACE_REALIGNMENT_PLAN.md`

Realign, never remove, never invent. One routed consultation screen carrying all ~160 inventoried functions (function map = acceptance table), admin = `role=admin` exactly as today (mic sidebar, Session/Event Id, Upload Audio, live monitor + Download All Chunks, recording downloads; non-admin-only job auto-detect). Open at launch (D-OD-D); launch states new visit / re-visit (encounter 1 recap + read-only transcript) / was auto-closed (Continue or Start new) / already signed (read-only). Pause/Resume through audio-stream-svc. After Stop the svc pushes the final transcript, then requests the note (ordered stream), progress stepper, Generate/Regenerate fallback. Root-level session controller, panels stay mounted, background-tab-safe timers. Hover thumbs (focus-within, always visible on touch), optional reasons, corrections as feedback. Copy to EMR unchanged (EMR post → `mark_copied_to_emr` → approve + close). Notifications from HOPE lifecycle events created by the svc; bell remounted.

### 3.8 Feedback & quality loop (package G)

`sendFeedback` in both SDKs (Idempotency-Key); reason codes are configuration (SYSTEM default list + tenant override): missing information, wrong medication or dose, wrong patient detail, made something up, wrong section, too long, wrong language. Daily rollup by tenant / agent version / model / prompt version / section / entity label / reason; console Quality view; `gate-edit-mining` consumes feedback + corrections; curated thumbs-down + corrections feed each agent's encrypted `evalGate` golden set; entity thumbs become NER labels; comments and corrections encrypted; exports de-identified.

## 4. Decisions (owner-approved 2026-10-05)

| # | Decision |
|---|---|
| D-1 | Public statuses collapse to 7 + `processing` sub-status (3.1). |
| D-2 | Segments are context items; full transcript derived (3.2). |
| D-3 | Consultation = episode with encounters; `externalRef` selects the encounter. **Reverses TASK-1020 OD-1**; TASK-1020 README gets a Change History pointer. |
| D-4 | Approval pins + locks; Copy to EMR at the end only = approve + close. No encounter-level acknowledge. |
| D-5 | Pause keeps the same STT session; timestamps on the recording timeline. |
| D-6 | One auto-close policy, two modes, 12 h SYSTEM default, `lastActivityAt`; retire open/review/completion clocks; stale recording auto-pauses. |
| D-7 | Late return after auto-close is never implicit: new chained consultation or explicit reopen. |
| D-8 | Pre-signed upload + gateway multipart fallback; unsupported kind 422 at intent. |
| D-9 | Note inputs per 3.5; recap never an input; ledger-first under the 32k budget; no silent truncation. |
| D-10 | Model directive: Gemma 4 E2B, 32 768 ctx, 10 parallel, KV q4, T 0 — no larger-model fallback. |
| D-11 | Admin activity/version routes gated like the TASK-1035 prompt inspector. |
| D-12 | No back-fill of legacy offset segments (legacy reader keeps them readable). |
| D-13 | Recording stored as Opus. |
| D-14 | ALaaS: realign, never remove, never invent; function map is the acceptance table. |
| D-15 | OD-A remount the notifications bell (notifications created server-side by the svc). |
| D-16 | OD-C HOPE is the single source of truth for notes and versions; ALaaS DB becomes a read cache. |
| D-17 | OD-D ALaaS opens the consultation at launch, not at Start. |
| D-18 | Thumbs always visible on touch devices; default reason list as 3.8. |
| D-19 | SDK 5.0.0 is not tagged (latest `SDK-4.1.0`): TASK-1045 SDK changes ship in the same 5.0.0 major as TASK-1039; `open()` returns a handle. |
| D-20 | **Fresh deploy with a database reset** (owner, 2026-10-05): no data backfill or migration of existing rows — migrations only add schema, enum values, partial indexes and triggers; no duplicate open-key closure; no legacy offset-segment reader needed. |
| D-21 | `ConsultationState` carries `closedReason (auto|manual|approved)` + `reopenAllowed`; lifecycle events via SSE `GET consultations/:id/events` and, for unconnected consumers, the existing sys-event → webhook fan-out (`ResourceUpdated`, `data.action='lifecycle'`). |
| D-22 | Section-scoped regenerate: `generateSummary({sectionKeys: string[]})` (one key = one-element array; pinned 2026-10-05 after D6) → `mode:'section_regen'`, other sections preserved, new note version (`changeSource=ai_section_regen`). |
| D-23 | Tokenizer: engine (where reachable) → pinned HF `tokenizer.json` → conservative estimate `ceil(utf8Bytes/2)`; never truncate. |
| D-24 | Uploaded-audio transcripts are a cited note input block (`attachment_transcripts`). |
| D-25 | OD-C1: on the default engine PDF attachments are supported; images 422 until TASK-1017. |
| D-26 | **Late Copy to EMR** on an auto-closed (CLOSED_INCOMPLETE) consultation: HOPE atomically reopens, approves and closes → CLOSED_COMPLETE, audited as a late sign-off (owner, 2026-10-05). |
| D-27 | ALaaS lane branches merge into `refactor-hope-integaration` (owner, 2026-10-05). |
| D-28 | `POST :id/stop` on a STOPPED consultation is an idempotent no-op that returns the current `finalTranscript {state: complete|pending, …}` — SDKs poll by re-POSTing stop until `complete`. |
| D-29 | `approve` / `close` on an already CLOSED_COMPLETE consultation is an idempotent no-op (a retried Copy to EMR never fails); closing an APPROVED consultation (manual or auto) → CLOSED_COMPLETE, `closedReason: approved`; reopen clears `approvedAt`. |
| D-30 | The ENCOUNTER_RECAP item is STRUCTURED: content = JSON `{schema:'hope.encounter_recap.v2', sections:[{key, label, lines:[{text, citations:[{itemId, versionNumber, label, kind:'segment'|'attachment', t0Ms?}]}]}]}` with the six fixed keys in order `reason, findings, medicines, sent_for, since_then, still_open` (labels Reason · Findings · Medicines · Sent for · Since then · Still open; empty sections kept with `lines: []`), plus a derived plain-text rendering for the console. Consumers map by `key`, never by position; the broker forwards citations so each line links to the E1 transcript line or attachment. |
| D-31 | Recap section mapping: `diagnosis` facts render under **Findings** (working impression); negations stay out of the recap (they remain in the ledger and the note); a fact cited only by results/uploads that arrived after the encounter ended goes to **Since then** regardless of kind. |

## 5. Open questions

| # | Question | Default until answered |
|---|---|---|
| Q-2 | Cluster rollout of the deployment change | Local `main` commit only; owner pushes |

## 6. Implementation plan

Filled from the planning wave (§6.1). Waves follow the layer chain DB → domain → services → API → SDK/console/ALaaS, with disjoint file ownership per lane.

### 6.1 Planning wave

Planner records (binding contracts): `planning/P-AB-lifecycle-record.md`, `planning/P-CG-attachments-feedback.md`, `planning/P-D-console-routes-sdk.md`, `planning/P-E-summarization.md` (+ "Final revision"), `planning/P-F-alaas.md`; lane rules `planning/LANE-RULES.md`.

| Planner | Tier | Scope |
|---|---|---|
| P-AB | opus (high) | Lifecycle + record model: Prisma schema + migration, domain trio, services (open/start/pause/stop/approve/close/reopen/auto-close), STT pause, segments/full transcript/recording/ledger/recap items, versions trigger, gateway routes |
| P-CG | sonnet | Attachments + feedback: intent/complete routes, media records, quotas, idempotency, feedback model/API, rollups, reason-code config |
| P-D | sonnet | Admin activity/version/run routes, console `/consultations/[id]`, SDK 5.x vocabulary (vox, vox-node), codegen + generated artifacts |
| P-E | opus (high) | Summarization: assemble/prompt context contract, budget, ledger + recap producers, coverage check, harness/workflow changes, eval golden set, deployment change |
| P-F | opus | ALaaS: audio-stream-svc + web_ui realignment against the function map |

Each planner returns: exact file list per lane, pinned contracts (types/DTOs/messages), lane order and dependencies, the RED→GREEN test file per lane, risks. Lanes run only their own new/changed test files; gating is the orchestrator's single pass after the full merge into `dev-2.2`.

## 7. Verification criteria (single gate pass after merge)

- `pnpm lint:all`, `pnpm typecheck:all`, affected unit + integration suites, harness replay-compat, API e2e for new routes (incl. cross-tenant + route-authz matrix), five regenerated API artifacts + `gen:admin` checks, console build/lint/test + axe, SDK builds/tests, ALaaS svc + web_ui suites and the function-map acceptance checks.
- Live proof: two-encounter replay (doctor → lab → doctor) through ALaaS → HOPE: encounter 2 appended, recap shown, note covers both encounters (coverage check passes), Copy to EMR → CLOSED_COMPLETE; auto-close → CLOSED_INCOMPLETE; reopen policy.

## 8. Implementation summary

_Pending._

## 9. Change history

| Date | Change |
|---|---|
| 2026-10-05 | Ticket opened; design approved by the owner; planning wave started. |
| 2026-10-05 | Planning wave done (5 planners); contracts committed; D-19…D-27 recorded; wave 1 launched (AB-1 DB, AB-STT, E1, CG-STO, D3, F9, F5, U6). |
| 2026-10-05 | Merged into `dev-2.2`: AB-1 (schema + 2 migrations, fresh-DB D-20), AB-STT (pause/resume + segment outbox + Opus), AB-WS (gateway pause), AB-2 (domain layer), E1 (/tokenize), E7 (transcript finalizer, fact-ledger agent, gemma 32k/q4 seed), CG-STO, CG-SET, CG-POL, D3 (timeline bands), D7 (shared types), D4a (console data), D5 (vox-node handle), D6 (useConsultation); deployment `main` `ccab8bc` (gemma 32768 + q4_0, local). ALaaS `refactor-hope-integaration`: U6, F9, F5, F1, F0 (protocol v4), F3, U1. Wave-3 service contracts pinned (`94e277e29`, `planning/WAVE-3.md`); wave 3 launched (AB-3, AB-4a/b/c, AB-5, C-SVC, G-SVC, G-ROLL+MINE, E2, E4, D1) + ALaaS F2. Hand-overs tracked in `planning/HANDOVERS.md`. |
| 2026-10-05 | Wave 3 merged into `dev-2.2`: AB-3 (open = episode), AB-4a (lifecycle commands, session approve, events), AB-4b (auto-close idle/daily), AB-4c (harness processing axis), AB-5 (transcript record, `appendVersion`, batched Transit), C-SVC (attachments + audio sink + reaper), G-SVC (feedback), G-ROLL+MINE (rollup + feedback mining), E2 (activity run record), E4 (fact ledger + structured recap v2, D-30/D-31), D1 (history read service). ALaaS: F2, F6, F7, U2, U4, U7. Integration commit `ebf0ed464`: module composition (H-32/37/49/53/58/62/66/67/77/83/90) and a module cycle Summary → WorkflowExposure → Consultation → Lifecycle → Summary broken with a lazily resolved note signer (H-88). Applications + `apps/api` type-check clean; 179 modules, no import cycles. Diagnostic applications run: 41 legacy test files pin the removed vocabulary (AB-8a). NotePlan v1 contract fixture pinned (`88c29844c`); wave 4 launched (`planning/WAVE-4.md`): AB-6, CG-API, D2, E3, E5, D4b, AB-8a, AB-8c, ALaaS F0b; ALaaS U3 still running. |
