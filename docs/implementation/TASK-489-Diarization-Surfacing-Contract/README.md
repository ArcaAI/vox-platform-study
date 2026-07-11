# TASK-489 — Diarization Speaker-Label Surfacing Contract (Labels Never Reach the Clinician)

- **Status**: Pending
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

- [ ] **AC-1 (wire contract)**: add a canonical speaker field (`speakerId` and/or `speakerLabel`) to the streaming wire DTO (`streaming-session.dto.ts`), carried end-to-end from `schemas.py` `speaker_id` → gateway relay → SDK/admin hooks. ONE canonical id→label mapping (not per-consumer re-derivation).
- [ ] **AC-2 (admin surfacing)**: `use-live-stt-session.ts` renders the speaker (fall back to `speakerId` when no friendly label), so the default admin streaming tab shows per-segment speaker attribution.
- [ ] **AC-3 (semantics)**: define clinician/patient label semantics (anonymous `Speaker0/1` vs preseeded-name vs role) consistent with the TASK-475 naming plan (map anonymous → preseeded clinician, or → "Clinician"/"Patient").
- [ ] **AC-4 (dead code)**: remove or wire the dead `emitTranscriptEvent` (`transcriptionRealtime.service.ts:267-296`) — do not leave it dead.
- [ ] **AC-5 (tests + gates)**: TDD wire/derive/render tests; `pnpm --filter @arcaai/applications test lint`, SDK + UI gates green; no PHI in the label path (labels are `Speaker0/1`/role, not raw names unless the preseed path is tenant-safe — see TASK-490).

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

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | Scaffolded from the TASK-474 review finding B-01 (Critical surfacing-contract break). Full file:line audit context in the [TASK-474 README](../TASK-474-Diarization-Internals-Review/README.md). Prerequisite for TASK-475. Status → Pending. |
