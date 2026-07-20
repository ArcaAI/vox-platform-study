# TASK-457 — Redis Consumer-Groups Migration for the Realtime Dataplane (C3-01/02/03/05/06)

- **Status**: **Completed** — merged to `fix/2605-review` @ `b2645dc6` (`--no-ff`); live resume e2e GREEN + unit/build/lint gates green. Prerequisite [TASK-455](../TASK-455-Streaming-E2E-Eval-Harness/README.md) landed; the folded-in WS-control fix is preserved as [TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md) @ `45b3ae08`.
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

Implemented on `fix/task-457-redis-consumer-groups` (from `fix/2605-review` @ `90bb993d`). Unit + Redis-level gates green; the live-stack e2e/latency validation is owned by the orchestrator.

### Consumer-groups migration (C3-01/02/03/05/06)

- **Audio reader → consumer group** (`apps/stt-v2/src/stt_v2/streaming/redis_streams.py`). `IngestionConsumer` now `XGROUP CREATE`s a per-session group (`AUDIO_CONSUMER_GROUP = "stt-ingest"`, MKSTREAM, swallow BUSYGROUP), reads via `XREADGROUP ">"`, `XACK`s each processed entry (at-least-once), and reclaims a dead consumer's in-flight via `XAUTOCLAIM` (first pass `min-idle=0` recovers own PEL; then throttled at `min-idle=30s`). `session_manager.py` passes `consumer_name=self._worker_id` at both the create and recovery wirings ONLY (TASK-456's finalize/reaper regions untouched).
- **Result reader → consumer group** (`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`). `subscribeToResults(sessionId, {consumerGroup?})` reads via `XREADGROUP` (+ own-PEL drain `0` → live `>`), `XACK`s, and `XAUTOCLAIM`s a dead reader's pending. The **persisted cursor** is the group's Redis-owned last-delivered-id — a re-subscription with the same group resumes there, never `0-0` (C3-01). Fan-out preserved: the captions gateway passes a stable group (`captions`); LiveDocumentationService keeps a per-subscription unique group, so both still receive every result. Added a macrotask yield on empty reads so an idle loop never starves the event loop.
- **At-least-once audio write** (C3-02): the bridge writer moved from `maxRetriesPerRequest: 3` (drop-after-3) to `null` — a transient Redis blip queues the `XADD` on ioredis's FIFO offline queue and flushes in order on reconnect (order-preserving), instead of dropping clinical speech. Primary at-least-once is the STT-v2 audio group's PEL/`XAUTOCLAIM`.
- **`stt:result` MAXLEN during the session** (C3-05): `ResultPublisher.publish/publish_error/publish_status` now `XADD ... MAXLEN ~ streaming_result_stream_maxlen` (new setting, default 10000).
- **Single audio bound** (C3-06): the bridge exports `AUDIO_STREAM_MAXLEN = 10000` (sole prod writer of `stt:audio`); `streaming_audio_stream_maxlen` reconciled `2000 → 10000` to match; the dead `xadd_audio_frame` default documented as test-only.
- **Grace-window resume keyed by sessionId** (`stt-ws.gateway.ts`): resume state moved to a `sessionsById` map; a transient disconnect no longer `removeSession`/unsubscribes — it arms a grace timer (`WS_RESUME_GRACE_MS`, default 15s) and keeps the session + subscription + upstream alive. A reconnect (same sessionId) rebinds to the new socket (`session.client`), cancels the timer, and continues; only grace expiry (or explicit `close`) finalizes. `handleResume` now always acks continuation from `fromSeq = lastSeq + 1` and replays only `seq > lastSeq` (no duplicate flood).
- **C3-03 overflowed finals**: fixed the false "resume buffer still holds it" comment (it evicts in lockstep) and emit an explicit **gap marker** (`{type:'gap', reason:'egress_overflow', droppedSeq}`) so a dropped final is never silent — recoverable from the durable transcript.

### Folded-in prerequisite — dead WS control channel (found by TASK-455's live e2e)

`stt-ws.gateway.ts` registered `on('message', (data) => …)` ignoring ws's `isBinary` arg and split audio-vs-JSON on `Buffer.isBuffer`. ws@8 delivers TEXT frames as a Buffer with `isBinary=false`, so `{type:'resume'|'stop'|'close'}` control frames were misclassified as audio and resume was unanswerable. **Fixed**: `on('message', (data, isBinary) => handleMessage(client, data, isBinary))`; `handleMessage` routes `isBinary===true → audio`, else decode Buffer→string → JSON. Consumer-groups resume depends on this.

### Test-breaking pins rewritten (RED→GREEN)

- `test_streaming.py`: `TestIngestionConsumer` (plain-XREAD → XREADGROUP/XACK/XAUTOCLAIM + group-create + dead-consumer reclaim), `TestResultPublisher` (assert MAXLEN), `TestXaddAudioFrame` (2000 → reconciled 10000 default), settings pin (`== 2000` → `== 10000` + new `streaming_result_stream_maxlen`), `TestSessionManager` fixture (group mocks). Lockstep migrations of the same component: `test_stream_hygiene.py` (`TestIngestionConsumerOnBatch`) and `test_streaming_integration.py` fixture.
- `streamingAudioBridge.service.test.ts`: the `0-0` pin ([:785-789]) rewritten to assert group-create + XREADGROUP-from-`0` and NO `0-0` re-read; the lastId pin rewritten to assert the group cursor advances via `>` + `XACK`; added dead-consumer `XAUTOCLAIM` + stable-group-resume tests.
- `stt-ws.gateway.test.ts`: `handleDisconnect` rewritten for the grace window (fake timers: no finalize on transient disconnect; finalize + removal-retry only at grace expiry; reconnect cancels finalize); binary `handleMessage` calls pass `isBinary=true`; added the WS-control-over-Buffer-text-frame tests and the reconnect-after-drop resume target (`fromSeq === lastSeq+1`, no duplicates, no freeze); egress-overflow test asserts the gap marker.

### Verification (unit + Redis-level; live e2e owned by orchestrator)

| Gate | Result |
|---|---|
| `pnpm py:stt-v2:test` (full unit) | **2104 passed** |
| `py:stt-v2:lint` (ruff) / `py:stt-v2:typecheck` (mypy) | ruff **All checks passed**; mypy **no issues in 103 files** |
| `@arcaai/applications` bridge + streaming + live-doc | **119 passed** (bridge 58) |
| `apps/api` gateway + streaming module | gateway **57 passed**, streaming module **198 passed** |
| `apps/api` build (nest build = tsc) | **pass** |
| `apps/api` lint (hard errors) / `applications` lint | apps/api **0 errors**; my applications files **0 warnings** (rest pre-existing only-warn) |
| Latency + loss harness consumption | plain-XREAD on `stt:result` kept backward-compatible (publisher MAXLEN + a SEPARATE bridge group read); audio `_AUDIO_STREAM_MAXLEN=10000` matches the reconciled bound → **no migration needed**; both collect cleanly (4 tests) |

New env var `STT_WS_RESUME_GRACE_MS` added to `turbo.json#globalEnv` (matches the `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` turbo.json-only precedent).

**Orchestrator live validation (2026-07-10) — DONE, GREEN**: restarted STT-v2 (offline HF cache) + API from this branch and re-ran the TASK-455 resume e2e against the live stack. `task-455-streaming-resume-after-drop.spec.ts` TARGET is now a real passing test (**2 passed, 1.3m**): resume `fromSeq = lastSeq + 1` (2, from lastSeq 1), the `{type:'ready'}` ack arrives before resume (`noSessionErrorOnResume:false`), and `c3_01_duplicate_flood:false` / `c3_01_silent_freeze:false` / `finding_control_frames_ignored:false`. The loss/latency baseline (gap_count 0, coverage 0.996, no transport regression vs the plain-XREAD baseline) was captured in the earlier pre-hardening live run; the hardening did not touch the latency path.

### Adversarial-review remediation — multi-replica / k3s (post-live-validation)

Live validation passed (resume works, consumer groups active, durable transcript double-write-safe). The review then found issues that only manifest on the multi-replica topology — all in the EPHEMERAL caption/operational layer (durable transcript unaffected):

- **C1 (CRITICAL) — cross-instance caption split, FIXED.** The stable `captions` group is shared across API instances; the old grace window kept the disconnected instance's reader draining+ACKing it for 15s, so a reconnect to another instance made Redis load-balance new results between the dead reader and the live one (~half the live captions silently lost per cross-instance reconnect). Fix: on a transient disconnect the gateway now unsubscribes ONLY its own captions reader (not the session-wide `unsubscribeFromResults`, which would also kill LiveDoc), and the bridge `abortSubscriber` immediately `disconnect()`s that reader's connection (interrupting the in-flight blocking read) so it stops consuming/ACKing the shared group AT ONCE — not after the ≤500 ms BLOCK. A reconnect (any instance) re-establishes the reader (`rebindSession` → `subscribeSessionResults`), resuming from the group's persisted cursor. The upstream STT-v2 session stays alive across the window. Same-instance resume unchanged (proven e2e stays green).
- **I1 (Important) — connection-registration race, FIXED.** `handleConnection` registers the session AFTER async auth/lookup awaits; a client resuming/sending immediately raced it into `NO_SESSION` → silent freeze (the exact C3-01 failure), papered over by a test `sleep(600)`. Fix: the gateway now emits an explicit `{type:'ready', sessionId, fromSeq}` ack after registration/rebind; `task-455-streaming-resume-after-drop.spec.ts` waits for that ack instead of sleeping (deterministic gate; baseline keeps a short fallback for pre-ack servers). The SDK should adopt gating its first resume/audio on `ready` (client not in this ticket's manifest).
- **I3 (Important) — shutdown orphaned upstream sessions, FIXED.** `onModuleDestroy` is now async and best-effort FINALIZEs every live + in-grace session (unsubscribe + `removeSession`) with a bounded 5 s await, so a SIGTERM/rolling deploy no longer strands STT-v2 sessions/capacity until the reaper.
- **M1 (minor) — FIXED.** `reclaimResultPending` docstring corrected: the result reader recovers its OWN pending via the initial `0` (PEL) read; XAUTOCLAIM (min-idle 30 s) is dead-reader handoff only (no idle-0 own-PEL claim on the result path).
- **M3 (minor) — mitigated (logged).** With the writer's `maxRetriesPerRequest: null`, a Redis outage silently offline-queues audio (droppedAudioFrames stays 0). Added throttled writer `error`/`reconnecting`/`ready` logging so an outage is visible (degraded duration surfaced). Not hard-bounded — see deferred note below.
- **I2 (Important) — DEFERRED (durable-safe, ephemeral).** The gateway seq is per-`SessionInfo`, in-memory: a fresh `SessionInfo` (process restart, or grace-expiry + new connect, or a cross-instance reconnect where `sessionsById` is per-instance) resets seq to 0 and re-drains the group PEL with fresh seqs → duplicate/regressed captions the client can't reconcile by seq (`resumed fromSeq:51` then live from 1). C1's fix keeps the stable shared group (Redis-owned cursor, no loss), so I2 is a client-reconciliation defect, not loss — and it's entangled with a NON-manifest file (`StreamSessionTenantBindingService`, the only Redis-session-meta writer). **Precise follow-up**: persist the seq high-water (and the Redis last-delivered-id ↔ seq mapping) into the `stt:session:{sid}` meta so a fresh `SessionInfo` CONTINUES seq from it (never resets), and forward the Redis entry id on each `StreamingTranscriptMessage` so the client dedups replays against a stable id rather than the resettable seq. Touch points: `StreamSessionTenantBindingService` (new `resultSeqHighWater` read/write), `stt-ws.gateway.ts` (seed `resultSeq` on connect; persist on final), `streamingAudioBridge.service.ts` (thread the entry id onto the DTO). Ephemeral caption layer only; durable transcript unaffected.
- **M2/M4/M5**: details not provided in the review hand-off — not addressed; flagging for the reviewer to specify if wanted.

Hardening gates (all green): applications bridge **59**, apps/api gateway **61**, applications streaming+live-doc **120**, apps/api streaming module **202**; apps/api build (nest/tsc) + lint clean; my applications files 0 lint warnings. Python untouched this round.

**Residual (noted)**: C1's reader-disconnect is immediate, but a result already read into the dead reader's in-flight batch just before `disconnect()` is ACKed-then-not-relayed (bounded to one in-flight read, durable-safe). The primary 15 s / ~half-caption loss is eliminated. Live multi-replica validation (cross-instance reconnect on k3s) is the orchestrator's to confirm.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C3-01/02/03/05/06; all re-verified against the post-Wave-1 tree by read-only scout (gateway refs shifted +26 from TASK-450). Register refined: audio resume is bridge-scoped (STT-v2 consumer already resumes); the "resume buffer holds it" comment is provably false; the 2000 audio bound is dead config. Confirmed zero consumer-group primitives exist. No implementation. |
| 2026-07-10 | Implemented C3-01/02/03/05/06 + the folded-in WS-control (isBinary) fix on `fix/task-457-redis-consumer-groups`. Audio + result readers → consumer groups (XREADGROUP/XACK/XAUTOCLAIM); bridge result reader seeds from the group cursor (not 0-0); at-least-once audio write; `stt:result` MAXLEN; single audio bound (10000); gateway grace-window resume keyed by sessionId with rebind + `fromSeq=lastSeq+1`; C3-03 gap marker + fixed comment. Rewrote the test-breaking pins RED→GREEN (+ lockstep `test_stream_hygiene`/`test_streaming_integration`). Gates: py 2104 unit / ruff / mypy green; applications bridge+streaming+live-doc 119; apps/api gateway 57 + streaming 198 + build + lint green; harnesses kept backward-compatible (no migration). Live e2e/latency validation left to the orchestrator. |
| 2026-07-10 | Post-live-validation adversarial-review remediation (multi-replica/k3s). **C1 (Critical)**: eliminated the cross-instance caption split — transient disconnect drops only the gateway's own captions reader and the bridge `disconnect()`s it immediately (stops draining/ACKing the shared group at once); reconnect re-establishes from the group cursor. **I1**: explicit `{type:'ready'}` ack after registration/rebind; e2e waits for it instead of `sleep(600)`. **I3**: async `onModuleDestroy` finalizes live + in-grace sessions (bounded 5s) so deploys don't orphan upstream sessions. **M1**: fixed reclaim docstring. **M3**: throttled writer-degraded logging (offline-queue visibility). **I2 DEFERRED** (durable-safe seq-continuity/dedup; entangled with the non-manifest session-meta writer — precise follow-up recorded above). Gates: bridge 59, gateway 61, applications streaming+live-doc 120, api streaming 202, api build+lint clean. Live multi-replica validation left to the orchestrator. |
| 2026-07-10 | **Live-validated + merged to `fix/2605-review` (`b2645dc6`, `--no-ff`) — Wave 2 complete.** Orchestrator restarted STT-v2/API from the branch and re-ran the hardened resume e2e live: TARGET green (2 passed) — resume `fromSeq=lastSeq+1`, `ready` ack confirmed, no duplicate flood, no silent freeze, control channel live. The folded-in WS-control (`isBinary`) fix — which also existed as uncommitted WIP on `fix/2605-review` — was extracted and preserved as **[TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md)** (`45b3ae08`) ahead of the merge; 457's superset version won the merge on `stt-ws.gateway.ts` + `stt-ws.gateway.test.ts` + the resume spec. Cross-instance C1 validated by code reasoning (a single stack can't split across replicas); I2 (seq-continuity/dedup) is the one deferred follow-up. |
