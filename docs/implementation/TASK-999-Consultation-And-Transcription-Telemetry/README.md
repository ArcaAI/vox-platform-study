# TASK-999 — Consultation & Transcription-Job Telemetry Surfaces

| | |
|---|---|
| **Status** | Review — all eight lanes merged to `dev-2.2` and gated green (§6). **Runtime browser proof still outstanding** (needs an authenticated console session); the e2e authz sweep is blocked by an environment conflict, not by this change. |
| **Type** | feature + bugfix |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-22 |
| **Surfaces** | `apps/admin-console` (consultations, transcription-jobs, shared/streams), `apps/api` (consultation + streaming modules), `packages/applications`, `packages/domains`, `packages/database` (migration, scope depends on §4) |

## 1. Requirement Analysis

Four owner requests, 2026-09-22:

1. **`/consultations` list** — show an "updated at" column, sortable so the admin can order by latest.
2. **`/consultations` detail pane** — show per-consultation telemetry: session duration; case-note count
   and total words/characters; transcription duration + words/characters + model; pre-summary tokens
   in/out + model + duration; partial(live) summary call count + tokens + model + avg/total duration;
   final summary tokens + model + duration; detected NER entities + total NER/NLP duration; guardrail
   call count + tokens + model + avg/total duration.
3. **`/audio/transcription-jobs` bug** — clicking a `COMPLETED` job produces an endless
   `[message]` → `[error]` loop; "job should NOT stay open for 1h".
4. **`/audio/transcription-jobs` scope** — list **both** batch jobs and realtime (agent-handled)
   transcription sessions, with a detail view: start/end time, agent + model + provider (incl.
   fallback), words/characters generated, latency.

The request text for the guardrail bullet ends "(this is partial summarizing task)" — read as a
copy/paste artifact from the bullet above; it is taken to mean **guardrail** calls.

**The decisive constraint** (§2): items 1 and 3 are small and mechanical. Items 2 and 4 are *not*
UI work — most of what they ask to display **is not recorded anywhere today**. §4 asks the owner
to choose how much new persistence to buy.

## 2. Current State Evaluation

Investigated 2026-09-22 by four parallel read-only lanes (consultations console, consultation
telemetry data model, the SSE stream bug, batch-vs-realtime job persistence) plus orchestrator
verification. Every claim carries a `path:line`.

### 2.1 The consultations grid ships sorting switched off — on both sides

`features: { ..., sorting: false }` (`apps/admin-console/src/features/consultations/components/consultations-screen.tsx:300`)
and every column declares `enableSorting: false` (`:174-240`). There is no `Updated` column — the six
columns are Consult, Patient, Doctor, Department, Type, Status.

The screen also bypasses the shared URL-state pipeline: it hand-builds its request params at
`consultations-screen.tsx:149-156` (page/limit/patientId/doctorId/departmentId/status) and never reads
`query.listParams`, which is the value that would carry `sort`. The console's shared grid *does* have
a full sort codec (`shared/data/grid-url-state.ts:107-125`, `:317-320`, nuqs `sort` param as
`field:asc|desc`) — this screen simply is not wired to it.

Server-side, `GET /admin/consultations` whitelists the same six params and accepts **no `sort`**
(noted in the screen's own comment at `consultations-screen.tsx:160-166`).

`Consultation.updatedAt` exists (`packages/database/src/prisma/db_main/consultation.prisma:50`) and the
detail panel already renders it (`consultation-detail-panel.tsx:130-134`).

**Caveat that shapes D-1:** `updatedAt` bumps only when the `Consultation` **row** is written. Adding a
case note writes a `ContextItem`, not the consultation, so "latest update" ≠ "latest activity".

### 2.2 Consultation telemetry: half of it exists, half was never recorded

There is no single per-call telemetry table. Three sources carry pieces:

| Source | Grain | Carries |
|---|---|---|
| `SummaryMeta` (`consultation.prisma:275-395`) | 1 row per persisted summary document | `inputTokens`, `outputTokens`, `aiModelId`, `processingTimeMs`, `ttftMs`, `stopReason` |
| `AiUsageEvent` (`usage-ledger.prisma:51-141`) | 1 row per `(request, unit)` — tokens are **rows, not columns** | `operation` (closed vocabulary), `provider`, `model`, `consultationId`, `quantity` per `unit`. **No duration column**; timing only appears as extra `CPU_SECOND`/`GPU_SECOND` rows, and only when the caller measured it |
| `AgentTrajectoryStep` (`agent-trajectory.prisma:76-134`) | 1 row per step | `durationMs` (real column), `startedAt`/`endedAt`, `stats` JSON (tokens/model/ttft), indexed by `consultationId`. **Hard-retention — pruned nightly** |

Verdict per requested item:

| Item | Verdict | Source / gap |
|---|---|---|
| (a) session duration | **DERIVABLE** | `createdAt` → `updatedAt`. No session start/end column exists; true "last activity" needs a MAX over children (see D-1) |
| (b) case-note count | **AVAILABLE** | `ContextItemRepository.findCaseNotes` |
| (b) case-note words/chars | **NOT RECORDED** | `ContextItem` stores only `encryptedContent`; no length column anywhere. Counting needs a PHI decrypt (see D-3) |
| (c) transcription duration | **AVAILABLE** | `AudioRecording.duration` (ms, `consultation.prisma:243`) and/or the `AUDIO_SECOND` ledger row |
| (c) transcription words/chars | **NOT RECORDED** | A word count *is* computed at `sttInternal.service.ts:371` and then **discarded** |
| (c) transcription model | **NOT RECORDED cleanly** | STT usage rows stamp `model: null` explicitly (`sttInternal.service.ts:682`). Recoverable only from `TranscriptionJob.resolvedSpec` JSON or `attributesJson.engine` |
| (d) pre-summary tokens/model/duration | **AVAILABLE** | `SummaryMeta` on the `PRE_SUMMARY` item; corroborated by `AiUsageEvent` op=`presummarize` |
| (e) partial/live summary | **AVAILABLE only via the pruned trajectory table** | `sessionKind=LIVE_DOC, stepType=LLM_CALL, name IN ('flush','flush.repair')` — `durationMs` column + tokens/model in `stats`. **Not separable in the ledger**: live flushes write op=`generate`, the same string as the final summary, with no `sessionId` (`live-documentation.service.ts:5772-5799`) |
| (f) final summary tokens/model/duration | **AVAILABLE** | `SummaryMeta` on the `RAW_SUMMARY`/`MODIFIED_SUMMARY` item |
| (g) NER entities | **PARTIAL** | `NamedEntity` rows exist for the synchronous clinical path; **live-doc NER entities are never persisted at all** |
| (g) NER total duration | **NOT RECORDED summably** | `NamedEntity.processingTimeMs` is stamped identically on every entity of one call (a `SUM` double-counts), and the main `extractEntities` path does not set it. Clean per-call duration exists only as the live-doc `nlp.classify-tokens` trajectory step — whose entities are the ones never saved |
| (h) guardrail tokens/model/count | **PARTIAL** | Ledger op=`guardrail.validate`, but only for guardrail riding the pre/final-summary TEXT calls (`text-usage.ts:292-323`). The live-doc groundedness check emits **no** ledger row |
| (h) guardrail duration | **NOT RECORDED** | No duration on the ledger rows; the groundedness check's duration lives on a trajectory step disconnected from them |

No endpoint aggregates any of this per consultation today. `GET /admin/agent-trajectory/metrics/generation?consultationId=`
is the closest, but it mixes pre-summary, final-summary and live-flush LLM calls into one bucket.
`AiUsageEvent` has **no index on `consultationId`** and no repository method to read by it.

### 2.3 The stream loop is a missing consumer guard, not a framework bug

The server is correct. `TranscriptionRealtimeService.subscribeToJob` detects the terminal job, emits one
status event and calls `subscriber.complete()` (`packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts:158-173`);
Nest's `@Sse()` transport then ends the HTTP response.

`EventSource` cannot distinguish a clean server close from a dropped connection, so it fires `onerror`
(`apps/admin-console/src/shared/streams/use-event-stream.ts:148-155`) — the `[error]` in the owner's log.
That alone would stop after 3 retries, except `attempt` is reset to `0` inside `onopen` (`:137`), so the
budget can never accumulate: **open → message → close → error → retry → forever**, ~1–2 s per cycle.

The hook already anticipates this. Its `close()` is documented *"Terminal stop (e.g. the consumer saw
the stream's final event). No further retries until reopen()"* (`use-event-stream.ts:41-46`), and two
consumers already do exactly that — `shared/streams/use-task-stream.ts:163-169` and
`features/dna-writing-styles/api/hooks.ts:207-216`.

`features/transcription-jobs/components/job-stream-panel.tsx` contains **no `close()` call and no terminal
check**, and subscribes unconditionally for any job id (`:85-90`) — even though the sibling polling hook
already consults `TERMINAL_JOB_STATUSES` (`features/transcription-jobs/api/hooks.ts:49-54`).

**The "1h".** No TTL on this path is an hour (the stream ticket is 30 s,
`apps/api/src/modules/auth/stream-ticket.service.ts:25`). The loop's only ceiling is the session access
token: `JWT_EXPIRES_IN` default `'1h'` (`apps/api/src/modules/auth/auth.controller.ts:312`) — the BFF mints
tickets from the sealed cookie without refresh, so the loop runs until that token expires. That is the
best-evidence match for the owner's "stays open for 1h", and D-7 asks them to confirm.

**Blast radius:** 11 console features use `useEventStream`; the gateway exposes ~11 `@Sse()` routes.
`apps/api/src/modules/workflows/workflow-stream.service.ts:96-99` has the same terminal-then-`res.end()`
shape, so any consumer that does not call `close()` has the same latent defect.

### 2.4 Realtime transcription sessions are never written to Postgres

This is the pivotal finding for item 4.

- No `SttStreamingSession` / `TranscriptionSession` / `StreamSession` model exists in the schema.
- A realtime session lives in **Redis only**: hash `stt:session:{id}` (`apps/stt/src/stt/streaming/schemas.py:310-350`),
  expired 24 h after close (`session.py:638-639`, `settings.py:776-780`); the audio/result/control streams
  expire after **1 h** (`streaming_result_stream_expire_s`, `settings.py:771-775`).
- The only durable trace is the `AiUsageEvent` row(s) written per engine segment at teardown
  (`streamingSession.service.ts:571-649`) — carrying `sessionId`, `occurredAt` (= close time),
  `provider` (= engine), seconds — and **no start time, no model (`model: null`), no word count**.
- `TranscriptionJobType.STREAMING` and `TranscriptionJobService.createStreamingJob`
  (`transcriptionJob.service.ts:148-153`) both exist but are **dead**: the live path
  (`POST audio/transcription-jobs/stream/session`) calls `StreamingSessionService.createSession`, which
  never touches Postgres. So the list can only ever show `BATCH` rows today.

For a **batch** job, `TranscriptionJob` records `startedAt`, `completedAt`, `agentVersionId` and a
`resolvedSpec` JSONB snapshot (which carries agent slug, model, provider and the whole
`fallback.chain`) — and `resolvedSpec` is already in the response DTO
(`transcriptionJob.dto.mapper.ts:6-35`). Missing for batch: **word/char count** (computed then
discarded), **which fallback entry actually served** (only the engine name lands in the ledger; no
chain index or pointer exists), and `durationMs` (an entity getter at
`TranscriptionJobEntity.ts:406-411` that the DTO mapper omits).

`TranscriptionJobService.list` filters on `{ tenantId }` only — no `jobType` filter, no kind param.

## 3. Implementation Plan (subject to §4)

Six lanes. Dependencies: **B → C**, **E → F**; A, D independent. Lane D is a self-contained bug fix
that can land first and alone.

Per the owner's directive of 2026-09-22, **no lane runs any gate** — not lint, not typecheck, not
build, not even its own test file. Lanes write code and tests and commit. The orchestrator merges,
runs the full gate sweep **at the end of each wave**, and dispatches fix agents for what it finds.
Lanes also never run `pnpm install` (a nested-worktree install rewires the PRIMARY checkout's
symlinks — TASK-982), any DB/infra command, or any merge.

### 3.1 Frozen wire contracts (authored by the orchestrator BEFORE the lanes start)

The console mirrors gateway wire shapes as its own interfaces rather than importing
`@arcaai/applications`, so server and console lanes can build in parallel only if the shape is fixed
first. These two are frozen; a lane that needs a change requests it from the orchestrator rather
than diverging.

**C-1 — `GET /admin/consultations/:id/telemetry`**

```ts
type TelemetrySource =
  | 'summary-meta' | 'usage-ledger' | 'agent-trajectory'
  | 'named-entity' | 'audio-recording' | 'context-item' | 'transcription-job';

// Why a block is empty is the whole point: the pane must never render a
// fabricated zero. NOT_RECORDED = the platform never captures it. NO_ACTIVITY =
// captured, but this consultation has none. PRUNED = it existed and retention
// removed it (AgentTrajectoryStep is pruned nightly).
type TelemetryUnavailable = 'NOT_RECORDED' | 'NO_ACTIVITY' | 'PRUNED';

type Block<T> =
  | { available: true;  source: TelemetrySource; data: T }
  | { available: false; source: TelemetrySource | null; reason: TelemetryUnavailable };

interface LlmStats {      // one call
  inputTokens: number | null; outputTokens: number | null;
  model: string | null; provider: string | null; durationMs: number | null;
}
interface LlmAggregate {  // many calls
  callCount: number;
  inputTokens: number | null; outputTokens: number | null;
  models: string[];                       // every distinct model seen, may be []
  provider: string | null;
  avgDurationMs: number | null; totalDurationMs: number | null;
}

interface ConsultationTelemetryResponse {
  consultationId: string;
  generatedAt: string;                    // ISO-8601
  session:        Block<{ startedAt: string; lastActivityAt: string; durationMs: number }>;
  caseNotes:      Block<{ count: number; measuredCount: number; wordCount: number | null; charCount: number | null }>;
  transcription:  Block<{ jobCount: number; durationMs: number | null; wordCount: number | null;
                          charCount: number | null; model: string | null; provider: string | null }>;
  preSummary:     Block<LlmStats>;
  partialSummary: Block<LlmAggregate>;
  finalSummary:   Block<LlmStats>;
  ner:            Block<{ entityCount: number; byLabel: Record<string, number>;
                          callCount: number; totalDurationMs: number | null }>;
  guardrail:      Block<LlmAggregate>;
}
```

`measuredCount` on `caseNotes` exists because `contentWordCount` is NULL on every pre-TASK-999 row:
the pane must be able to say "12 notes, 9 measured" rather than imply the other three are empty.

**C-2 — `TranscriptionJobResponse` additions and the list filter**

```ts
interface ServedBy {
  chainIndex: number;                      // index into resolvedSpec.fallback.chain
  source: 'primary' | 'fallback';
  agentSlug: string | null; modelSlug: string | null;
  provider: string | null; engine: string | null;
}

// added to the existing TranscriptionJobResponse
jobType: 'BATCH' | 'STREAMING';            // already on the model; now meaningful for both kinds
streamSessionId: string | null;
servedBy: ServedBy | null;
resultWordCount: number | null;
resultCharCount: number | null;
durationMs: number | null;                 // completedAt - startedAt; null while running
```

List query gains `jobType?: 'BATCH' | 'STREAMING'` (absent = both kinds).

### Lane A — consultations list: `Updated` column + sort (small)
1. RED: gateway test — `GET /admin/consultations?sort=updatedAt:desc` orders by `updatedAt`; an
   unknown sort field is rejected, not silently ignored.
2. Add a `sort` param to the list DTO with an explicit allow-list (`updatedAt`, `createdAt`,
   `appointmentDate`, `status`), thread it into `ConsultationService.list`.
3. Console: rewire `consultations-screen.tsx` onto `useAdminGridParams().listParams`, turn on
   `features.sorting` + `manual.sorting`, add the `Updated` column (`formatDateTime`/`formatRelativeTime`
   per house style) with `enableSorting: true`, default sort `updatedAt:desc`.
4. Verify: sort round-trips through the nuqs `sort` URL param; paging preserves it.

### Lane B — consultation telemetry aggregate endpoint (gateway)
1. Migration: `@@index([tenantId, consultationId, occurredAt])` on `AiUsageEvent` +
   `AiUsageEventRepository.findByConsultation`. Authored against a throwaway shadow DB per
   `02-database-prisma.md`; **no** hand-authored folder left under `migrations/` unapplied.
2. New read-only route `GET /admin/consultations/:id/telemetry` (ability-gated like the existing
   consultation admin reads; cross-tenant id ⇒ 404).
3. Service fans out over `SummaryMeta`, `AiUsageEvent`, `AgentTrajectoryStep`, `NamedEntity`,
   `AudioRecording` and `ContextItem` counts, returning one DTO with **an explicit
   `source` + `available: false` marker per block** — the pane must be able to say "not recorded"
   rather than render a false zero.
4. Tests: per-block aggregation; a consultation with no AI activity returns `available: false`
   everywhere and never throws; cross-tenant id ⇒ 404.

### Lane C — consultation detail pane sections (console)
Adds telemetry blocks to `consultation-detail-panel.tsx` in the house style already used by
`features/ai-operations-runs/components/step-stats.tsx` (mono/`tabular-nums` `dl` grid, only-present
keys) and `features/workflow-runs` (`formatNumber(ms) + ' ms'`). `<Skeleton />` while loading
(rule 10); every not-recorded block renders an explicit dash + reason, never a zero.

### Lane D — the SSE terminal-close fix (bug, standalone)
1. RED: a test that a terminal `status` event closes the stream and schedules **no** reconnect.
2. `job-stream-panel.tsx`: adopt the existing house pattern — on a terminal status
   (`TERMINAL_JOB_STATUSES`, already exported) call `stream.close()`, exactly as
   `use-task-stream.ts:163-169` does. Do not subscribe at all for a job already terminal at mount.
3. Harden `use-event-stream.ts` so a *missing* consumer guard degrades to "3 retries then stop"
   instead of an infinite loop: only reset the retry budget once a connection has actually delivered
   an event, not on bare `onopen`.
4. Audit the other 9 `useEventStream` consumers for the same missing guard; fix or ticket what is found.
5. Verify in a running stack: click the seeded `ARCAAI_COMPLETED` job
   (`98000000-0000-0000-0001-000000000001`) and show a clean console — one message, no error, no retry.

### Lane E — transcription-job persistence (D-5(a), D-6(a))
Streaming sessions persisted as `TranscriptionJob` rows with `jobType = STREAMING` — written at
`StreamingSessionService.createSession`, completed at teardown, reusing the existing enum and the
currently-dead `createStreamingJob` path. Adds `resultWordCount`/`resultCharCount` and a `servedBy`
record of the fallback entry that actually ran, and stamps the real model on STT usage rows.
Migration + hand-authored entity/factory/mapper/repository edits per `03-domain-layer.md`
(**never run `pnpm gen:mapper`** — it strips the `_version` OCC guard).

### Lane G — close the expensive telemetry gaps (D-2(c)) — sequenced last
The three items of §4.2, each with its own RED test: the new ledger operation value **plus its
price-book row in the same change**; per-call NER duration recorded once on the `ner.extract` row;
live-doc NER entities persisted with an explicit dedupe rule against the synchronous path. This lane
is sequenced last because it is the only one that touches billing-adjacent code, and because Lanes
B/C can render its blocks the moment they start carrying data.

### Lane F — transcription-jobs list + detail (console)
`kind` filter (batch | realtime | all) backed by a `jobType` query param, and a `DetailDrawer` showing
start/end, duration, agent + model + provider from `resolvedSpec`, the fallback chain with the served
entry marked, word/char counts and latency.

### Verification
Stack up (`pnpm stack:dev`), seeded DB. Evidence captured per lane: the sorted grid, the telemetry pane
on a seeded consultation with real AI activity, a clean browser console on the terminal job, and the
job list showing both kinds. Runtime verification is mandatory — compiling is not working (rule 13).

## 4. Decisions

### 4.1 Answered by the owner, 2026-09-22

| # | Answer | Consequence |
|---|---|---|
| **D-2** | **(c) Close every gap** — *overrides the recommendation of (b)* | The expensive gaps are in scope: live-summary ledger rows become identifiable, NER duration is persisted summably, live-doc NER entities are persisted. Pulls the usage-ledger operation vocabulary into the blast radius (§4.2) |
| **D-5** | **(a) `TranscriptionJob` rows with `jobType = STREAMING`** | Realtime sessions get a Postgres row via the enum and `createStreamingJob` path that already exist; one list, one DTO, one screen, a `kind` filter |
| **D-7** | **(a) The reconnect loop** | Confirms Lane D is the whole fix for "stays open for 1h"; no job-timeout or Redis-TTL work is implied |
| **D-8** | **(b) Bug first, alone** | Lane D lands and is verified on its own before the feature lanes start |
| **D-1** | Not raised — recommendation stands: **(a) `Consultation.updatedAt`**, column labelled "Updated" | The column orders by when the consultation ROW last changed, which is not the same as last activity on its children. Say so if activity order is what you want; it is a denormalized column and its own ticket |
| **D-3** | Not raised — recommendation stands: **(a) counters written at write time** | No PHI decrypt on an admin read |
| **D-4** | Superseded by D-2(c): **(b) fix the ledger** | Live flushes become identifiable in the ledger, so the block no longer depends on the pruned trajectory table |
| **D-6** | Not raised — recommendation stands: **(a) record `servedBy`** | The fallback entry that actually served is written at completion/teardown |

### 4.2 Sub-decisions D-2(c) forces — flagged before the go

Choosing (c) opens three things the recommendation of (b) deliberately avoided. None is a blocker;
each is named here so it is a decision and not a surprise.

1. **The usage-ledger operation vocabulary is closed.** ~~and priced~~ — **CORRECTED 2026-09-22**:
   `AiPriceBook` has **no `operation` column** (it resolves on plane/capability/provider/model/unit),
   so a new value needs **no price-book row** and moves no rate. The real coupling is
   `metering.service.ts:379`, which excludes with `operation: { notIn: … }` — an EXCLUSION list, so a
   new value keeps counting toward billable `LLM_TOKENS` by default, which is the behaviour we want.
   Lane G pinned that with `metering/__tests__/live-generate-billable.task999.test.ts`. Existing
   `generate` rows written before the split stay ambiguous — history is not retro-classified.
2. **NER duration has no clean home.** `NamedEntity.processingTimeMs` is stamped per entity and
   double-counts on a `SUM`. Plan: record the measured per-call duration once on the `ner.extract`
   ledger row (the same way other paths carry timing) and stop relying on the per-entity field,
   rather than adding a second duration column.
3. **Persisting live-doc NER entities increases PHI at rest.** The live path currently extracts
   entities and discards them; the synchronous clinical path persists its own. Writing both needs a
   dedupe rule or the same consultation ends up with two overlapping entity sets.

### 4.3 The full decision table as put to the owner

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D-1** | What does "latest" mean for the consultations sort? | (a) `Consultation.updatedAt` — cheap, indexable, but does not move when only a child row (case note, summary) is written; (b) add a denormalized `lastActivityAt` maintained on child writes — true activity order, migration + touches several services | **(a)**, with the column labelled "Updated". (b) as its own ticket if activity order is what you actually want |
| **D-2** | How much new persistence for the consultation telemetry pane? | (a) read-only aggregation of what exists; gaps shown as "not recorded"; (b) = a + close the cheap gaps (transcript/case-note word+char counts written at write time, STT model stamped on usage rows); (c) = b + close the expensive gaps (distinguish live-summary ledger rows, persist NER duration, persist live-doc NER entities) | **(b)**. (c) is a separate ticket — it changes the closed usage-ledger vocabulary, which the price book and rollups also read |
| **D-3** | Case-note word/char totals need the PHI ciphertext decrypted. | (a) compute on write, persist counters on `ContextItem` (no read-time decrypt); (b) decrypt at read time inside the endpoint; (c) ship the count only | **(a)** |
| **D-4** | Partial/live summary telemetry exists only in the nightly-pruned trajectory table. | (a) accept it and label the block "recent runs only"; (b) fix the ledger so live flushes are identifiable (new operation value) | **(a)** now, (b) with D-2(c) |
| **D-5** | How do realtime sessions reach the job list? | (a) persist a `TranscriptionJob` row with the existing `jobType=STREAMING` (reuses the enum, the dead `createStreamingJob` path, the DTO, the list and the screen); (b) a new `SttStreamingSession` model + its own trio, routes and screen; (c) no persistence — synthesize from `AiUsageEvent` + Redis (no start time, no model, no word count, and it disappears with retention) | **(a)** |
| **D-6** | "Fallback if any" is not recorded — nothing says which chain entry served. | (a) record it (`servedBy`: engine/model + chain index) at completion/teardown; (b) display the resolved chain and the serving engine name only, unmatched | **(a)** — (b) is ambiguous whenever primary and fallback share a provider name |
| **D-7** | "Job should NOT stay open for 1h" — confirm the reading. | (a) the SSE reconnect loop, whose only ceiling is the 1 h session JWT (our evidence); (b) a job stuck in `PROCESSING`; (c) the 1 h Redis result-stream TTL keeping a realtime session alive | Confirm **(a)**; if (b) or (c), it is a different fix |
| **D-8** | Sequencing | (a) one ticket, all four items; (b) land Lane D (the bug) first and alone, then the rest | **(b)** — the bug fix is small, independently verifiable, and stops an hour of pointless reconnects today |

## 5. Out of Scope

- **Retro-classifying existing ledger history.** Rows already written as `generate` stay as they are;
  only new live flushes carry the new operation value (§4.2.1).
- Retention changes to `AgentTrajectoryStep`.
- A denormalized `lastActivityAt` on `Consultation` (D-1(b)) — its own ticket if wanted.
- `packages/ui` test suite — excluded by standing directive unless the change lands inside it.

## 6. Implementation Summary

Eight lanes, all merged to `dev-2.2`. Lanes ran in isolated worktrees and — per the owner's
directive — ran **no** gates; every figure below was produced by the orchestrator in the primary
checkout after merge.

### 6.1 What landed

| Lane | Merged | Substance |
|---|---|---|
| Step 0 | `c1e879dde`, `da47166a1` | 6 columns, 4 indexes, 2 migrations; entity + factory surfacing; frozen contracts C-1/C-2 |
| A | `c62997d98` | `sort` allow-list (`updatedAt`/`createdAt`/`appointmentDate`/`status`, bad value ⇒ 400 before the repository); console rewired to the shared grid URL state; `Updated` column; default `updatedAt desc` |
| D | `0837d6593` | Terminal-close in the job stream panel; the shared hook's retry budget now resets only on a DELIVERED event |
| B | `a13da7273` | `GET admin/consultations/:id/telemetry` — 8 blocks, each `available:true/false` with `NOT_RECORDED`/`NO_ACTIVITY`/`PRUNED` |
| E | `18c6e0bd0` | Realtime sessions persisted as `jobType=STREAMING` rows; `servedBy`; word/char counts; real model on STT usage rows; `jobType` list filter |
| G | `844bf864c` | `generate.live` (16th operation) + `sessionId` on live flushes; NER duration on the `ner.extract` ledger row; live-doc NER entities persisted with a dedupe rule; `ContextItem` counters at write time |
| C | `3ca3e618a` | The telemetry pane — 8 blocks, skeletons, and an explicit reason instead of a fabricated zero |
| F | (merged) | Kind column + filter; `DetailDrawer` with timing, agent/model/provider, fallback chain, output size |
| H | `78b241b8d` | Four more streams that never closed on their terminal frame |

### 6.2 Defects found that were NOT in the original scope

1. **The stale-job reaper would have failed live consultations.** Streaming rows are written twice,
   so they have no heartbeat; the cross-tenant `PROCESSING AND updatedAt < cutoff` sweep would have
   FAILED the row of every consultation longer than `staleProcessingMinutes` (default 20), mid-session.
   Caught by lane E; the filter is stated as "not STREAMING" and the case is now pinned by a test.
2. **The transcription detail would have mislabelled every primary-served job.** `ResolvedAsrSpec`
   *is* the primary and is never an element of `fallback.chain`, so `chainIndex: -1` means two
   different things. Branching on the index alone rendered "could not be matched" on the common case
   and never showed the primary at all. A test fixture that duplicated the primary as `chain[0]` —
   a shape the gateway cannot produce — had hidden it.
3. **Four more SSE consumers never closed on their terminal frame** (live-summary document sections
   and pre-summary, workflow-run live events, the sandbox run panel), each a reconnect storm of the
   same class as the reported bug.
4. **`Consultation.updatedAt` had no index** and became the default sort.

### 6.3 Gate evidence (orchestrator, primary checkout, 2026-09-22)

```
builds        domains / applications / api           OK (turbo 12/12)
applications  14807 passed | 10 skipped              1 file fails: see 6.4
api            4856 passed |  5 skipped
admin-console  3718 passed
typecheck     domains, applications, api, admin-console   PASS
lint          domains, applications, api, admin-console   PASS
artifacts     route-manifest (759 routes) · openapi (530 paths) · portal · vox-node admin (52 files)
drift gates   api:openapi:check · api:portal:check · vox-node gen:admin:check   PASS
generators    gen:model:check · gen:entity:check · gen:factory:check            PASS
```

`GET /api/v1/admin/consultations/{id}/telemetry` appears in the regenerated manifest as
`manage:Consultation`, `apiKeyForbidden: true`, `svc:admin:consultation-admin:manage`.

### 6.4 Not verified, and why — read before calling this done

- **`membership-bounded-sync.integration.test.ts` fails at the hook.** Environmental and
  pre-existing: `alaas-postgres` occupies port **5433**, so HOPE's test Postgres is not running and
  the suite authenticates against an unrelated database. Both of its tests are SKIPPED; no TASK-999
  code is involved.
- **The e2e authorization matrix (`task-776-route-authz-matrix.spec.ts`) has NOT been run** — same
  port conflict. `05-nestjs-api.md` makes it a definition-of-done item for a new route, so it is
  owed before this ticket closes.
- **No runtime browser proof yet.** It needs an authenticated console session, and the orchestrator
  does not enter credentials into a login form. The API (8868) and console (5176) are up and the
  browser pane is parked on the sign-in screen.

## 7. Follow-ups (not in this ticket)

- A session whose gateway dies before teardown strands a `PROCESSING` STREAMING row forever; closing
  those needs a reaper that can read Redis session state (lane E).
- `ContextItem` counters are not stamped by five writers outside lane G's boundary, incl. the
  TRANSCRIPT writes in `sttInternal.service.ts` (which already compute a word count and discard it).
- The telemetry endpoint's `TranscriptionJob` read still decrypts `encryptedResultText` through Vault
  as a side effect; a projected finder omitting the two `encrypted*` columns would close it (lane B).
- `useRunLiveEvents` and the sandbox panel still depend on a REST refetch to flip `enabled`; lane H
  made them close eagerly, but the belt-and-braces gating remains.

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-22 | Ticket opened; four read-only exploration lanes completed; plan + decisions drafted. No code. |
| 2026-09-22 | Owner answered D-2(c), D-5(a), D-7(a), D-8(b); D-1/D-3/D-6 left at recommendation, D-4 superseded by D-2(c). Added Lane G, §4.2 sub-decisions, revised scope. Awaiting go. |
| 2026-09-22 | Owner said go, and asked for maximum parallelism with NO gates run by lanes — the orchestrator gates at the end of each wave and dispatches fix agents. |
| 2026-09-22 | **Correction to §4.2.1**: `AiPriceBook` has no `operation` column (it keys on capability/provider/model/unit), so a new operation value needs NO price-book row. The real coupling is `metering.service.ts:379`, which excludes with `operation: { notIn: ... }` — a new value therefore keeps counting toward billable LLM_TOKENS by default, which is the wanted behaviour. Lane G pins it with a test. |
| 2026-09-22 | Step 0 landed (`c1e879dde`): 4 columns + 2 counters + 3 indexes, migration `20260921192153_task_999_consultation_and_job_telemetry` authored on a throwaway shadow DB with the ledger replayed (`migrate diff` reports an empty migration), dev DB pushed, shadow dropped. `gen:model:check` / `gen:entity:check` / `gen:factory:check` all green. Wire contracts C-1 and C-2 frozen in §3.1. |
| 2026-09-22 | Lane H added (4 more SSE consumers with the same defect, found by lane D's audit). All 8 lanes merged; wave-2 gate run: 6 failures out of 14,816 fixed by the orchestrator (reaper kind filter + its missing STREAMING test, frozen-list count 15→16, telemetry fixture that asserted encryption while passing no secrets service). Five artifacts regenerated, all drift gates green. |
| 2026-09-22 | Cross-lane contract drift reconciled: `servedBy.chainIndex` is -1 for the PRIMARY too, so the drawer must branch on `source` first; `TelemetrySource` widened with `'consultation'`. |
| 2026-09-22 | Seven lanes dispatched in parallel worktrees: A (sort), D (SSE fix), B (telemetry endpoint), E (streaming job rows), G (gap closures), C (telemetry pane), F (job list + detail). Boundaries are file-disjoint by construction — C writes a NEW `api/telemetry.ts` so it cannot collide with A, and F is barred from D's stream-panel files. |
