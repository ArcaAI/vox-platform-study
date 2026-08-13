# TASK-591 — Compat transcript timestamp fix (streaming stream-relative offset)

- **Status:** Review
- **Type:** bugfix
- **Surfaces:** `@arcaai/stt` (`packages/stt`), `@arcaai/vox` (`packages/agentic-sdk-v2`), observed in `apps/compat-playground`

## Requirement Analysis

The compat playground renders a garbage transcript timestamp — e.g. `29758156960:40.000`
in `mm:ss.mmm`, and the returned metadata shows `t: 1785489417640` (a Unix epoch in
**milliseconds**) with `start == end`. The transcript text is also prefixed with the same
raw epoch value via the `{timestamp}` template.

Expected behavior: the timestamp is the **stream-relative offset in seconds** (time since
the start of recording), which the STT backend already emits per utterance
(`apps/stt/.../streaming/session.py` → `"start_time": round(r.start_time, 4)`), formatted
as `mm:ss.mmm`.

## Current State Evaluation (root cause)

Two independent defects compound on the backend-streaming (compat) path:

1. **The streaming path never propagates the per-utterance offset into the field the SDK reads.**
   `StreamingBackendSTTProvider.normalizeTranscript` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts:343`)
   consumes the wire `startTime`/`endTime` (seconds, relative to stream start) but collapses
   them into `duration` only — it never sets `vadStreamStartSec`/`vadStreamEndSec`. Those fields
   are populated in exactly one place, the **local** in-browser Whisper path
   (`TranscriptionPipeline.ts:810`, gated on `providerType === 'local'`). So on the streaming
   path they are always `undefined`.
   - The stt-package `TranscriptionResult` (`packages/stt/src/types/index.ts:447`) does not even
     declare these fields; the sdk-side type (`packages/agentic-sdk-v2/src/types/audio.ts:127`)
     does. The object crosses the type boundary by a bare `as` cast at `TranscriptionPipeline.ts:842`
     with no field-dropping mapper, so an added property survives to the hook intact.

2. **The fallback uses the wrong unit.** With the VAD fields `undefined`, `useArcaAudio.ts:247-248`
   falls back to `fallbackTime = Date.now()` — epoch **milliseconds** — into a field documented as
   "seconds relative to audio stream start". `formatTimestamp` (playground) then treats that as
   seconds: `floor(1785489417640 / 60) = 29758156960` min, `% 60 = 40` s — the exact value in the
   screenshot. The same `seg.startTime` also feeds `meta.startTime` (the `t:` metadata) and the
   `{timestamp}` text-template prefix, so all three displays are wrong together.

## Implementation Plan (TDD)

Layer order: types → provider → SDK hook fallback.

1. **RED (provider):** add a test to `StreamingBackendSTTProvider.test.ts` asserting an emitted
   final result carries `vadStreamStartSec === payload.startTime` and `vadStreamEndSec === payload.endTime`.
2. **GREEN:** declare `vadStreamStartSec?`/`vadStreamEndSec?` on the stt-package `TranscriptionResult`;
   set them in `normalizeTranscript` from `payload.startTime`/`payload.endTime`.
3. **RED (hook):** add a focused test (mirroring the `speakerLabel.task489` harness) asserting that a
   final `onTranscription` result **without** VAD offsets produces a `segment.startTime` that is a
   small seconds value (not an epoch-ms magnitude), and that a result **with** `vadStreamStartSec`
   passes it through unchanged.
4. **GREEN:** replace the epoch-ms fallback at `useArcaAudio.ts:247-248` with a unit-safe `0`.

No migration, no API change, no new env var. Playground code is left unchanged — its `startTime`
guard and `formatTimestamp` are correct once the SDK delivers a real seconds offset.

## Verification Criteria

- `pnpm --filter @arcaai/stt test` and `pnpm --filter @arcaai/vox test` green (new tests + no regressions).
- Both packages build; no new lint errors.
- Manual: in the compat playground, a streaming transcript segment shows `mm:ss.mmm` growing from
  `00:00` with the recording, and `t:` metadata shows small seconds values (owner-run against the live stack).

## Implementation Summary

Three edits (two `@arcaai/stt`, one `@arcaai/vox`); no migration, no API change, no env var.

**`@arcaai/stt`**
- `packages/stt/src/types/index.ts` — added optional `vadStreamStartSec?` / `vadStreamEndSec?`
  to `TranscriptionResult` (mirrors the sdk-side field names so the object duck-types across the
  `as` cast at `TranscriptionPipeline.ts:842`).
- `packages/stt/src/providers/StreamingBackendSTTProvider.ts` — `normalizeTranscript` now sets
  `vadStreamStartSec: payload.startTime` / `vadStreamEndSec: payload.endTime` (the seconds-relative
  offset the backend emits), in addition to the existing `duration`.

**`@arcaai/vox`**
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — replaced the `Date.now()` (epoch-ms) fallback
  for `segment.startTime`/`endTime` with a unit-safe `0`. With the provider now populating the VAD
  offsets, the fallback no longer fires on the streaming path; the change makes the residual fallback
  unit-correct rather than garbage.

The compat playground (`SessionWorkspace.tsx`) was **not** touched — its `startTime` guard and
`formatTimestamp` are correct once the SDK delivers a real seconds offset. The same `seg.startTime`
feeds the `mm:ss.mmm` display, the `t:` returned-metadata, and the `{timestamp}` text template, so
all three are fixed by the SDK-side change.

**Tests (TDD, RED→GREEN both):**
- `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts` — asserts the emitted
  result carries `vadStreamStartSec`/`vadStreamEndSec` from the payload (RED verified against the
  pre-fix provider).
- `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaAudio.timestamp.task591.test.ts` (new) — asserts
  a real offset passes through, and the no-offset fallback is `0` / `< 1_000_000` (RED verified by
  temporarily restoring the `Date.now()` fallback).

## Verification Evidence

- `pnpm --filter @arcaai/stt test` → 424 passed. `typecheck` clean, `build` success, `lint` PASS.
- `pnpm --filter @arcaai/vox test` → 3741 passed. `typecheck` 0 TS errors, `build` success, `lint`
  no new warnings (baseline 6 → 4 in the changed file).
- Not yet run: live-stack manual pass in the compat playground (owner tail — requires the dev STT
  stack + a recording).

## Change History

- 2026-07-31 — Ticket opened; root cause traced to (1) streaming path never setting
  `vadStreamStartSec`/`vadStreamEndSec` and (2) an epoch-ms unit-mismatch fallback in `useArcaAudio`.
- 2026-07-31 — Implemented + gate-verified (stt + vox tests/typecheck/build/lint green). Status → Review.
  Uncommitted. Owner tail: live compat-playground verification, then commit.
- 2026-07-31 — UI follow-up: the compat playground already renders the `mm:ss.mmm` time on the first
  (text-xs) line, so the templated second line duplicated it (`{timestamp} {speaker_id}: {text}` →
  e.g. "2.048 Speaker 1: …"). Set `transcriptTemplate: '{speaker_id}: {text}'` on the playground's
  `useArcaSpeechToText` call (`apps/compat-playground/src/components/SessionWorkspace.tsx`) to drop the
  redundant time. Playground-only — the v1-parity `DEFAULT_TRANSCRIPT_TEMPLATE` (frozen compat
  contract) is unchanged. `compat-playground typecheck` clean; page loads with no console errors.
  Live transcript-line visual proof is an owner tail (needs the STT stack + a recording).
