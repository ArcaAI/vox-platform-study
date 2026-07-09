# TASK-457 — Redis Consumer-Groups Migration for the Realtime Dataplane (C3-01/02/03/05/06)

- **Status**: Pending (Wave 2 scaffold — no implementation) · **GATED on [TASK-455](../TASK-455-Streaming-E2E-Eval-Harness/README.md)**
- **Type**: infrastructure / bugfix (realtime durability — the seam cluster)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 (P1) · **critical path**
- **Findings**: C3-01 (High) · C3-02 (High) · C3-03 (Med) · C3-05 (Med) · C3-06 (Low) — all CONFIRMED — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md). This one change closes the whole seam cluster (S1-DELIVERY).
- **Branch (when scheduled)**: `fix/task-457-redis-consumer-groups` (from the Wave-1 landing on `fix/2605-review`)
- **Size**: L (largest Wave 2 item; the program's critical path)
- **Suggested agent**: general-purpose (TS + Python + Redis), high effort

## 🚦 Hard gates & coordination (read first)

1. **Gated on TASK-455.** Do NOT start until the streaming e2e + latency/loss eval harness exists. This change touches the hot audio path; TASK-448's risk register requires it be measured, not asserted. The existing latency harness enforces **final-lag p95 ≤ 800 ms** (`test_streaming_latency_harness.py:64,672,697`) — the migration must show no regression against that SLA AND zero loss under the kill/reconnect scenarios (resume-after-drop, backpressure recovery, ticket-refresh) that TASK-455 adds.
2. **The latency harness itself uses plain `XREAD` on `stt:result`** (`test_streaming_latency_harness.py:585`) and inlines `MAXLEN ~10000` — it must be migrated in lockstep OR the `stt:result` consumption kept backward-compatible.
3. **Shared files → ordering** (per the [conflict ledger](../TASK-449-Harness-Loop-Remediation-Program/README.md#cross-stream-conflict-ledger-wave-1--wave-2)): `stt-ws.gateway.ts` was modified by TASK-450 (landed; +26 lines). `session_manager.py` is **TASK-456's** file — **TASK-456 merges first**, then this ticket's Python half rebases onto it (different regions: 456 = finalize/reaper; 457 = the `stt:audio` reader wiring).
4. **This migration is test-breaking by design.** `streamingAudioBridge.service.test.ts:785-789` asserts the `0-0` re-read that is the bug — it must be rewritten, not preserved.

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/stt-v2/src/stt_v2/streaming/redis_streams.py` | `stt:audio` consumer → `XREADGROUP`+`XACK`+`XAUTOCLAIM`; `stt:result` `XADD` gains `MAXLEN` (C3-05); reconcile the audio bound (C3-06) |
| `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` | `stt:result` reader → consumer group; seed from a persisted cursor, not `0-0` (C3-01); single MAXLEN source (C3-06) |
| `apps/api/src/modules/streaming/stt-ws.gateway.ts` | Key resume state by `sessionId` with a grace window; don't finalize on transient disconnect; client seq dedup + gap markers (C3-01/C3-03) |
| `packages/applications/src/services/stt/streaming/streamingSession.service.ts` | Don't `removeSession`/`DELETE`-finalize on a transient disconnect (grace window) |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | ONLY the `stt:audio` reader wiring + consumer-group create/cursor (coordinate with TASK-456) |
| tests: `streamingAudioBridge.service.test.ts`, `stt-ws.gateway.test.ts`, `apps/stt-v2/tests/unit/test_streaming.py`, `apps/stt-v2/tests/integration/test_streaming_latency_harness.py` | Rewrite the `0-0` / plain-XREAD pins; add group/ack/claim + resume tests |

Anything outside → STOP and report (especially TASK-456's finalize/reaper regions in `session_manager.py`).

## Requirement Analysis

The end-to-end realtime chain is **exactly-once nowhere** — the root cause is one decision: plain `XREAD` with no consumer groups (grep-confirmed: **zero** `xreadgroup|xgroup|xack|xpending|xclaim|xautoclaim` anywhere in stt-v2/api/applications source). The single fix — convert the `stt:audio` and `stt:result` readers to consumer groups (`XREADGROUP` + `XACK` + `XAUTOCLAIM` on the same Redis) — gives at-least-once + crash recovery + a natural single-owner mechanism, and closes C3-01/02/03/05.

### C3-01 (High) — resume/replay architecturally defeated
`streamingAudioBridge.service.ts` `readResultStream` re-initializes `lastId='0-0'` per call ([:313]) and `xread(... '0-0')` ([:319]); a fresh reader connection is created per subscription with nothing persisted. On the gateway, every `handleConnection` builds a fresh `SessionInfo` with `binarySeq:0/resultSeq:0/resumeBuffer:[]` ([stt-ws.gateway.ts:298-311]) — resume state is per-socket memory. And `handleDisconnect` ([:495-528]) calls `removeSession` → `DELETE /internal/streaming/sessions/{id}` → `end_session` → the upstream **finalizes** and publishes `status:closed` onto `stt:result`. So a reconnect re-reads `stt:result` from `0-0` (duplicate flood), re-tags with seq 1,2,3…, then hits the persisted `closed` entry and completes — **duplicate-then-silent**.

### C3-02 (High) — fire-and-forget audio, no consumer groups
`forwardAudioFrame` ([stt-ws.gateway.ts:607-619]) writes without awaiting the ack; the only failure surface is a generic `BRIDGE_ERROR` + a counter. The bridge writer uses `maxRetriesPerRequest:3` ([streamingAudioBridge.service.ts:92]), so a Redis blip drops clinical speech. Both sides use plain `XREAD` (bridge [:319]; STT-v2 audio consumer [redis_streams.py:143-147]). **Register refinement**: "no audio-direction resume" is **gateway/bridge-scoped** — the STT-v2 consumer already resumes via `last_stream_id` ([session_manager.py:2300]) for crash-recovery; the gap is the API-gateway reconnect path and the absence of a PEL/`XCLAIM` for in-flight hand-off.

### C3-03 (Med) — 200-final egress queue drops the oldest; the mitigation comment is FALSE
`enqueueFinalResult` ([stt-ws.gateway.ts:420-438]) evicts the oldest final past `WS_EGRESS_FINAL_QUEUE_LIMIT=200`. The comment claims "the resume buffer still holds it" — **false**: `tagAndBuffer` ([:393], bounded 200) runs microseconds before `enqueueFinalResult` ([:396]) and evicts the same final from the resume buffer in lockstep, so at the instant the queue drops it the resume buffer no longer holds it. `handleResume` ([:633-697]) is the only replay source → an overflowed final is unrecoverable.

### C3-05 (Med) — `stt:result` unbounded during a session
`ResultPublisher.publish/publish_error/publish_status` ([redis_streams.py:220,225-226,239-252]) `XADD` with **no MAXLEN**; the bridge reads all from `0-0`; only a post-close `EXPIRE` (3600s, [session.py:450], `streaming_result_stream_expire_s`) exists. Memory growth + O(n) re-read amplifies C3-01.

### C3-06 (Low) — divergent audio bounds
Bridge `XADD ... MAXLEN ~ 10000` ([streamingAudioBridge.service.ts:166-170]) vs STT config `streaming_audio_stream_maxlen=2000` ([settings.py:427-433]). **Register refinement**: only 10000 is LIVE (the TS bridge is the sole prod writer of `stt:audio`); the 2000 default feeds `xadd_audio_frame` which is **prod-unused** (only a test caller). So it's one live bound + one dead default — reconcile to a single source of truth (and delete or wire the dead one).

### Acceptance criteria

- [ ] **AC-1 (gated)**: TASK-455's eval harness is green FIRST and provides the baseline. This ticket's exit requires: no final-lag p95 regression vs baseline (≤800 ms SLA held) AND zero transcript loss under the resume-after-drop, backpressure-recovery, and ticket-refresh scenarios.
- [ ] **AC-2 (C3-01/C3-02)**: `stt:audio` and `stt:result` readers use consumer groups (`XREADGROUP` + `XACK`, `XAUTOCLAIM` for dead-consumer hand-off). The bridge result reader seeds from a **persisted cursor**, not `0-0`. Resume state is keyed by `sessionId` (not per-socket); a transient disconnect does NOT finalize the upstream — a grace window lets the same session reconnect and continue. Client-side seq dedup + explicit gap markers.
- [ ] **AC-3 (C3-02 durability)**: an audio-write failure is retried/at-least-once (not a single fire-and-forget with 3 retries then drop); a Redis blip no longer silently drops clinical speech.
- [ ] **AC-4 (C3-03)**: overflowed finals are recoverable (raise/decouple the bound, or persist to the durable path) — the resume buffer and egress queue no longer evict in lockstep such that a final is lost by both. Fix the false comment.
- [ ] **AC-5 (C3-05)**: `stt:result` `XADD` carries a `MAXLEN` bound during the active session.
- [ ] **AC-6 (C3-06)**: a single source of truth for the audio-stream bound; the dead 2000 default is wired or removed; tests updated.
- [ ] **AC-7 (tests)**: the `0-0` pin ([bridge test:785-789]) and plain-XREAD assertions are rewritten; new tests cover group create/ack/claim, reconnect-resume (no duplicate flood, no premature close), and dead-consumer hand-off. `pnpm py:stt-v2:test` + the bridge/gateway suites + the latency harness green.

### Non-goals

- Replacing Redis with NATS JetStream/Kafka (TASK-448: consumer groups on the same Redis is the S-effort minimal upgrade; the others are overkill for ephemeral audio).
- STT finalize/reaper durability (TASK-456) — coordinate, don't overlap.
- Streaming-native ASR / diarization / semantic endpointing (SOTA track).

## Current State Evaluation (code-verified 2026-07-09 against `fix/2605-review`, HEAD `f1efc415`)

Key scheme ([redis_streams.py:38-60]): `stt:audio:{sid}` (bridge XADD MAXLEN~10000 → STT-v2 plain XREAD), `stt:result:{sid}` (STT-v2 XADD no-MAXLEN → bridge plain XREAD from 0-0), `stt:control:{sid}`, `stt:session:{sid}` (hash incl. `last_stream_id`), `stt:worker:{id}`. Sites: bridge 0-0 [:313,319], writer opts [:88-102], audio XADD [:166-186]; gateway resume/seq [:298-311], forwardAudioFrame [:607-619], enqueueFinalResult [:420-438], relayResult/tagAndBuffer [:378-403], handleDisconnect→removeSession [:495-528]; STT-v2 audio consumer [redis_streams.py:137-197], ResultPublisher [:220-252], reader wiring [session_manager.py:562-567 create / :2300-2310 recovery]; audio-bound configs [settings.py:427-441]; result TTL [session.py:439-453].

Test-breaking pins to rewrite: bridge `0-0` [:785-789] + lastId [:794-834] + close→complete [:721-760]; `test_streaming.py` `TestResultPublisher` (no MAXLEN) [:926], `TestXaddAudioFrame` (2000) [:1019-1044], settings 2000 [:1263]; gateway resume/egress [:849-1060]. Latency harness [test_streaming_latency_harness.py] plain XREAD [:585] + MAXLEN 10000 [:533-554].

## Implementation Plan (TDD — strict order; gated on TASK-455)

> Context pack: this README · TASK-449 §Architecture preamble (the **realtime loop** hot path — measure everything) · `.claude/rules/05-nestjs-api.md`, `.claude/rules/06-python-services.md` · TASK-455's baseline report.

1. Confirm TASK-455's harness + baseline exist (AC-1). Do not proceed otherwise.
2. Python side: `stt:audio` XREADGROUP + XACK + XAUTOCLAIM + result MAXLEN (rebased on TASK-456). Rewrite `test_streaming.py` pins RED→GREEN.
3. TS side: bridge result reader → group + persisted cursor; gateway grace-window resume keyed by sessionId + seq dedup/gap markers; streamingSession no-finalize-on-transient-disconnect. Rewrite bridge/gateway pins RED→GREEN.
4. Migrate the latency harness in lockstep; run it — prove p95 ≤ 800 ms + zero loss under TASK-455's kill/reconnect scenarios.

### Verification gate

```bash
pnpm py:stt-v2:test && pnpm py:stt-v2:lint && pnpm py:stt-v2:typecheck
pnpm --filter @arcaai/applications test   # bridge
pnpm --filter @arcaai/api test            # gateway
# then, against a live stack (TASK-455): the streaming e2e + latency/loss harness — p95 ≤ 800ms, zero loss
```

Adversarial review focus: (a) is delivery now at-least-once end-to-end, with dedup so at-least-once doesn't double-write the durable transcript? (b) does the grace window correctly distinguish a transient disconnect from a real session end (no leaked sessions, no zombie groups)? (c) does `XAUTOCLAIM` hand off in-flight audio on a dead consumer without reordering? (d) measured p95 vs baseline — any regression? (e) zero diff into TASK-456's finalize/reaper regions.

## Implementation Summary

_Pending — not yet implemented (Wave 2). Gated on TASK-455._

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C3-01/02/03/05/06; all re-verified against the post-Wave-1 tree by read-only scout (gateway refs shifted +26 from TASK-450). Register refined: audio resume is bridge-scoped (STT-v2 consumer already resumes); the "resume buffer holds it" comment is provably false; the 2000 audio bound is dead config. Confirmed zero consumer-group primitives exist. No implementation. |
