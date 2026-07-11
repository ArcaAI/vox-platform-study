# TASK-489 — Diarization Speaker-Label Surfacing Contract (Labels Never Reach the Clinician)

- **Status**: Review (implemented 2026-07-11 — wire→derive→render contract landed, all package gates green; diarization stays OFF by default)
- **Type**: bugfix (streaming wire contract + UI surfacing) — closes the end-to-end gap that makes diarization invisible even when it runs
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Discovered by the [TASK-474](../TASK-474-Diarization-Internals-Review/README.md) diarization internals review (2026-07-11)
- **Origin**: TASK-474 finding **B-01 (Critical)** — the diarizer emits `speaker_id` but no `speakerLabel` reaches the clinician-facing surface; latent today (diarization off by default), **live the moment [TASK-475](../TASK-475-Streaming-2Speaker-Diarization/README.md) enables it**.
- **Finding + severity**: **P1** — even a perfect diarizer shows the clinician nothing on the default admin streaming path. **This must precede or accompany TASK-475** (otherwise 475 ships a capability with no visible output).
- **Size**: M
- **Suggested agent**: full-stack (TS gateway/SDK/UI wire contract) — no Python model work.

## Requirement Analysis

The backend produces per-segment speaker attribution but the label is dropped before rendering. The chain (per the TASK-474 review, code-verified):

- **Emit (backend, OK)**: `apps/stt-v2/.../streaming/schemas.py:182-184` serializes `speaker_id`.
- **Wire (gap)**: the gateway relay **type-erases** the field (does NOT strip it — a correction to the earlier imprecise "gateway drops speaker data"), but there is **no `speakerLabel` field on the streaming wire DTO** — `packages/applications/.../stt/streaming/dto/streaming-session.dto.ts:103-138` has no speaker/label field.
- **Derive (inconsistent)**: an id→label derivation exists in the vox path (`packages/agentic-sdk-v2/.../useArcaAudio.ts:146`, raw-id copy) but **not** in the admin frame-51 hook (`use-live-stt-session.ts:193`) → the **default admin streaming tab renders no speaker**.
- **Dead code**: the realtime forwarder `transcriptionRealtime.service.ts:267-296` (`emitTranscriptEvent`) is unused/dead.

(All line refs are from the TASK-474 review — re-verify against the tree on assignment.)

### Acceptance criteria

- [x] **AC-1 (wire contract)**: `speakerLabel?` added to `StreamingTranscriptMessage` (`streaming-session.dto.ts`); derived ONCE by the bridge (`deriveSpeakerLabel` in `streaming/speaker-label.ts`, called in `streamingAudioBridge.service.ts#parseAndEmitResult`) and relayed type-erased by the gateway. Consumers read it off the wire — no per-consumer re-derivation.
- [x] **AC-2 (admin surfacing)**: `use-live-stt-session.ts` now maps `result.speakerLabel ?? result.speakerId` (the admin `WsTranscriptPayload` mirror gains `speakerId?`); `streaming-tab.tsx` already renders the label prefix → the default admin streaming tab shows per-segment attribution.
- [x] **AC-3 (semantics)**: `deriveSpeakerLabel` maps the `"unknown"` sentinel → `"Unknown speaker"` and passes anonymous `"Speaker N"` ids through verbatim; role labels (TASK-475) and preseeded names (TASK-490, PHI-gated) enrich this one seam later. No raw names surfaced here.
- [x] **AC-4 (dead code)**: dead `emitTranscriptEvent` removed from both `transcriptionRealtime.service.ts` and `ITranscriptionRealtimeService.ts` (zero callers; build stays green).
- [x] **AC-5 (tests + gates)**: TDD wire/derive/render tests added; `@arcaai/applications` (build+lint+test), `@arcaai/vox` (build+test+lint+typecheck), `@arcaai/admin-console` (build+lint+test) all green. No PHI in the label path (labels are `Speaker N`/`Unknown speaker`, never raw names).

### Non-goals

- The diarization model/accuracy (TASK-474/475).
- Enabling diarization by default (stays off until TASK-475).

## File-ownership manifest (proposed — confirm on assignment)

| File | Expected change |
|---|---|
| `packages/applications/.../stt/streaming/dto/streaming-session.dto.ts` | Add the speaker field(s) to the wire DTO. |
| `packages/applications/.../stt/streaming/streamingAudioBridge.service.ts` | Carry the field through the relay (verify no strip). |
| SDK `use-live-stt-session.ts` (+ the shared derive) | Render speaker; single id→label mapping. |
| `transcriptionRealtime.service.ts:267-296` | Remove or wire the dead forwarder. |

Coordinate tightly with **TASK-475** (implement together, or land 489 first). Anything outside → STOP and report.

## Implementation Summary (2026-07-11)

The label now travels **wire → derive → render** with a single server-side mapping. Files changed, grouped by package:

**`@arcaai/applications`** (wire contract + canonical mapping + dead code)
- `services/stt/streaming/speaker-label.ts` **(new)** — `deriveSpeakerLabel(speakerId)`, the ONE canonical id→label mapping. `"unknown"` sentinel → `"Unknown speaker"`; anonymous `"Speaker N"` passes through; empty/missing → `undefined`. Documented PHI posture: only reshapes the anonymous ids the streaming path emits, never fabricates a name.
- `services/stt/streaming/dto/streaming-session.dto.ts` — `speakerLabel?: string` added to `StreamingTranscriptMessage`.
- `services/stt/streaming/streamingAudioBridge.service.ts` — `parseAndEmitResult` derives `speakerLabel` from `speaker_id` and emits it (additive; only when present). The bridge is the single carrier; the gateway relays it type-erased (verified — no strip).
- `services/stt/streaming/index.ts` — barrel exports `speaker-label`.
- `services/stt/realtime/{transcriptionRealtime.service.ts,ITranscriptionRealtimeService.ts}` — dead `emitTranscriptEvent` removed (AC-4).

**`@arcaai/vox`** (SDK consumer — no source change needed)
- `SttV2WebSocketClient.normalizeTranscript` already normalizes `speakerLabel` (camelCase + snake_case) off the wire, so the bridge-derived label flows straight through. Added a contract-lock test.

**`@arcaai/admin-console`** (admin surfacing — the default clinician surface)
- `features/playground-live-transcription/api/types.ts` — `WsTranscriptPayload` mirror gains `speakerId?`.
- `features/playground-live-transcription/api/use-live-stt-session.ts` — `speakerLabel: result.speakerLabel ?? result.speakerId` (AC-2 fallback).
- `features/playground-live-transcription/components/streaming-tab.tsx` — `TranscriptPane` exported for the render test (render logic unchanged; already prints the label prefix).

**Tests (RED→GREEN):** `speaker-label.test.ts` (derive), `streamingAudioBridge.service.test.ts` (wire — `Speaker 0` + `unknown` sentinel), `SttV2WebSocketClient.test.ts` (SDK carry), `use-live-stt-session.test.tsx` (derive→row + fallback), `streaming-tab.test.tsx` (render prefix / absent).

**Gates:** applications `build`+`lint`(0 err)+`test`(5974 pass; 2 pre-existing `stt-v1-config-removal` TTS_URL failures from the base `feat(tts-v2)` commit, unrelated); vox `build`+`test`(3532)+`lint`(0 err)+`typecheck`; admin-console `build`(✓ compiled)+`lint`(`--max-warnings 0`)+`test`(846). Diarization untouched and OFF by default.

**Deviation (reported):** the vox `useArcaAudio.ts:146` raw-id copy (`speakerLabel: result.speakerId`) is left as-is. Consolidating it to the canonical label requires threading `speakerLabel` through the separate `@arcaai/stt` `StreamingBackendSTTProvider` → vox `TranscriptionResult` pipeline (a package outside this ticket's manifest + gate set); FT-1's fix scope does not list it. The default admin surface (the ticket's target) is fully consolidated.

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Implemented** (Status → Review). Added `speakerLabel` to the streaming wire DTO + a single canonical `deriveSpeakerLabel` mapping in the applications bridge; made the admin frame-51 hook render the speaker with a `speakerId` fallback; removed the dead `emitTranscriptEvent`. TDD wire/derive/render tests; all three package gates green. Vox SDK needed no source change (already normalizes `speakerLabel`). Diarization stays OFF by default. Vox `useArcaAudio` raw-id copy left as-is (needs out-of-scope `@arcaai/stt` threading — reported). See Implementation Summary. |
| 2026-07-11 | Scaffolded from the TASK-474 review finding B-01 (Critical surfacing-contract break). Full file:line audit context in the [TASK-474 README](../TASK-474-Diarization-Internals-Review/README.md). Prerequisite for TASK-475. Status → Pending. |
