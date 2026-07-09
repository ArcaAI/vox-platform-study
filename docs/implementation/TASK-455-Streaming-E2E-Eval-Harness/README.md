# TASK-455 — Streaming E2E Suite + Latency/Loss Eval Harness (S-10 · S1-EVAL)

- **Status**: Pending
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
| `apps/stt-v2/tests/integration/test_streaming_loss_harness.py` (new) | Wire-level loss/latency harness extending the existing latency-harness pattern |
| `apps/stt-v2/tests/e2e/fixtures/` | Reuse existing WAVs; add a synthetic generator wrapper only if needed |

**Read-only reference** (do not modify): `apps/stt-v2/tests/integration/test_streaming_latency_harness.py`, `apps/ui-playground/e2e/**`, `apps/api/tests/e2e/task-419-stream-ticket-scopes.spec.ts`, `playwright.config.ts`, `tests/setup/playwright.global-setup.ts`, `tests/helpers/e2e.helper.ts`.

**Metric-counter question (STOP-and-report if it grows the manifest)**: no `commit_latency` / `dropped_frame` / `partial_revision` Prometheus counters exist today ([metrics.py] has only session/inference metrics). This suite should **compute metrics in-test from Redis stream entry-ID timestamps** (as the existing latency harness does) rather than adding product-code counters. If the team later wants scrapable counters, that is a separate ticket touching `apps/stt-v2/src/**` and `apps/api/src/**` — out of this manifest.

## Requirement Analysis

There is **no real-socket streaming e2e** and **no loss eval harness** for the realtime loop. Existing coverage is unit/integration with mocks (gateway resume/backpressure simulated in-process) plus a dev-stack latency harness that bypasses the WS gateway (straight to Redis) and a happy-path-only browser e2e that isn't wired to any pnpm alias and targets the dev stack. The three highest-risk paths TASK-448 named are untested end-to-end over a real socket: **resume-after-drop**, **backpressure recovery**, **ticket-refresh mid-session**.

This ticket delivers (1) a Playwright WS e2e suite exercising those three paths against the isolated test stack, and (2) a wire-level latency/loss harness emitting P50/P99 commit latency, partial-revision rate, and dropped-frame/loss counts — the quantitative baseline the consumer-groups migration is measured against.

### Acceptance criteria

- [ ] **AC-1 (shared helper)**: `tests/helpers/streaming.helper.ts` mints a stream session + one-shot ticket via `POST /api/v1/audio/transcription-jobs/stream/session` (or the internal path), returns `{ sessionId, wsUrl, ticket }`, and opens an authenticated WS to `/ws/stt-v2/stream`. Reuses `SEEDED_USERS`/`loginUser` from `tests/helpers`. Requires a seeded ASR pipeline (assert/skip if absent).
- [ ] **AC-2 (resume-after-drop)**: an e2e spec streams audio, forces a mid-stream socket drop, reconnects with the resume handshake, and asserts transcripts resume from `lastSeq` with **no duplicate flood and no silent freeze** (the C3-01 failure mode). Documents the observed behavior against today's plain-XREAD transport (expected: this test likely FAILS or shows the duplicate-then-frozen behavior — that is the baseline the migration must fix; mark it `test.fixme`/documented-baseline rather than green-washing it).
- [ ] **AC-3 (backpressure recovery)**: a spec drives sustained frames to exceed the client watermark and/or gateway egress watermark, then asserts recovery once buffers drain — and that drops are observable (ties to TASK-454's counters).
- [ ] **AC-4 (ticket-refresh mid-session)**: a spec exercises a session outliving its ticket TTL and asserts the documented re-auth path (or documents its absence as a finding).
- [ ] **AC-5 (loss/latency harness)**: `test_streaming_loss_harness.py` replays a known WAV (or the deterministic synthetic generator) through the **WS gateway** (not straight to Redis), and reports: first-partial latency, commit/stable latency P50/P99, partial-revision rate, frames-sent vs frames-transcribed (loss), all as a JSON artifact via `test.info().attach` / a report file.
- [ ] **AC-6 (baseline captured)**: a baseline run against the current transport is recorded in §Implementation Summary — this is the number TASK-457 is compared to. No target thresholds are asserted as pass/fail yet (baseline only); document what "no regression" will mean for TASK-457.
- [ ] **AC-7 (runnable + documented)**: the suite documents its prereqs (`pnpm docker:test:up` + `pnpm test:api:up` + `pnpm test:stt-v2:up` + seeded pipeline) and self-skips cleanly when STT-v2 is unreachable (Playwright global setup treats it as optional). A pnpm alias or documented invocation is provided (the browser e2e's lack of an alias is a known gap — do not repeat it).
- [ ] **AC-8**: the new specs follow repo conventions (`task-455-*.spec.ts`, `**/*.spec.ts` match, env via `dotenv -e .env.test`, baseURL 8868; Python `test_*.py` under `tests/integration/`, `pytest.mark.integration`, run via `pnpm py:stt-v2:test:integration`).

### Non-goals

- Implementing the consumer-groups migration (TASK-457, Wave 2) — this only measures.
- Adding Prometheus counters to product code (separate ticket if wanted).
- Fixing the resume/backpressure defects themselves (C3-01/02/03 → TASK-457; C6-01 → TASK-454) — this suite makes them measurable and reproducible.
- Full clinical WER/quality scoring (the browser e2e already has WER helpers; reuse if trivial, but quality scoring is not the goal — latency/loss is).

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**Playwright e2e**: root `playwright.config.ts` (`testDir: apps/api/tests/e2e`, `testMatch **/*.spec.ts`, baseURL `http://localhost:8868/api/v1`); run `pnpm test:e2e` (= `dotenv -e .env.test -- playwright test`), API via `pnpm test:api:up`. Global setup resets DB, waits on API health; `E2E_WAIT_SERVICES=true` additionally waits on STT-v2 8861 (required:false). Auth helpers + `SEEDED_USERS` in `tests/helpers/e2e.helper.ts`; ticket-mint pattern in [task-419-stream-ticket-scopes.spec.ts](apps/api/tests/e2e/task-419-stream-ticket-scopes.spec.ts).

**Isolated stack** ([tests/docker-compose.test.yml]): PG 5433, Redis 6380 (pass `test_redis_pass`), MinIO 9002, Qdrant 6335. **STT-v2 is NOT in the compose stack** — started separately via `pnpm test:stt-v2:up` (`scripts/start-test-stt-v2.sh`, uvicorn 8861 under `arcaenv`, loads `.env.test`). Full mic→WS→Redis→STT-v2 needs three processes: docker test infra + `test:api:up` + `test:stt-v2:up`.

**Existing streaming tests** (all unit/integration, no real-socket e2e): gateway unit test [stt-ws.gateway.test.ts] (mocked socket; simulates resume replay, 512 KiB egress backpressure, 200-final queue bound); SDK client unit test [SttV2WebSocketClient.test.ts]; bridge unit test [streamingAudioBridge.service.test.ts]; STT-v2 sessions REST e2e [test_streaming_sessions_api.py]; **latency harness** [test_streaming_latency_harness.py] (replays WAV/synthetic straight onto Redis `stt:audio:{sid}`, reads `stt:result:{sid}`, computes TTFW/cadence/final-lag p50/p95 from entry-ID clock — bypasses the WS gateway, targets dev stack); browser e2e [apps/ui-playground/e2e/**] (real mic→WS→stt-v2 with fake-audio fixtures, WER + P50/P95/P99 — but happy-path only, no pnpm alias, dev-stack-targeted).

**Session/ticket creation**: `POST /api/v1/audio/transcription-jobs/stream/session` ([transcription-job.controller.ts:312-407]) mints `sessionId`, forwards to stt-v2 `POST /internal/streaming/sessions`, issues one-shot `stt_session:{sid}` ticket, binds tenant + meta; returns `{ sessionId, wsUrl, ticket, ticketExpiresAt }`. **No shared TS helper mints a stream session today** — AC-1 adds it.

**Metrics available**: stt-v2 `/metrics` has `stt_v2_streaming_sessions_active/total`, `stt_v2_streaming_inference_latency_seconds`, `model_inference_latency_seconds` — **no commit-latency/dropped-frame/partial-revision counters**. Gateway streaming module exposes no Prometheus counters; dropped-frame counts live only as in-memory per-session fields in the disconnect log. → compute metrics in-test from Redis entry-ID timestamps (as the latency harness does).

**Fixtures**: WAVs in `apps/stt-v2/tests/e2e/fixtures/` (16 kHz mono en/ml) and `apps/ui-playground/e2e/fixtures/` (with ground-truth `.txt`); deterministic `synthesize_speech_like_audio()` in the latency harness (timing-only). Inference stub patterns: ASR-callable injection (`SessionManager._make_asr_callable` with a mock model) or `get_session_manager` patch — but **no standing fake inference worker behind the real Redis loop**; existing harnesses run against a real stt-v2 with clean skips.

## Implementation Plan

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (this suite measures the **realtime loop** only; the durable harness is out of scope) · `tests/README.md` · `.claude/rules/09-infrastructure-devops.md` (test infra, ports, compose) · `.claude/rules/05-nestjs-api.md` (WS gateway, stream tickets).

1. Build `tests/helpers/streaming.helper.ts` (AC-1) — session+ticket mint, WS connect, frame feeder. Validate it against a running stack manually first.
2. Extend the latency harness into `test_streaming_loss_harness.py` (AC-5) — route through the WS gateway, add loss + P99 + partial-revision metrics + JSON report.
3. Author the three e2e specs (AC-2/3/4). For paths that expose current defects, record the baseline behavior explicitly (documented-baseline / `test.fixme` with a comment referencing the target ticket) — do NOT assert green on broken behavior.
4. Capture the baseline run (AC-6) into §Implementation Summary; define the "no regression" contract for TASK-457.
5. Document prereqs + provide an invocation/alias (AC-7). Confirm clean skip when STT-v2 is down.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm docker:test:up
pnpm test:api:up        # terminal 1
pnpm test:stt-v2:up     # terminal 2
pnpm test:e2e           # runs task-455 specs (self-skip if STT-v2 unreachable)
pnpm py:stt-v2:test:integration   # runs the loss harness
```

Adversarial review focus (reviewer agent): (a) does the resume-after-drop spec truly exercise a real socket close+reopen, or does it mock it? (b) are the latency metrics computed from a defensible clock (Redis entry-ID vs wall clock) and reproducible? (c) does the suite self-skip cleanly (no false failures) when STT-v2 isn't up? (d) is the baseline captured in a form TASK-457 can diff against? (e) new files only — zero diff to product code.

## Implementation Summary

_Pending — must include the captured baseline latency/loss numbers (AC-6) and the documented "no regression" contract handed to TASK-457._

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings S-10/S1-EVAL; full test-infra map (Playwright config, isolated stack ports, existing latency harness, session/ticket mint path, available metrics, fixtures, inference stubs) captured by read-only scout. Confirmed no real-socket streaming e2e and no loss harness exist. No implementation started. |
