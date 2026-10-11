# BUG-406: Transcript Returned Under The Wrong chunk_id (Agentic SDK)

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix / contract clarification (likely obsolete as filed) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/406 (ArcaAI/ALaaSv3.0) |
| **Severity** | Medium (UI timing alignment; text is not lost) |
| **Classification** | Obsolete concept in HOPE (no `chunk_id` exists); replaced by session-time and metadata echo. Residual: confirm the ALaaS broker aligns by the supported fields. |
| **Still applicable on dev-2.2?** | No as filed. The v1 per-chunk request/response protocol the issue describes is gone from this repo. An equivalent misalignment is only possible on the ALaaS side. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

When audio segments are sent with a caller-assigned `chunk_id` (`Chunk_001`, `Chunk_002`, ...), the transcript for speech in `Chunk_005` comes back labelled `Chunk_006` (the next, silent chunk) while `Chunk_005` stays empty. Local logs show buffers aligned with their ids before sending. Reporter suspects a race or off-by-one mapping the ASR output to the caller's id; impact: text cannot be aligned with UI timestamps. (Screen recording in the issue.)

## 2. Current State Evaluation

- No `chunkId` / `chunk_id` field exists in the current SDKs or gateway. Search over `packages/agentic-sdk-v2/src`, `packages/vox-node/src`, `packages/stt/src`, `apps/stt/src`, `apps/api/src` finds only knowledge-chunk ids (citations) and the batch decoder's internal `chunk_index`. The `[SEND_AUDIO] chunkId=mic16_chunk36_...` line quoted in sibling issue #369 is the old ALaaS client's own bookkeeping.
- Streaming is continuous PCM over `/ws/stt/stream`, not request/response chunks. HOPE segments by VAD/endpointing into utterances; one decoded utterance can legitimately finish after the chunk that contained its speech ended (partials revise; finals come on endpoint). A transcript arriving "with the next chunk" is the expected timing of an endpointer, not a mapping bug, unless alignment is done by arrival order instead of by timestamps.
- Supported alignment is explicit: every `transcript` frame carries session-relative `startTime`/`endTime`, a monotonic `seq`, `utteranceIndex`, and the declared metadata in force over that audio, with time-synced `metadataSpans` (TASK-951) (`packages/vox-node/src/types/stt.ts:253-300`; `setMetadata` before a stretch of audio, STICKY until changed; the echoed `metadata` is the value in force over the larger share of the segment). That is the sanctioned replacement for per-chunk ids: a client sets `{chunkId}` in metadata and reads it back with exact spans.
- Related, already fixed: segments reordered/duplicated across reconnects (TASK-1003 reconnect storm, resume handshake `lastSeq`), and stale/other-session bleed (TASK-935).
- The v1 compat plane that had chunk semantics (`api/stt/*`, `SttCompatController/Gateway`) was removed by TASK-1004 (`docs/implementation/TASK-1004-Language-Selection-End-To-End-And-Compat-Removal/`).

## 3. Root Cause

As filed: in the retired v1 SDK chunk protocol (not in this repo). If the same symptom appears on the current stack, the cause is aligning by arrival order instead of by `startTime/endTime` or `metadataSpans`.

## 4. Implementation Plan

No HOPE code change unless the follow-up check finds a defect.

1. **Check (read-only):** confirm with the ALaaS repo (`refactor-hope-integaration`, `apps/audio-stream-svc`) how it maps transcripts to its own chunks: by `metadata` echo / spans (correct) or by order (incorrect).
2. **Add a regression test only if gaps exist (STT side):** `apps/stt/tests/` - synthetic stream with `setMetadata` switching at a known boundary mid-utterance; assert `metadata` equals the larger share and `metadataSpans` sum to the segment (existing TASK-951 tests likely cover it; extend only if the mid-utterance tie case is not covered).
3. **Documentation:** add a short "aligning transcripts to your chunks" note to the SDK integration doc: use `setMetadata` + `metadataSpans`, never arrival order.
4. Close as obsolete in this repo once ALaaS confirms.

## 5. Risks and Open Questions

- OQ-1: is ALaaS still running the v1 SDK with chunk ids in some deployment? If yes, that is a version-pinning issue (upgrade), not a HOPE fix.
- OQ-2: the video shows UI vs logs; unclear whether the UI uses `startTime` or arrival order.
- Risk: none for HOPE; do not reintroduce a chunk-id concept into the SDK (owner rule: no v1 compat shims).

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #406 (read-and-document lane); no code changed. |
