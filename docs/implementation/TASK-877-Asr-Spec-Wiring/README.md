# TASK-877 — Wire the dropped `ResolvedAsrSpec` fields; remove the platform duplicates

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor / feature |
| **Program** | TASK-870 Configuration Governance, wave 2 lane B |
| **Branch** | `task-877-asr-spec-wiring` (worktree `hope-v2-task-877`) |
| **Base** | `030df76b5` off `dev-2.2` |
| **Merge target** | `dev-2.2` — merged by the orchestrator, not by this lane |

## Requirement Analysis

The owner's model (TASK-870 §Requirement Analysis, points 6 and 7): **the agent owns
per-session ASR behaviour**; an admin overwrites it by injected context or hard-coded node
values, never by a platform setting. A platform key that duplicates an agent concept is old
architecture and is **removed completely, not dual-homed**. Owner decision #9 widens the
`decoding` block with batch chunking for accuracy/performance.

Against that model, `ResolvedAsrSpec` today declares fields the runtime silently drops, and
the platform keys that used to carry those concepts are still the only thing in force:

| Spec field | Declared at | What actually happens |
|---|---|---|
| `streaming.endpointing` | `pipeline/spec.py:165-167` | never read — an agent asking for `"semantic"` gets fixed endpointing |
| `streaming.maxUtteranceSec` | same | never read, and no platform key behind it either — silently ignored |
| `streaming.partialIntervalMs` | same | never read — `stt.streaming.partialIntervalS` decides for every session |
| `decoding.vadFilter` | `pipeline/spec.py:150` | never read — `streaming/faster_whisper_asr.py:246` hardcodes `False` |

`pipeline_spec_from_resolved` (`pipeline/spec.py:300-372`) builds `StreamingConfig` from
`post_processing.stabilizer` alone (`:362`) and never touches `core.streaming`.
`_resolve_endpoint_config` (`streaming/session_manager.py:764-785`) looks for
`preprocessing.endpoint`, which the mapper never sets, so the entire `stt.semanticEndpoint.*`
family is the only reachable control.

## Current State Evaluation (verified at `030df76b5`)

- `AsrSpecStreaming` is `extra='forbid'`, so a new wire field must exist on the Python side
  BEFORE the gateway can send it. New fields are therefore declared **optional and omitted
  when unset** on both halves, which makes them safe in either merge order (TASK-876 adds the
  agent-schema names; this lane consumes them).
- `ASR_SPEC_MODEL_ROLES` (`packages/types/src/asr-spec.ts:30`) has no end-of-utterance role, so
  `stt.semanticEndpoint.modelId` is a free string with no registry row behind it.
- `execution_profile.py:377-387` still branches on `streaming_batch_wait_ms`,
  `streaming_embedding_device` and `streaming_multi_gpu_strategy` — TASK-872 removed the three
  descriptors, so those `Settings` fields can now only hold their code default. Dead.
- `_PARTIAL_INTERVAL_S = 0.4` (`streaming/preprocessor.py:70`) equals the descriptor default
  for `stt.streaming.partialIntervalS`, so dropping the settings read is behaviour-neutral.

## Implementation Plan

1. **Wire the spec.** New optional wire fields (`decoding.chunkLengthSec`,
   `decoding.strideLengthSec`, `streaming.semantic{…}`, `models.endpointing`) on both halves;
   `pipeline_spec_from_resolved` maps every previously-dropped field onto the runtime
   dataclasses; `build-resolved-asr-spec.ts` maps the matching agent `parameters`; the parity
   fixture grows a case that exercises them.
2. **Delete the eight platform duplicates** — `stt.streaming.partialIntervalS` and the six
   `stt.semanticEndpoint.*` — from the descriptors, `control_plane.py`, `Settings`, and the
   `session_manager` reads.
3. **Delete the dead override branches** at `execution_profile.py:377-387` and the three
   orphaned `Settings` fields.
4. (budget) Punctuation: lazy per-spec load; delete `stt.punctuation.{enabled,modelName}`.
5. (budget) Diarization: honour `spec.models.embedding`; delete `stt.diarization.hfModelId`.

TDD order per deliverable: failing test → implement → gates.

## Implementation Summary

_(filled in as the lane lands)_

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded against the verified base state. |
