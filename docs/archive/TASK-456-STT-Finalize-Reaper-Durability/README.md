# TASK-456 — STT Finalize / Reaper Durability (C2-03 · C2-02 · C2-05 · C2-07)

- **Status**: Completed -- all 4 findings RED->GREEN + 3-round adversarial review (Critical rework + both Important applied) + gates green (stt 2100 passed, ruff/mypy clean); only the owner's own push/PR to main remains (per owner directive, they land it)
- **Type**: bugfix (data durability — realtime transcript loss)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 (P1)
- **Findings**: C2-03 (High, CONFIRMED ✓C) · C2-02 (High, PLAUSIBLE — re-verify) · C2-05 (Med) · C2-07 (Med) — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch (when scheduled)**: `fix/task-456-stt-finalize-durability` (from the Wave-1 landing on `fix/2605-review`)
- **Size**: M
- **Suggested agent**: debugger (Python / streaming)

## ⚠️ Cross-stream coordination

**TASK-456 and [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) both touch `session_manager.py`.** Per the [program conflict ledger](../TASK-449-Harness-Loop-Remediation-Program/README.md#cross-stream-conflict-ledger-wave-1--wave-2), **TASK-456 merges first**; TASK-457's Python half (the `stt:audio` reader → consumer groups) rebases onto it. Schedule 456 before 457's stt portion. The two touch different regions (456: finalize/reaper; 457: the audio-ingest reader), so a rebase should be clean, but 456 goes first.

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/session_manager.py` | Finalize durability (C2-03), reaper timeout (C2-02), drain (C2-05), per-session finalize lock (C2-07) |
| `apps/stt/src/stt/core/config/settings.py` | Add/repoint the reaper + drain timeout knobs |
| `apps/stt/tests/unit/test_streaming_recording.py` | Persist-failure + concurrent-finalize tests |
| `apps/stt/tests/unit/test_session_manager_model_wiring.py` | Reaper + drain tests |
| `apps/stt/tests/unit/test_streaming.py` | Reaper-timeout config test |

Touching the `stt:audio` reader / `redis_streams.py` (TASK-457's territory) or the gateway client (`core/api_client/gateway.py`) beyond adding a retry/outbox seam → STOP and report. Anything outside the manifest → STOP.

## Requirement Analysis

Four finalize/reaper durability defects in `session_manager.py`, all instances of a pervasive "log-and-swallow, never block finalization" pattern (which is correct for cosmetic side effects but wrong for the durable transcript).

### C2-03 (High) — persist-transcript failure silently loses the transcript AND the harness trigger
`_persist_streaming_transcript` (session_manager.py:1898-1948) calls `gateway.create_transcript(...)` (:1930) inside a bare try/except that logs "non-fatal" and returns (:1942-1948). `_finalize_session` then closes + removes the session (:2091-2108) with **no re-drive**. There is **no outbox/DLQ/retry anywhere** (grep-confirmed), and the gateway `_request` has no retry/backoff. Since `TranscriptionCreated` (which triggers the harness auto-draft) fires only on a *successful* `create_transcript`, a single transient POST failure permanently loses **both** the durable transcript and the harness pipeline. The docstring's "API enforces idempotency" claim is moot — nothing re-invokes the persist.

### C2-02 (High, PLAUSIBLE) — reaper finalizes live sessions on a >60s stall; `streaming_audio_idle_timeout_s=300` is dead config
`_reaper_loop` (:2367-2374) reaps with threshold `self._session_timeout_s` = `streaming_session_timeout_s` = **60** (:2372), comparing against `last_activity` (:2392-2394) which every audio frame refreshes (`record_frame`, session.py:197). So a >60s audio stall makes an ACTIVE session eligible for reaping → finalized → post-stall audio dropped. **`streaming_audio_idle_timeout_s` (default 300) is never read anywhere** (grep-confirmed dead config). Nuances (scope honestly): the reaper only *scans* every `streaming_reaper_interval_s`=300s, so actual reap is ~60–360s after last activity; the audio-loss harm materializes only if the client reuses the session/WS after the reaper finalized it.

### C2-05 (Med) — finalize inference-drain bounded at 60s drops the tail utterance
`_drain_inference_queue` (:1392-1405) does `asyncio.wait_for(queue.join(), timeout=self._inference_drain_timeout_s)` (:1398); on `TimeoutError` it only warns and returns, leaving queued utterances un-awaited. The timeout is `streaming_inference_drain_timeout_s` — **not defined in settings.py**, so it's always the `getattr(..., 60.0)` fallback (:124-125). All four finalize paths share this drain, so a tail utterance (closing med changes) still in-queue at 60s on GPU backlog is dropped.

### C2-07 (Med) — no per-session finalize lock → duplicate Media rows + double upload
`_finalize_session` (:1950-2108) guards only with a non-atomic `if session.status == CLOSED and session_id not in self._sessions: return` (:1956) — no `asyncio.Lock`. Four unsynchronized finalize entrypoints (`end_session` :645, final-frame :1620, control-FINALIZE :1660, reaper :2412). The upload + `_register_dual_capture` + persist block (:1972-2083) runs **regardless of status**, so a concurrent second caller re-runs `gateway.create_media` twice (:1844,1859, `hash=""`, no idempotency key) → **duplicate Media rows** + double blob upload. The transcript persist is API-idempotent (protected); Media creation is not.

### Acceptance criteria

- [ ] **C2-03 (red first)**: a test makes `create_transcript` raise a transient error and asserts the current code silently loses the transcript (no re-drive, session closed). Then the fix: either (a) a durable outbox (Redis/DB) + idempotency-keyed retry worker, or (b) fail finalize LOUDLY — retain the session and surface a hard-failure to the client instead of publishing `closed`. The durable transcript + harness trigger must survive a transient gateway blip. No silent loss.
- [ ] **C2-02 (re-verify then fix)**: task 0 confirms the reaper finalizes an ACTIVE session on a >`streaming_session_timeout_s` stall. Fix: reap on the audio-idle timeout (repoint to `streaming_audio_idle_timeout_s`=300 or a clinical value) AND/OR re-adopt the session on reconnect; resolve the dead-config drift (either wire `streaming_audio_idle_timeout_s` or delete it). A live consultation with a normal speech pause must not be finalized out from under the clinician.
- [ ] **C2-05**: define `streaming_inference_drain_timeout_s` in settings.py (no more `getattr` fallback) and transcribe the flushed tail utterance inline before building the transcript (or extend/removes the bound so the last utterance isn't dropped on backlog). Test the timeout branch.
- [ ] **C2-07**: a per-session finalize lock (`asyncio.Lock`) so the four entrypoints serialize; make finalize idempotent so a second entrant is a no-op (no duplicate Media rows, no double upload). Add idempotency to `create_media` if feasible. Test concurrent finalize.
- [ ] **AC-gate**: `pnpm py:stt:test:unit` + `pnpm py:stt:lint` + `pnpm py:stt:typecheck` green; output pasted.

### Non-goals

- The consumer-groups migration for `stt:audio`/`stt:result` (C3-* → TASK-457).
- Commit-policy / VAD (TASK-451, done). SSE/gateway auth (TASK-460).
- Rewriting the whole log-and-swallow pattern for cosmetic side effects (uploads/dual-capture may stay best-effort) — only the DURABLE transcript (C2-03) must become reliable.

## Current State Evaluation (code-verified 2026-07-09 against `fix/2605-review`)

All refs current (Wave 1 didn't touch this file). Config in [settings.py:407-418](apps/stt/src/stt/core/config/settings.py): `streaming_session_timeout_s`=60, `streaming_audio_idle_timeout_s`=300 (dead), `streaming_reaper_interval_s`=300; `streaming_inference_drain_timeout_s` absent (getattr 60.0). Instance fields at [session_manager.py:113-144](apps/stt/src/stt/streaming/session_manager.py).

Key sites: persist swallow [session_manager.py:1942](apps/stt/src/stt/streaming/session_manager.py); reaper threshold :2372 + idle compare :2392; drain timeout :1398; finalize non-atomic guard :1956 + unguarded upload/register block :1972-2083; the four finalize entrypoints :645/:1620/:1660/:2412. Callback path: `_persist_streaming_transcript` → `gateway.create_transcript` → `POST /internal/stt/transcripts` ([gateway.py:256-302]). `SessionStatus` = ACTIVE/FINALIZING/CLOSED ([schemas.py:27-32]).

Test gaps: no test exercises the streaming persist-failure swallow (C2-03), the 60-vs-300 reaper config or post-stall loss (C2-02), the drain `TimeoutError` branch (C2-05), or concurrent finalize (C2-07) — every finalize test mocks `_drain_inference_queue`/`_finalize_session`.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (C2-03 is a **durable-transcript** loss — the system of record — not a cosmetic best-effort side effect; treat it differently from the uploads) · `.claude/rules/06-python-services.md`.

1. **C2-02 task 0** — reproduce the reaper finalizing an ACTIVE stalled session; record it.
2. RED→GREEN per finding in the order C2-03 → C2-07 → C2-02 → C2-05 (durability first, then the lock, then reaper, then drain). Each: failing test first (capture red), minimal fix, green.
3. If a durable outbox is chosen for C2-03, keep it on the existing Redis (no new infra) and idempotency-keyed.

### Verification gate

```bash
pnpm py:stt:test:unit
pnpm py:stt:lint && pnpm py:stt:typecheck
```

Adversarial review focus: (a) C2-03 — is there ANY remaining path where a transient gateway failure loses the durable transcript silently? does the fix avoid double-firing the harness trigger? (b) C2-07 — can two entrypoints still both reach the upload block? is finalize truly idempotent for Media? (c) C2-02 — does the reaper change risk NOT reaping genuinely dead sessions (capacity leak)? (d) C2-05 — does inline tail-transcription block finalize unboundedly? (e) zero diff outside the manifest; the `stt:audio` reader untouched (TASK-457's).

## Implementation Summary

**Branch**: `fix/task-456-stt-finalize-durability` (3 commits) — merged to `fix/2605-review` via the Wave 2 Batch 1 merge.

**What shipped**:
- **C2-07** — per-session `asyncio.Lock` + `CLOSED` idempotency guard + idempotent dual-capture so the four finalize entrypoints serialize (no duplicate `Media` rows / double upload).
- **C2-02** — reaper repointed to the (now-wired) `streaming_audio_idle_timeout_s`=300 audio-idle timeout; the dead config is resolved. Reproduced first.
- **C2-05** — `_settle_inference_loop` cancels+awaits the background loop before a single-consumer inline drain, so the tail utterance lands in the transcript.
- **C2-03 (durable transcript outbox)** — replaced the original "loud-retain" with: always finalize + release the capacity slot; on transient persist failure enqueue to a shared-Redis outbox (`stt:transcript_outbox`, idempotency-keyed); the reaper drains it **at-least-once** (soft lease → POST → HDEL only after a confirmed 2xx); permanent 4xx (excluding 429/408/425) + exhausted attempts drop loudly. `create_transcript` carries an `Idempotency-Key` (sanctioned gateway seam).

**Adversarial review (3 rounds — the hardest ticket)**: round 1 found a **Critical** — the original loud-retain leaked the capacity slot forever (escalating a gateway outage into an STT capacity DoS) and lost the transcript on the reaper path anyway. Reworked to the durable outbox (round 2 confirmed C-1 closed + the lock/reaper sound). Round 2 found two Important gaps — 429-under-burst dropped as "permanent", and an at-most-once crash window — both fixed (429/408/425 transient; delete-after-ack lease). Orchestrator spot-verified the final lease state machine.

**Gates**: `pnpm py:stt:test:unit` **2100 passed**; ruff + mypy clean. RED→GREEN for capacity-release, 429-transient, crash-window-survives, redrive-order, drain-tail, reaper-config.

**Discovered → follow-ups**: server-side transcript dedup is check-then-act (a DB unique constraint on (consultation, transcript) would make no-double-fire non-racy — TASK-466 territory); outbox `HGETALL` + serial redrive is a throughput note under large backlogs (not correctness). Prometheus counters were left as loud structlog events (metrics.py out of manifest).

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C2-02/03/05/07; all four re-verified against the post-Wave-1 tree by read-only scout (refs unchanged; `streaming_audio_idle_timeout_s` confirmed dead config; C2-07 duplicate risk scoped to Media rows). No implementation. |
| 2026-07-11 | **Closed (Status -> Completed).** Closure-review pass (owner directive "close if finished completely and properly"): all four findings shipped + tested RED->GREEN, 3-round review with the Critical rework + both Important fixes applied (none deferred), py:stt:test:unit 2100 passed / ruff+mypy clean; residuals are out-of-manifest metrics + a non-AC dedup hardening (no AC pending). No external work remains -- only the owner's git push/PR to main. |
