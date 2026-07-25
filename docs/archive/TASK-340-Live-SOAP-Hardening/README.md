# Live SOAP / Realtime Summarization Hardening

| | |
|---|---|
| **Ticket** | TASK-340 |
| **Name** | Live SOAP Hardening (production-hardening of the realtime summarization + live SOAP pipeline) |
| **Created** | 2026-06-08 |
| **Updated** | 2026-06-08 |
| **Status** | Completed (live end-to-end validation pending GPU/model host — see §7) |
| **Cross-ref** | **TASK-339** (Clinical Workflow Playground — ships `LiveDocumentationService`, the engine hardened here), TASK-330 (Clinical Documentation Harness — owns the authoritative SOAP note), TASK-299/307/309/310 (job/SSE auth), TASK-310 E-5 (`no-direct-downstream-url-env`) |
| **Plan** | `.cursor/plans/live_soap_hardening_e14bcb78.plan.md` (source of truth — not edited) |

> This is a **hardening** effort, not a rebuild. The realtime live-SOAP engine shipped under [TASK-339](../TASK-339-Clinical-Workflow-Playground/README.md) (`LiveDocumentationService` + SSE relay + `soap-parser`). We keep the SSE relay (`RedisSubscriberService`, ref-counted, cross-instance-correct) as-is and tighten correctness, cost/latency, resilience, durability, and observability.

---

## 1. Requirement Analysis

### Description
Harden the already-shipped realtime summarization + live SOAP pipeline for production:
- **P0-A** fix overlapping SMR/NLP generations (correctness/ordering race).
- **P0-B** bound transcript cost/latency (incremental prompt + explicit `max_tokens`/timeout/provider).
- **P0-C** validate end-to-end with real STT/SMR/NLP and make SOAP parsing deterministic (`response_format: json_schema`) instead of regex-against-unknown-output.
- **P1-A** make the watcher resilient / horizontally safer (single-owner lock + cross-instance stop/teardown).
- **P1-B** fix shared-session STT subscription teardown so two subscribers tear down independently.
- **P1-C** durable, throttled snapshot of the live draft (single upserted `ContextItem`) + final on stop.
- **P2** observability (metrics/logs) + `LIVE_DOC_ENABLED` kill-switch + config-pattern alignment for downstream URLs.

### Business context
The live-SOAP loop drives a doctor-facing cockpit. A correctness race (two SMR calls publishing out of order), an unbounded re-sent transcript (cost/latency against a 4-slot local LM Studio), a shared-session teardown bug (one subscriber aborting another's reader), and the lack of durable persistence are all production risks. This ticket closes them with surgical, test-first changes.

### Acceptance criteria
- No out-of-order publishes under overlapping flushes; stale SMR/NLP results are dropped (generation guard + AbortController).
- Live SMR calls are rate-bounded (`LIVE_DOC_MIN_INTERVAL_MS`) and cost-bounded (incremental delta prompt + `max_tokens`/timeout).
- SOAP parsing is deterministic when the model returns JSON (`response_format: json_schema`), with the existing regex parser as a graceful fallback.
- Two subscribers on one STT `sessionId` tear down independently; live-doc no longer cross-aborts the captions gateway.
- A stop routed to any instance publishes the terminal `closed` event, frees the owner lock, and signals teardown.
- The live draft is durably persisted (throttled, single upserted `ContextItem`) and finalized on stop.
- Metrics/logs (flush count, SMR/NLP latency, tokens, stale-drops, failures) emitted without PHI; `LIVE_DOC_ENABLED` disables the watcher.
- Gates pass: `pnpm build --filter @arcaai/applications`, `pnpm build:api`, `pnpm test:unit --filter @arcaai/applications`, `ReadLints` clean on changed files.

### Out of scope (per plan)
- Token-by-token streaming UI; SDK (`@arcaai/vox`) hook/store extraction.
- Harness/Temporal/Python changes; new Prisma models/enums (persistence reuses `ContextItem` + `metadata`).

---

## 2. Current State Evaluation
- `LiveDocumentationService.flush()` has **no in-flight guard**: the threshold path fires `void this.flush()` while a timer flush may still be awaiting SMR (60s) — two SMR calls race to set `lastPayload`/publish out of order (`live-documentation.service.ts:196`, `:225`).
- `callSmr` re-joins + re-sends the **whole transcript** every flush (`:230`), sets **no `max_tokens`**, and a 60s timeout (`:401`).
- SOAP parsing is **regex against free text** (`soap-parser.ts`) — never validated against real model output (TASK-339 §7 ran with SMR/STT down).
- Session state + timers live in an **in-memory `Map`** (`:61`); a `stop` routed to a different instance returns `null` and never tears the STT reader down.
- `StreamingAudioBridgeService.activeSubscriptions` is keyed by `sessionId` (`streamingAudioBridge.service.ts:33/191`); the second subscriber's `set` overwrites the first, and `unsubscribeFromResults(sessionId)` aborts only the last reader → the other leaks. Live-doc `stop()` additionally calls `unsubscribeFromResults(sessionId)` (`live-documentation.service.ts:161`), which can abort the captions gateway's reader for the same session.
- Durable persistence is only an optional `PRE_SUMMARY` on stop; the Redis snapshot is 1h TTL.

---

## 3. Implementation Plan (TDD; one shared file, sequential)
Almost all changes center on `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` (`flush`, `callSmr`, `callNlp`, `start`, `stop`, `ingestSegment`, `attachSttStream`) plus the coupled `streamingAudioBridge.service.ts`. Work is **sequential** on these shared methods (no parallel sibling edits).

Order: **p1b** (bridge + reconcile live-doc stop) → **p0c-parse** (deterministic JSON SOAP) → **p0a** (overlap/abort/throttle) → **p0b** (incremental prompt + SMR params) → **p1a** (resilient subset) → **p1c** (durable snapshot) → **p2** (metrics + kill-switch) → config → verify.

Tests (RED first):
- Extend `live-documentation/__tests__/live-documentation.service.test.ts`: overlap stale-drop, min-interval throttle, incremental prompt, deterministic JSON parse, durable-snapshot throttle, cross-instance teardown, kill-switch.
- Extend `stt/streaming/__tests__/streamingAudioBridge.service.test.ts`: two subscribers on one `sessionId` tear down independently (no leaked reader).
- Extend `live-documentation/__tests__/soap-parser.test.ts`: `parseSoapJson`.

### Decisions (made autonomously; per plan §"Decisions needed")
1. **Persistence type (P1-C)** → reuse `ContextItemType.PRE_SUMMARY` with `metadata.subType = 'LIVE_SOAP_SNAPSHOT'` (no Prisma migration, no new enum). A **single upserted** row per consultation (create-then-update), throttled by `LIVE_DOC_DURABLE_SNAPSHOT_MS` (default 30s), finalized on stop. Avoids colliding with harness-owned `RAW_SUMMARY`.
2. **Live SMR model/provider** → optional dedicated fast model via `LIVE_DOC_SMR_PROVIDER` / `LIVE_DOC_SMR_MODEL`; when unset, SMR picks its default. Live call sets `max_tokens` (`LIVE_DOC_SMR_MAX_TOKENS`, default 1500) and a shorter timeout (`LIVE_DOC_SMR_TIMEOUT_MS`, default 20s).
3. **Scaling target (P1-A)** → implement the **resilient subset** (single-owner lock + cross-instance terminal `closed`/lock-release + teardown reachable from any instance via a Redis control channel), **not** the full Redis session-state migration. Rationale + remaining gap documented in §5/§8. Keeps new keys consistent with the existing `consultation:live-summary:{id}` family.

### New config (all `LIVE_DOC_*`, sensible defaults, matching `LIVE_DOC_SEGMENT_THRESHOLD`/`LIVE_DOC_DEBOUNCE_MS`/`LIVE_DOC_HEARTBEAT_MS`)
| Key | Default | Purpose |
|---|---|---|
| `LIVE_DOC_ENABLED` | `true` | Kill-switch; `false` makes `start()` a no-op (no watcher session). |
| `LIVE_DOC_MIN_INTERVAL_MS` | `4000` | Min spacing between live SMR generations (protects the 4-slot LM Studio). |
| `LIVE_DOC_SMR_PROVIDER` | _(unset)_ | Optional dedicated fast provider for the live loop. |
| `LIVE_DOC_SMR_MODEL` | _(unset)_ | Optional dedicated fast model for the live loop. |
| `LIVE_DOC_SMR_MAX_TOKENS` | `1500` | Bound live SMR output. |
| `LIVE_DOC_SMR_TIMEOUT_MS` | `20000` | Lower live SMR timeout (was 60s). |
| `LIVE_DOC_DURABLE_SNAPSHOT_MS` | `30000` | Throttle for durable `ContextItem` snapshot writes (`<=0` disables periodic writes). |

> Two values are kept as **internal constants** (not env-tunable) to keep the config surface minimal: the per-flush transcript-delta cap `MAX_DELTA_CHARS = 12000` (sliding-window safety for the incremental prompt) and the single-owner lock TTL `LOCK_TTL = 3600s` (auto-expires if an owning instance dies).

---

## 4. Implementation Summary

All workstreams landed test-first (RED → GREEN) on the shared `live-documentation.service.ts` plus the coupled bridge, in the planned sequential order.

### Per-workstream status
| Todo | Status | What shipped |
|---|---|---|
| **P0-A** in-flight | ✅ Done | Per-session **generation counter** + single **`AbortController`** in `flush()`; a newer flush aborts the prior SMR/NLP HTTP calls (axios `signal`) and only the latest generation may publish / advance the cursor / persist (stale results are counted + dropped via `dropStale`). **Min-interval throttle** (`LIVE_DOC_MIN_INTERVAL_MS`, default 4s) coalesces a burst into one trailing re-run (`scheduleThrottledFlush`). |
| **P0-B** cost | ✅ Done | **Incremental prompt** (`buildSmrUserPrompt`): once a SOAP note exists, send prior note + only the new transcript delta since the last successful flush (cursor `flushedTranscriptCount`), capped by `MAX_DELTA_CHARS` (sliding-window fallback). `callSmr` now sets `max_tokens` (`LIVE_DOC_SMR_MAX_TOKENS`), a lower `timeout` (`LIVE_DOC_SMR_TIMEOUT_MS`, was 60s), and optional `provider`/`model` (`LIVE_DOC_SMR_PROVIDER`/`MODEL`). |
| **P0-C** validate | ✅ Done (parse) / ⚠️ degraded (live) | Deterministic `parseSoapJson` + `LIVE_SOAP_RESPONSE_FORMAT` (json_schema) wired into the flush path: `parseSoapJson(smrText) ?? parseSoapSections(smrText)` — JSON when the provider honours `response_format`, regex prose as graceful fallback. Live bring-up best-effort only (see §6 / §7). |
| **P1-A** scale | ✅ Done (resilient subset) | Single-owner **lock** (`…:lock`, claimed on start, released on stop) + cross-instance **control channel** (`…:control`): `stop()` publishes a `stop` signal + frees the lock + emits terminal `closed` **even with no local session**; an owner on any instance reacts to the control `stop` and tears down (`handleControlMessage` → `teardownLocal`). Full Redis session-state migration deferred (§7). |
| **P1-B** sttsub | ✅ Done | `StreamingAudioBridgeService.activeSubscriptions` now keyed `sessionId → Set<controller>`; each subscriber tears down independently; `unsubscribeFromResults` aborts every reader for a session. `live-documentation.stop()` no longer calls `unsubscribeFromResults` (relies on its own Observable unsubscribe) so it never cross-aborts the captions gateway. |
| **P1-C** persist | ✅ Done | `persistDurableSnapshot`: single **upserted** `PRE_SUMMARY` row (`metadata.subType='LIVE_SOAP_SNAPSHOT'`), throttled by `LIVE_DOC_DURABLE_SNAPSHOT_MS`; create-once-then-update; finalized on stop. No Prisma migration / no new enum. |
| **P2** obs | ✅ Done | PHI-safe **flush metrics log** (`generation`, `flushCount`, `smrLatencyMs`, `nlpLatencyMs`, `smr/nlpFailed`, `entityCount`, `sectionCount`, `summaryChars`, `staleDropCount` — sizes/latencies only, never transcript/summary text). **`LIVE_DOC_ENABLED`** kill-switch makes `start()` a no-op. Downstream URL note in §7. |
| **verify-doc** | ✅ Done | Gates run (§6); this README updated. |

### Files changed
| File | Purpose of change |
|---|---|
| `packages/applications/.../live-documentation/live-documentation.service.ts` | Core hardening: generation/abort + throttle (P0-A), incremental prompt + bounded SMR params (P0-B), JSON SOAP parse in flush (P0-C), lock + control-channel cross-instance stop/teardown (P1-A), durable upserted snapshot (P1-C), PHI-safe metrics + kill-switch (P2); reconciled `stop()` (P1-B). |
| `packages/applications/.../live-documentation/soap-parser.ts` | Added `parseSoapJson` (deterministic json_schema parse, fence-stripping, partial/lenient, regex fallback) + `LIVE_SOAP_RESPONSE_FORMAT` (P0-C). |
| `packages/applications/.../stt/streaming/streamingAudioBridge.service.ts` | `activeSubscriptions` → `Map<sessionId, Set<controller>>`; per-subscriber `finalize` teardown; `unsubscribeFromResults` aborts all readers for a session (P1-B). |
| `packages/applications/.../live-documentation/__tests__/live-documentation.service.test.ts` | RED→GREEN tests: overlap stale-drop, throttle, abort signal, incremental prompt, bounded SMR params, JSON SOAP parse, cross-instance stop + control teardown, durable upsert, kill-switch, metrics log; `buildDeps` config/dep injection. |
| `packages/applications/.../live-documentation/__tests__/soap-parser.test.ts` | `parseSoapJson` unit tests. |
| `packages/applications/.../stt/streaming/__tests__/streamingAudioBridge.service.test.ts` | Two-subscribers-one-session independent-teardown tests. |
| `.env.example`, `.env.dev` | New `LIVE_DOC_*` section (kill-switch, throttle, durable-snapshot, bounded SMR params, optional provider/model) with defaults + docs. |
| `docs/implementation/TASK-340-Live-SOAP-Hardening/README.md` | This ticket. |

---

## 5. Change History
| Date | Description | Files |
|---|---|---|
| 2026-06-08 | Ticket created; plan + decisions documented (persistence type, live SMR provider/model, P1-A resilient-subset scope, `LIVE_DOC_*` config). | this file |
| 2026-06-08 | **P1-B** — `StreamingAudioBridgeService` per-subscriber teardown (`Set<controller>` per session); reconciled `live-documentation.stop()` to stop cross-aborting the captions gateway. RED→GREEN. | `streamingAudioBridge.service.ts` (+test), `live-documentation.service.ts` |
| 2026-06-08 | **P0-C (parse)** — `parseSoapJson` + `LIVE_SOAP_RESPONSE_FORMAT` (deterministic json_schema SOAP, regex fallback). RED→GREEN. | `soap-parser.ts` (+test) |
| 2026-06-08 | **P0-A / P0-B / P0-C(flush) / P1-A / P1-C / P2** — coherent `flush()` rewrite: generation+abort+throttle, incremental prompt + bounded SMR params, JSON-first parse, cross-instance lock/control stop, durable upserted snapshot, PHI-safe metrics + kill-switch. RED→GREEN (11 new tests). | `live-documentation.service.ts` (+test) |
| 2026-06-08 | New `LIVE_DOC_*` config block (defaults + docs). | `.env.example`, `.env.dev` |
| 2026-06-08 | Verification gates run + best-effort live bring-up (degraded — see §6/§7); README finalized; status → Completed. | this file |

---

## 6. Verification Evidence

### Builds
```
$ pnpm build --filter @arcaai/applications
@arcaai/applications:build > rimraf dist tsconfig.tsbuildinfo && tsc
 Tasks:    7 successful, 7 total   (Time ~10.6s)

$ pnpm build:api
@arcaai/api:build > rimraf dist && nest build && tsc-alias
 Tasks:    8 successful, 8 total   (Time ~12.5s)
```

### Unit tests
> Note: `pnpm test:unit --filter @arcaai/applications` from the repo root forwards `--filter` to **vitest** (the root `test:unit` already invokes vitest), which errors with `Unknown option --filter`. The correct invocation filters at the pnpm/turbo level: **`pnpm --filter @arcaai/applications test:unit`** (or run inside the package). Evidence below uses the working form.

```
$ pnpm --filter @arcaai/applications test:unit
 Test Files  209 passed | 1 skipped (210)
      Tests  4908 passed | 4 skipped (4912)      ← whole package, no regressions

# Targeted suites for this ticket:
$ vitest run .../live-documentation/__tests__/live-documentation.service.test.ts
 Test Files  1 passed (1)        Tests  21 passed (21)     # 10 pre-existing + 11 new (P0-A/B/C, P1-A, P1-C, P2)

$ vitest run .../stt/streaming/__tests__/streamingAudioBridge.service.test.ts
 Test Files  1 passed (1)        Tests  46 passed (46)     # incl. shared-session independent teardown (P1-B)
```

### Lint
`ReadLints` on every changed source file (`live-documentation.service.ts`, `soap-parser.ts`, `streamingAudioBridge.service.ts` + their 3 test files): **No linter errors found.**

---

## 7. Deviations / Notes

### P0-C live bring-up — graceful degradation (best-effort, not blocked)
Same posture as TASK-339 §6d/§7. Probed on this machine (`curl /health`, conda `arcaenv` confirmed present):

| Service | Port | Status | Evidence / cause |
|---|---|---|---|
| STT | 8861 | ⛔ down | HTTP 000 — needs model/GPU/mic (expected, not blocked). |
| SMR | 8862 | ⛔ down | HTTP 000 — needs LLM (GPU/LM Studio) (expected, not blocked). |
| NLP | 8864 | ⛔ down | HTTP 000 — `pnpm dev:nlp` (arcaenv) reached uvicorn but **app startup failed**: HF model cache resolves to `/Volumes/aillusion` (external volume **not mounted**) → `PermissionError [Errno 13]` downloading `michellejieli/emotion_text_classifier`. Environment/config issue (NLP was healthy in TASK-339 when that cache was available), **not** caused by this work. |

Because real models were unavailable, the **deterministic path is what de-risks P0-C**: `response_format: json_schema` (`LIVE_SOAP_RESPONSE_FORMAT`) + `parseSoapJson` are implemented and unit-tested, so SOAP parsing no longer depends on fragile regex against unknown model output. The regex `parseSoapSections` remains the graceful fallback for prose-only providers. End-to-end validation against live SMR output remains the one open item, to be captured when a GPU/LM-Studio host (and a mounted model cache for NLP) is available.

### P1-A scope
Resilient subset only (see Decision 3); full Redis session-state migration deferred. Remaining gap: a brand-new instance cannot *resume* an orphaned session's accumulated in-memory transcript (it can still publish the terminal `closed`, free the lock, and signal the owner to tear down). Durability of the draft itself is covered by the P1-C throttled snapshot. The single-owner lock is claimed/released but **not yet NX-enforced to refuse start** when held by a live foreign instance — acceptable for the current single-instance deployment; documented as the remaining gap.

### Downstream URL config alignment (P2)
`LiveDocumentationService` already resolves `SMR_URL`/`NLP_URL` via injected `ConfigService` (not `process.env`); the `no-direct-downstream-url-env` ESLint rule is scoped to `apps/api/src/modules/**`, so no change is required for compliance. Documented here for transparency.
