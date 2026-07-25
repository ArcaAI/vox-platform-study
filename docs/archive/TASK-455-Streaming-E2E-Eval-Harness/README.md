# TASK-455 — Streaming E2E Suite + Latency/Loss Eval Harness (S-10 · S1-EVAL)

- **Status**: Review (baseline captured — AC-1…AC-8 met; NEW test code only, zero product diff)
- **Type**: infrastructure (test coverage + measurement) — **gating dependency for Wave 2**
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 1 (P0)
- **Findings**: S-10 (no streaming e2e coverage) · S1-EVAL (no streaming latency/loss eval harness) — see [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA S1
- **Branch**: `fix/task-455-streaming-e2e-eval` (cut from `main`)
- **Size**: L
- **Suggested agent**: tester (Playwright + pytest + Redis)
- **Why P0-adjacent**: this suite is the **measurement gate** the Wave-2 Redis consumer-groups migration (TASK-457) must pass — "latency/loss measured, not asserted". It builds no product code; it de-risks the riskiest change in the program.

## File-ownership manifest (exclusive — binding — NEW files only)

| Path | Contents |
|---|---|
| `apps/api/tests/e2e/task-455-streaming-*.spec.ts` | Real-socket WS e2e specs (resume-after-drop, backpressure recovery, ticket-refresh mid-session) |
| `tests/helpers/streaming.helper.ts` (new) | Shared helper: `createStreamSession()` (mint session + one-shot ticket), WS connect, frame feeder |
| `apps/stt/tests/integration/test_streaming_loss_harness.py` (new) | Wire-level loss/latency harness extending the existing latency-harness pattern |
| `apps/stt/tests/e2e/fixtures/` | Reuse existing WAVs; add a synthetic generator wrapper only if needed |

**Read-only reference** (do not modify): `apps/stt/tests/integration/test_streaming_latency_harness.py`, `apps/ui-playground/e2e/**`, `apps/api/tests/e2e/task-419-stream-ticket-scopes.spec.ts`, `playwright.config.ts`, `tests/setup/playwright.global-setup.ts`, `tests/helpers/e2e.helper.ts`.

**Metric-counter question (STOP-and-report if it grows the manifest)**: no `commit_latency` / `dropped_frame` / `partial_revision` Prometheus counters exist today ([metrics.py] has only session/inference metrics). This suite should **compute metrics in-test from Redis stream entry-ID timestamps** (as the existing latency harness does) rather than adding product-code counters. If the team later wants scrapable counters, that is a separate ticket touching `apps/stt/src/**` and `apps/api/src/**` — out of this manifest.

## Requirement Analysis

There is **no real-socket streaming e2e** and **no loss eval harness** for the realtime loop. Existing coverage is unit/integration with mocks (gateway resume/backpressure simulated in-process) plus a dev-stack latency harness that bypasses the WS gateway (straight to Redis) and a happy-path-only browser e2e that isn't wired to any pnpm alias and targets the dev stack. The three highest-risk paths TASK-448 named are untested end-to-end over a real socket: **resume-after-drop**, **backpressure recovery**, **ticket-refresh mid-session**.

This ticket delivers (1) a Playwright WS e2e suite exercising those three paths against the isolated test stack, and (2) a wire-level latency/loss harness emitting P50/P99 commit latency, partial-revision rate, and dropped-frame/loss counts — the quantitative baseline the consumer-groups migration is measured against.

### Acceptance criteria

- [ ] **AC-1 (shared helper)**: `tests/helpers/streaming.helper.ts` mints a stream session + one-shot ticket via `POST /api/v1/audio/transcription-jobs/stream/session` (or the internal path), returns `{ sessionId, wsUrl, ticket }`, and opens an authenticated WS to `/ws/stt/stream`. Reuses `SEEDED_USERS`/`loginUser` from `tests/helpers`. Requires a seeded ASR pipeline (assert/skip if absent).
- [ ] **AC-2 (resume-after-drop)**: an e2e spec streams audio, forces a mid-stream socket drop, reconnects with the resume handshake, and asserts transcripts resume from `lastSeq` with **no duplicate flood and no silent freeze** (the C3-01 failure mode). Documents the observed behavior against today's plain-XREAD transport (expected: this test likely FAILS or shows the duplicate-then-frozen behavior — that is the baseline the migration must fix; mark it `test.fixme`/documented-baseline rather than green-washing it).
- [ ] **AC-3 (backpressure recovery)**: a spec drives sustained frames to exceed the client watermark and/or gateway egress watermark, then asserts recovery once buffers drain — and that drops are observable (ties to TASK-454's counters).
- [ ] **AC-4 (ticket-refresh mid-session)**: a spec exercises a session outliving its ticket TTL and asserts the documented re-auth path (or documents its absence as a finding).
- [ ] **AC-5 (loss/latency harness)**: `test_streaming_loss_harness.py` replays a known WAV (or the deterministic synthetic generator) through the **WS gateway** (not straight to Redis), and reports: first-partial latency, commit/stable latency P50/P99, partial-revision rate, frames-sent vs frames-transcribed (loss), all as a JSON artifact via `test.info().attach` / a report file.
- [ ] **AC-6 (baseline captured)**: a baseline run against the current transport is recorded in §Implementation Summary — this is the number TASK-457 is compared to. No target thresholds are asserted as pass/fail yet (baseline only); document what "no regression" will mean for TASK-457.
- [ ] **AC-7 (runnable + documented)**: the suite documents its prereqs (`pnpm docker:test:up` + `pnpm test:api:up` + `pnpm test:stt:up` + seeded pipeline) and self-skips cleanly when STT is unreachable (Playwright global setup treats it as optional). A pnpm alias or documented invocation is provided (the browser e2e's lack of an alias is a known gap — do not repeat it).
- [ ] **AC-8**: the new specs follow repo conventions (`task-455-*.spec.ts`, `**/*.spec.ts` match, env via `dotenv -e .env.test`, baseURL 8868; Python `test_*.py` under `tests/integration/`, `pytest.mark.integration`, run via `pnpm py:stt:test:integration`).

### Non-goals

- Implementing the consumer-groups migration (TASK-457, Wave 2) — this only measures.
- Adding Prometheus counters to product code (separate ticket if wanted).
- Fixing the resume/backpressure defects themselves (C3-01/02/03 → TASK-457; C6-01 → TASK-454) — this suite makes them measurable and reproducible.
- Full clinical WER/quality scoring (the browser e2e already has WER helpers; reuse if trivial, but quality scoring is not the goal — latency/loss is).

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**Playwright e2e**: root `playwright.config.ts` (`testDir: apps/api/tests/e2e`, `testMatch **/*.spec.ts`, baseURL `http://localhost:8868/api/v1`); run `pnpm test:e2e` (= `dotenv -e .env.test -- playwright test`), API via `pnpm test:api:up`. Global setup resets DB, waits on API health; `E2E_WAIT_SERVICES=true` additionally waits on STT 8861 (required:false). Auth helpers + `SEEDED_USERS` in `tests/helpers/e2e.helper.ts`; ticket-mint pattern in [task-419-stream-ticket-scopes.spec.ts](apps/api/tests/e2e/task-419-stream-ticket-scopes.spec.ts).

**Isolated stack** ([tests/docker-compose.test.yml]): PG 5433, Redis 6380 (pass `test_redis_pass`), MinIO 9002, Qdrant 6335. **STT is NOT in the compose stack** — started separately via `pnpm test:stt:up` (`scripts/start-test-stt.sh`, uvicorn 8861 under `arcaenv`, loads `.env.test`). Full mic→WS→Redis→STT needs three processes: docker test infra + `test:api:up` + `test:stt:up`.

**Existing streaming tests** (all unit/integration, no real-socket e2e): gateway unit test [stt-ws.gateway.test.ts] (mocked socket; simulates resume replay, 512 KiB egress backpressure, 200-final queue bound); SDK client unit test [SttWebSocketClient.test.ts]; bridge unit test [streamingAudioBridge.service.test.ts]; STT sessions REST e2e [test_streaming_sessions_api.py]; **latency harness** [test_streaming_latency_harness.py] (replays WAV/synthetic straight onto Redis `stt:audio:{sid}`, reads `stt:result:{sid}`, computes TTFW/cadence/final-lag p50/p95 from entry-ID clock — bypasses the WS gateway, targets dev stack); browser e2e [apps/ui-playground/e2e/**] (real mic→WS→stt with fake-audio fixtures, WER + P50/P95/P99 — but happy-path only, no pnpm alias, dev-stack-targeted).

**Session/ticket creation**: `POST /api/v1/audio/transcription-jobs/stream/session` ([transcription-job.controller.ts:312-407]) mints `sessionId`, forwards to stt `POST /internal/streaming/sessions`, issues one-shot `stt_session:{sid}` ticket, binds tenant + meta; returns `{ sessionId, wsUrl, ticket, ticketExpiresAt }`. **No shared TS helper mints a stream session today** — AC-1 adds it.

**Metrics available**: stt `/metrics` has `stt_streaming_sessions_active/total`, `stt_streaming_inference_latency_seconds`, `model_inference_latency_seconds` — **no commit-latency/dropped-frame/partial-revision counters**. Gateway streaming module exposes no Prometheus counters; dropped-frame counts live only as in-memory per-session fields in the disconnect log. → compute metrics in-test from Redis entry-ID timestamps (as the latency harness does).

**Fixtures**: WAVs in `apps/stt/tests/e2e/fixtures/` (16 kHz mono en/ml) and `apps/ui-playground/e2e/fixtures/` (with ground-truth `.txt`); deterministic `synthesize_speech_like_audio()` in the latency harness (timing-only). Inference stub patterns: ASR-callable injection (`SessionManager._make_asr_callable` with a mock model) or `get_session_manager` patch — but **no standing fake inference worker behind the real Redis loop**; existing harnesses run against a real stt with clean skips.

## Implementation Plan

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (this suite measures the **realtime loop** only; the durable harness is out of scope) · `tests/README.md` · `.claude/rules/09-infrastructure-devops.md` (test infra, ports, compose) · `.claude/rules/05-nestjs-api.md` (WS gateway, stream tickets).

1. Build `tests/helpers/streaming.helper.ts` (AC-1) — session+ticket mint, WS connect, frame feeder. Validate it against a running stack manually first.
2. Extend the latency harness into `test_streaming_loss_harness.py` (AC-5) — route through the WS gateway, add loss + P99 + partial-revision metrics + JSON report.
3. Author the three e2e specs (AC-2/3/4). For paths that expose current defects, record the baseline behavior explicitly (documented-baseline / `test.fixme` with a comment referencing the target ticket) — do NOT assert green on broken behavior.
4. Capture the baseline run (AC-6) into §Implementation Summary; define the "no regression" contract for TASK-457.
5. Document prereqs + provide an invocation/alias (AC-7). Confirm clean skip when STT is down.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm docker:test:up
pnpm test:api:up        # terminal 1
pnpm test:stt:up     # terminal 2
pnpm test:e2e           # runs task-455 specs (self-skip if STT unreachable)
pnpm py:stt:test:integration   # runs the loss harness
```

Adversarial review focus (reviewer agent): (a) does the resume-after-drop spec truly exercise a real socket close+reopen, or does it mock it? (b) are the latency metrics computed from a defensible clock (Redis entry-ID vs wall clock) and reproducible? (c) does the suite self-skip cleanly (no false failures) when STT isn't up? (d) is the baseline captured in a form TASK-457 can diff against? (e) new files only — zero diff to product code.

## Implementation Summary

Delivered NEW test code only (zero product diff — `git status` shows exactly the five
manifest files, all untracked additions). Validated against the live isolated stack
(API :8868, STT :8861 running OFFLINE from the model volume, PG :5433 / Redis :6380).

### Files added (manifest honored)

| Path | Purpose |
|---|---|
| `tests/helpers/streaming.helper.ts` | AC-1 shared helper: login → mint session + one-shot ticket → open authenticated WS to `/ws/stt/stream` → realtime PCM frame feeder + capture wrapper; `refreshStreamTicket`, `probeStreamHandshake`, WAV loader. Takes an INJECTED `ws` ctor (the `ws` package resolves from `apps/api/**` spec files but NOT from root `tests/helpers/`, so the helper imports no `ws` at runtime — no root-manifest change). |
| `apps/api/tests/e2e/task-455-streaming-resume-after-drop.spec.ts` | AC-2 |
| `apps/api/tests/e2e/task-455-streaming-backpressure-recovery.spec.ts` | AC-3 |
| `apps/api/tests/e2e/task-455-streaming-ticket-refresh.spec.ts` | AC-4 |
| `apps/stt/tests/integration/test_streaming_loss_harness.py` | AC-5/6 wire-level loss/latency harness through the WS gateway |

### Environment note (load-bearing) — pipeline selection

`assertPipelineOwnership` (`transcription-job.controller.ts#createStreamSession`) is a
tenant-scoped `pipelineService.getById` (404-over-403). The seeded `__GLOBAL__` callers
(tenant `50000000-…0000`) do **not** own the SYSTEM-tenant `best-practice-*` pipelines, so
`POST /stream/session` with `best-practice-realtime` (or any SYSTEM pipeline id) **404s**.
The suite therefore defaults to the `__GLOBAL__`-owned **`turbo-whisper-large-v3`**
(`81000000-0000-0000-0001-000000000402`), whose ASR model is `openai/whisper-large-v3-turbo`
— the same Whisper-Turbo model family as `best-practice-realtime` and one cached on the
offline volume. Override with `STREAM_E2E_PIPELINE_ID` / `STREAM_PIPELINE_ID`. No model
download was attempted (OFFLINE).

### CAPTURED BASELINE (AC-6) — the numbers TASK-457 is measured against

**(1) Loss / latency harness** — `test_streaming_loss_harness.py`, through the WS gateway,
30 s of the committed Malayalam WAV, 80 ms frames, warmed model, client monotonic clock
(send = `ws.send()` return; receive = onmessage). Full JSON at `./stt-loss-report.json`.

```json
{
  "first_partial_ms": 4920.4,
  "ttfw_ms": 4920.4,
  "commit_latency_ms": { "count": 11, "mean": 5679.6, "p50": 6023.2, "p99": 7624.2, "min": 1559.2, "max": 7677.2 },
  "partial_revision": { "partials": 1, "revisions": 0, "rate": 0.0 },
  "loss": {
    "frames_sent": 375, "audio_seconds_sent": 30.0,
    "final_coverage_seconds_max": 29.89, "audio_coverage_ratio": 0.996,
    "seq": { "max_seq": 12, "distinct": 12, "missing": [], "gap_count": 0 }
  },
  "counts": { "partials": 1, "finals": 11, "errors": 0 }
}
```

Reading: commit latency is **P50 ≈ 6.0 s / P99 ≈ 7.6 s** — INFERENCE-dominated on this offline
whisper-turbo host (VAD-confirmation + model inference, not transport). On the connected
happy path the plain-XREAD transport shows **no caption loss** (`seq.gap_count = 0`) and
**~99.6 % audio coverage**. `partial_revision.rate = 0.0` is near-trivial here because this
pipeline emits mostly finals (only 1 partial in 30 s); the metric function itself is pinned
by the pure-CPU self-check `test_metric_functions_are_correct`.

**(2) Resume-after-drop (AC-2)** — documented-baseline (PASS), attached JSON:

```json
{
  "preDropSeqs": [1, 2], "lastSeqBeforeDrop": 2,
  "handshakeAcceptedAfterDrop": true, "refreshTicketStatus": 200,
  "resumeReplyType": null, "noSessionErrorOnResume": false,
  "preDropTranscriptsReplayedOnReconnect": 2, "transcriptsAfterResume": 4,
  "reconnectMessageTypesFromGateway": ["transcript", "status"],
  "c3_01_duplicate_flood": true, "c3_01_silent_freeze": false,
  "finding_control_frames_ignored": true
}
```

Reading: after a real socket cut + reconnect (fresh ticket) the transport re-reads the
result stream from offset 0, **re-delivering already-seen captions with seq reset to 1**
(`c3_01_duplicate_flood = true`, `preDropTranscriptsReplayedOnReconnect = 2`) — the C3-01
DUPLICATE-FLOOD baseline TASK-457's consumer-groups migration must eliminate.

**(3) Backpressure / overload recovery (AC-3)** — documented-baseline (PASS), attached JSON:

```json
{
  "framesSent": 300, "floodDurationMs": 4, "floodRealtimeRatio": 0,
  "socketOpenAfterFlood": true, "transcriptsReceived": 5, "finalsReceived": 5,
  "reachedClosedStatusAfterStop": false, "bridgeErrorFrames": 0
}
```

Reading: a ~300× -realtime ingest burst (300 frames in 4 ms) does not tear down the loop —
socket stays open, captions keep flowing (**recovery**), no `BRIDGE_ERROR`. The gateway
egress 512 KiB watermark is not client-observable / not reproducible on the shared stack and
stays pinned by the in-process `stt-ws.gateway.test.ts` (captured here as a `test.fixme`).

### Two defects surfaced by this gate (product code — NOT fixed here; out of the NEW-tests-only manifest)

1. **WS JSON control channel is non-functional over a real socket.** `SttWsGateway.handleMessage`
   splits audio vs JSON with `Buffer.isBuffer(rawData)`, but `ws@8.21.0` delivers **TEXT frames
   as `Buffer`** (breaking change from ws v7). So `{type:'stop'|'resume'|'close'}` text frames are
   misclassified as binary audio and the JSON path never runs. Proven directly: `{type:'close'}`
   did not close the socket and an unknown-type frame drew no `UNKNOWN_TYPE` error. Consequences
   captured in the baselines: the D-17 resume handshake is unanswered (`resumeReplyType: null`,
   only `transcript`+`status` come back), and client-driven finalize is a no-op
   (`reachedClosedStatusAfterStop: false`; sessions finalize only via VAD / the STT reaper).
   The fix is one line in the gateway (honor the `isBinary` arg of the `ws` `message` event) —
   filed for TASK-457/TASK-454 owners.
2. **C3-01 duplicate flood** (as above): reconnect re-reads the result stream from 0.

### "No regression" contract handed to TASK-457

TASK-457 (Redis consumer-groups transport) must, re-running the harness on the **same fixture +
pipeline (`…402`) + 80 ms frames, warmed**, show NONE of the following worse than this baseline:

- `commit_latency_ms.p50` / `.p99` not materially higher than **6023 / 7624 ms** (transport must
  not add latency; inference dominates, so treat the transport delta, not the absolute, as the gate);
- `partial_revision.rate` not higher than **0.0** on this pipeline;
- `loss.seq.gap_count` stays **0** and `loss.audio_coverage_ratio` stays **≥ 0.996** on the connected path;
- **resume-after-drop**: `c3_01_duplicate_flood` must flip to **false** and the D-17 resume must be
  answered — i.e. the `test.fixme` "TARGET (TASK-457)" in the resume spec must go green (drop its
  `.fixme`) with `preDropTranscriptsReplayedOnReconnect = 0` and no seq reset. (This also requires
  fixing defect #1 so the resume frame is actually processed.)

### Verification evidence (AC-7/AC-8)

Both deliverables run under EXISTING pnpm aliases (no new alias needed → no `package.json` change):

- **e2e** via `pnpm test:e2e` (specs match `**/*.spec.ts` in `apps/api/tests/e2e`). Baseline run:
  `RESET_DB=false E2E_WAIT_SERVICES=true npx dotenv -e .env.test -- npx playwright test task-455 --workers=1`
  → **5 passed, 2 skipped** (the two `test.fixme` targets) in ~1.3 m. Self-skips cleanly when STT is down.
- **loss harness** via `pnpm py:stt:test:integration` (module in `tests/integration/`, `pytest.mark.integration`).
  Scoped baseline run:
  `STREAM_LOSS_REPORT_PATH=./stt-loss-report.json pytest apps/stt/tests/integration/test_streaming_loss_harness.py -v -s`
  → `test_metric_functions_are_correct` PASSED, `test_streaming_loss_latency_harness` PASSED (105 s),
  report written. Skips cleanly when API/STT/login/session/model are unavailable.

Reproduce from a clean checkout (stack already up per orchestrator):

```bash
pnpm install
# e2e (DB already seeded — RESET_DB=false is REQUIRED; a reset is blocked by Prisma's AI guard)
RESET_DB=false E2E_WAIT_SERVICES=true npx dotenv -e .env.test -- npx playwright test task-455 --workers=1
# loss/latency harness (baseline JSON → ./stt-loss-report.json)
pnpm py:stt:test:integration   # or scope to the one file as above
```

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings S-10/S1-EVAL; full test-infra map (Playwright config, isolated stack ports, existing latency harness, session/ticket mint path, available metrics, fixtures, inference stubs) captured by read-only scout. Confirmed no real-socket streaming e2e and no loss harness exist. No implementation started. |
| 2026-07-10 | Implemented all five NEW files (shared helper + 3 real-socket e2e specs + Python loss/latency harness); zero product diff. Ran against the live stack: e2e **5 passed / 2 `test.fixme`**, loss harness PASSED. **Baseline captured (AC-6):** commit-latency P50 6023 ms / P99 7624 ms, seq loss gap_count 0, coverage 0.996; resume-after-drop = duplicate-flood (seq reset to 1); backpressure = ingest-overload recovery holds. **Surfaced two defects** for TASK-457/454: (1) WS JSON control channel dead over a real socket — `handleMessage`'s `Buffer.isBuffer` check misclassifies ws@8 TEXT frames (stop/resume/close) as audio; (2) C3-01 duplicate flood (reconnect re-reads result stream from 0). Documented the "no regression" contract for TASK-457. Status → Review. |
| 2026-07-10 | **Both surfaced defects RESOLVED and merged to `fix/2605-review`.** Defect #1 (control channel dead) → [TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md) @ `45b3ae08`: the gateway classifies WS frames by the ws@8 `message`-event `isBinary` arg (not `Buffer.isBuffer`), so stop/resume/close work over a real socket. Defect #2 (C3-01 duplicate flood / replay-from-lastSeq) → [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) Redis consumer-groups migration (merged `b2645dc6`), which folded in the isBinary fix and flipped this suite's resume-after-drop `test.fixme` TARGET to a live GREEN gate. The "no regression" contract above is satisfied. |
