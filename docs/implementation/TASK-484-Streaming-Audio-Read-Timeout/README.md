# TASK-484 — Streaming Audio Read-Timeout (No Final Transcript Through the Gateway)

- **Status**: Review (root-caused + fixed + live-validated 2026-07-10 · `fix/2605-review` @ `0040fe3e`, not pushed)
- **Type**: bugfix (streaming reliability — **confirmed production risk, now fixed**)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Discovered during the SOTA enhancement track (2026-07-10)
- **Origin**: [SOTA-Track](../SOTA-Track/README.md) live validation of [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (quality scorecard) + [TASK-471](../TASK-471-Tentative-Tail-Render/README.md) (tentative-tail / LocalAgreement-2). During a live consultation run STT-v2 emitted PARTIALS but **no final transcript** reached the gateway.
- **Finding + severity**: **HIGH** — a real consultation whose audio has natural silence gaps could stall the STT read loop and produce an incomplete/empty final transcript with no clinician-visible signal. Not yet root-caused; the observed failure mode is severe enough (zero usable transcript) to treat as a production reliability risk until proven benign.
- **Size**: M
- **Suggested agent**: `debugger` (Python / FastAPI streaming) — apply the `systematic-debugging` + `root-cause-tracing` skills against a live test stack. Read-only until the root cause is isolated.

## ✅ RESOLVED — root-caused + fixed + live-validated (2026-07-10)

The parallel session (chip **`task_1db4d82a`**) landed the root cause and fix on `fix/2605-review` @ `0040fe3e`. **The working hypothesis below was REFUTED**: the redis read-timeout is a red herring (it logs-and-recovers, never starves audio); the real blocker is a **gateway** result-relay bug. See §Implementation Summary. The `⚠️ do-not-open-a-competing-branch` guidance is now spent — the fix is committed.

## Requirement Analysis

The realtime loop (mic → SDK/WS → gateway `/ws/stt-v2/stream` → Redis `stt:audio:{session}` → STT-v2 → Redis `stt:result` → captions) must deliver a **final** transcript, not just partials, across the natural silence gaps of a real consultation. During the 2026-07-10 SOTA live validation it did not:

- STT-v2 emitted PARTIALS but **no final** transcript through the gateway.
- Scorecard signals from the TASK-470 harness: `hypothesis_words = 0`, `medical_wer = 1.0`, `audio_coverage_ratio = 0.0` — i.e. the gateway saw effectively nothing usable.
- STT-v2 logged persistent `XREADGROUP "Timeout reading from localhost:6380"` on the audio stream, logger `stt_v2.streaming.redis_streams`.

**Reproduced across THREE independent configs**, ruling out stale state / model / reload overhead:
1. pipelines `best-practice-realtime` **and** `turbo-whisper-large-v3` (both carry the TASK-471 LA-2 streaming block);
2. a **flushed** test Redis (fresh state);
3. STT-v2 launched **without `--reload`** (no reload/watch overhead).

The [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) resume e2e (continuous audio, no gaps) **passed** — so the defect manifests specifically during **audio gaps** (silence) and/or under this machine's combined load, not on an unbroken audio stream.

**Working hypothesis (to prove or refute):** the STT audio reader's redis-py `socket_timeout` is **shorter than** the blocking `XREADGROUP BLOCK` window, so every read that spans a silence gap raises `TimeoutError` instead of returning empty — the reader then logs "XREADGROUP failed, retrying", sleeps, and loops, starving frame consumption (→ `audio_coverage_ratio = 0.0`, no final). Alternatives to weigh: a **final/VAD-emission** issue (partials flow but the finalize/emit path never fires) or **machine-load** saturation of the single dev box.

### Acceptance criteria

- [ ] **AC-1 (reproduce)**: a deterministic repro on the live/test stack that yields PARTIALS-but-no-final with the `XREADGROUP … Timeout reading` log, with a silence gap in the audio (matching the SOTA observation).
- [ ] **AC-2 (root cause)**: the actual source of the redis-py read timeout is identified — a `socket_timeout` in effect on the streaming reader's client and its value, OR a proven pivot to the final/VAD-emission path, OR a machine-load explanation. (See §Current State — the current tree does **not** obviously set a streaming-client `socket_timeout`, so the source must be located, not assumed.)
- [ ] **AC-3 (fix, red-first)**: a failing test reproducing the gap-stall, then the minimal fix. If it is the timeout/BLOCK mismatch, guarantee `socket_timeout` (if any) **exceeds** `block_ms` (or is `None`) — or reduce `block_ms` below the socket timeout — so a silence gap returns an empty read, never a `TimeoutError`.
- [ ] **AC-4 (unblock)**: with the fix in place, a live consultation with silence gaps produces a non-empty final transcript through the gateway (`hypothesis_words > 0`, `audio_coverage_ratio` restored), unblocking the TASK-470 scorecard + TASK-471 latency gate.
- [ ] **AC-5 (gates)**: `pnpm py:stt-v2:test` (+ `:lint`, `:typecheck`) green; evidence pasted into §Implementation Summary.

### Non-goals

- The consumer-groups migration itself (TASK-457, already landed) — this is a timeout/emission defect on top of it, not a rollback.
- Reworking the TASK-471 tentative-tail render or the TASK-470 harness — they are the **blocked consumers**, not the cause.
- General dev-box performance tuning beyond confirming/excluding machine load as the trigger.

## Current State Evaluation (code-verified against `fix/2605-review`)

The `stt:audio` reader is the TASK-457 consumer-groups `IngestionConsumer`:

- **`apps/stt-v2/src/stt_v2/streaming/redis_streams.py:32`** — `logger = structlog.get_logger(__name__)` → module logger `stt_v2.streaming.redis_streams` (matches the finding's logger).
- **`redis_streams.py:142`** — `block_ms: int = 5000` (constructor default). Docstring `:126-127`: "`XREADGROUP BLOCK` timeout in milliseconds (0 = indefinite)." So the blocking read waits up to **5000 ms**.
- **`redis_streams.py:320-326`** — the read: `entries = await self._redis.xreadgroup(self._group_name, self._consumer_name, {stream_key: ">"}, count=100, block=self._block_ms)`.
- **`redis_streams.py:327-338`** — the `except`: any non-`NOGROUP` exception logs `"XREADGROUP failed, retrying"` with `error=str(exc)`, `await asyncio.sleep(1)`, `continue`. A redis-py `TimeoutError("Timeout reading from localhost:6380")` lands here — exactly the observed line — and the reader then busy-retries every ~1 s **without consuming the frames waiting in the stream**, which is consistent with `audio_coverage_ratio = 0.0` and no final.
- **`redis_streams.py:340-341`** — a clean BLOCK timeout is meant to return `not entries` and `continue` (no error). The observed behavior is the **error** path, not this benign path.

Where the reader's Redis client comes from (the `redis` is **injected**, not built in `redis_streams.py`):

- **`apps/stt-v2/src/stt_v2/streaming/_runtime.py:93-96`** — the dedicated streaming client is `aioredis.from_url(settings.redis_url, decode_responses=False)`. **No `socket_timeout` is passed.**
- **`apps/stt-v2/src/stt_v2/core/config/settings.py:79-82`** — `redis_url` default `redis://localhost:6379/0` — **no `socket_timeout` query param.**
- **`.env.test:55`** — `REDIS_URL=redis://:test_redis_pass@localhost:6380` (the `:6380` test Redis named in the finding) — **no `socket_timeout` query param.**
- **Contrast — `apps/stt-v2/src/stt_v2/health/api/routes.py:187-190`** — the health probe builds its **own** short-lived client `aioredis.from_url(settings.redis_url, …, socket_timeout=2)`. This is a separate client/pool from the streaming reader, but it proves a 2 s socket timeout exists elsewhere in the service — a candidate source to rule in/out (e.g. shared-pool bleed, or the SOTA run using a different config).

**Key code-verified nuance:** on the current tree the streaming reader's client sets **no `socket_timeout`**, and neither `redis_url` source embeds one — so a redis-py "Timeout reading" from this reader is **not** explained by an obvious `socket_timeout < BLOCK(5000ms)` mismatch as the code stands. The investigation must therefore (a) locate the `socket_timeout` actually in effect during the SOTA run (a redis-py/pool default, an env override, or the health client's 2 s value reaching the reader), or (b) pivot to the final/VAD-emission or machine-load hypotheses. The `block_ms=5000` vs any sub-5 s socket timeout is the arithmetic to close.

### Blocks

- **[TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md)** quality scorecard — cannot score a run that produces no final (`hypothesis_words=0`, `medical_wer=1.0`).
- **[TASK-471](../TASK-471-Tentative-Tail-Render/README.md)** before/after latency gate — the tentative tail can't be measured without a flowing transcript.

## File-ownership manifest (proposed — confirm on assignment)

| File | Expected change |
|---|---|
| `apps/stt-v2/src/stt_v2/streaming/redis_streams.py` | If the timeout/BLOCK path is confirmed: reconcile `block_ms` with the client `socket_timeout` (or harden the `except` so a read timeout is treated as an empty poll, not a starving error-retry). |
| `apps/stt-v2/src/stt_v2/streaming/_runtime.py` | If a `socket_timeout` is needed/needs bounding on the streaming client, set it here explicitly (> `block_ms`, or `None`). |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Only if the emission/finalize path is the cause (final/VAD emission across gaps). Coordinate — shared with TASK-456/457 history. |
| `apps/stt-v2/tests/**` (or in-package streaming tests) | RED-first: a gap-stall reproduction; assert a final is emitted across a silence gap. |

Binding manifest is set when the parallel session's root cause narrows the surface. Anything outside this list → STOP and report to the orchestrator.

## Implementation Summary

**Root cause — TWO independent issues, disentangled.** The `⚠️` working hypothesis (redis `socket_timeout < BLOCK` starving the reader) was **refuted**; the empty final has a separate, deterministic cause.

1. **The real blocker — a GATEWAY result-relay bug (not STT-v2, not the read-timeout).** `StreamingAudioBridgeService.parseAndEmitResult` (`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`) treated `status:"finalizing"` as a **terminal** status and completed the result reader (`subject.complete(); return;`). But STT-v2 publishes `"finalizing"` (`session_manager.py:1766`) **before** it flushes + publishes the tail final (`_flush_final_utterance` → `inference.py` publish, `is_final=1`), then `"closed"`. Result-stream order = `finalizing → FINAL → closed`, so the reader tore down one entry early and the tail final was **orphaned in Redis, never relayed**. Deterministic + load-independent + present since the initial commit (NOT a TASK-471 regression). This is why partials flowed but no final arrived — and why a single-utterance clip (VAD sees one utterance, so its only final is the tail flush) came out fully empty. **Fix:** terminate only on `closed`/`cancelled`; `finalizing` is a non-terminal progress marker the reader skips. This is the file-ownership manifest's "emission/finalize path" branch — but the surface pivoted from `session_manager.py` (STT-v2) to the **gateway bridge** in `packages/applications`, outside the proposed manifest (recorded here per the STOP-and-report rule; the pivot is the root-cause narrowing the manifest anticipated).

2. **The redis read-timeout is a RED HERRING (logs-and-recovers).** Proven empirically against the live test Redis: a redis-py `socket_timeout` < the 5000 ms `BLOCK` raises the exact `"Timeout reading from localhost:6380"` on `XREADGROUP`/`XREAD`, but a frame XADDed after such a timeout is still delivered on the next `>` read (consumer-group cursor is server-side; `ControlListener.last_id` is client-side) — **no data loss, the terminal frame is not stranded**. The committed streaming client sets no `socket_timeout` (as §Current State already code-verified), so the SOTA-run timeout came from a **runtime/env-injected** `socket_timeout` (health client is `2` s; a `?socket_timeout=` on `REDIS_URL`, or a shell/pool bleed). It is log-spam + minor latency, never the empty-final cause. **Hardening (AC-3's "harden the `except`" option):** `IngestionConsumer`/`ControlListener` now treat a blocking-read `TimeoutError` as a benign empty-read (re-issue, no error log / no backoff) so the readers stay correct under any injected `socket_timeout`, + `health_check_interval` on the streaming client (`redis_streams.py`, `_runtime.py`).

**Fix commit** `0040fe3e` (`fix/2605-review`, not pushed) — 6 files, +196/−6: gateway bridge (P0) + `redis_streams.py`/`_runtime.py` (P2) + RED→GREEN tests (`streamingAudioBridge.service.test.ts`: finalizing non-terminal + cancelled terminal; `TestBlockingReadTimeoutTolerance` in `test_stream_hygiene.py`) + the TASK-471 README evidence.

**AC status:** AC-1 reproduce → done (deterministic, but the timeout was NOT the cause — pivoted). AC-2 root cause → **gateway finalizing-terminal relay** (+ redis timeout ruled out as red herring). AC-3 red-first fix → done (both the gateway fix and the AC-3 "harden the `except`" hardening). AC-4 unblock → **done, live**: through the WS gateway (whisper-large-v3-turbo) all three clinical clips now commit finals — `medical_wer 0.033/0.065/0.066`, `keyterm_recall 1.0`, `audio_coverage 0.994–0.997`, `hypothesis_words > 0`, **0** redis timeout errors. AC-5 gates → `@arcaai/applications` build+lint clean, `5930` bridge tests; stt-v2 streaming `350` + hygiene `16` (incl. 2 new); ruff/mypy clean.

**Downstream:** the TASK-470 scorecard + TASK-471 latency gate are **unblocked** (finals commit). The scorecard's remaining regression red (`partial_revision_rate`, `commit_latency_p50`) is TASK-471's AC-4 cadence trade-off + single-box contention — carried as a product-owner decision in [TASK-487](../TASK-487-Streaming-Scorecard-Threshold-Decision/README.md), NOT this defect.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded from the SOTA live validation of TASK-470/471. Symptom (PARTIALS but no final; `hypothesis_words 0`, `medical_wer 1.0`, `audio_coverage_ratio 0.0`; persistent `XREADGROUP "Timeout reading from localhost:6380"`, logger `stt_v2.streaming.redis_streams`), three-config reproduction (best-practice-realtime + turbo, flushed Redis, no `--reload`), and the "manifests during audio gaps / under load; TASK-457 continuous-audio resume e2e passed" scoping recorded. Code-verified the reader's `block_ms=5000` (`redis_streams.py:142`/`:325`), the error-retry `except` (`:327-338`), and that the streaming client (`_runtime.py:93-96`) + both `redis_url` sources set **no `socket_timeout`** (contrast: health client `socket_timeout=2`, `routes.py:190`). Flagged that this **blocks** the TASK-470 scorecard + TASK-471 latency gate. **Actively investigated in parallel session (chip `task_1db4d82a`)** — this is the tracking doc; fold its result back here. Status → Pending. |
| 2026-07-10 | **Root-caused + fixed + live-validated** (`0040fe3e`, `fix/2605-review`). Working hypothesis (redis `socket_timeout < BLOCK` starving the reader) REFUTED — the timeout logs-and-recovers (frame redelivered via the `>` cursor; no loss), and the committed client sets no `socket_timeout` (env-injected at SOTA-run time). Real blocker = the **gateway** result-relay treating `status:"finalizing"` as terminal and tearing down before STT-v2's tail final (published after `finalizing`) is relayed → tail final orphaned; single-utterance clips → fully empty. Fixed the bridge (terminal only on `closed`/`cancelled`) + hardened the STT-v2 blocking reads to tolerate any injected `socket_timeout` (AC-3's "harden the `except`" path) + `health_check_interval`. RED→GREEN tests both sides. Live through the WS gateway: finals commit on all 3 clips (`medical_wer 0.03–0.07`, `keyterm_recall 1.0`, `audio_coverage 0.994–0.997`, 0 timeout errors). AC-1..AC-5 met (AC-2 pivoted STT-v2→gateway; fix surface outside the proposed manifest, recorded per STOP-and-report). Unblocks TASK-470/471; the residual scorecard threshold decision is spun out to TASK-487. Status → Review. |
