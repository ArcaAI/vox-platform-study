# TASK-464 — Surface SDK Provider Audio-Drop Count to the Consultation UI (C6-01 sibling, DISCOVERED)

- **Status**: Pending (discovered during Wave 1 review — awaiting prioritization)
- **Type**: bugfix (patient-safety — silent data loss on the SDK path)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · discovered follow-up
- **Origin**: found by the TASK-454 adversarial reviewer (Important #1) while verifying C6-01.
- **Severity**: Medium–High — the admin **playground** hook now surfaces drops (TASK-454), but the `@arcaai/vox` SDK consultation path — the real browser clinical surface — still counts drops without surfacing them.
- **Branch (when scheduled)**: `fix/task-464-sdk-drop-surfacing` (from current HEAD)
- **Size**: M

## Requirement Analysis

TASK-454 made outbound-audio drops visible for the admin-console playground hook (push-based: `onBackpressureDrop` → banner/badge) and made `StreamingBackendSTTProvider` honor the boolean return + count drops via `getDroppedFrameCount()`. But **nothing reads that count** on the SDK path:

- `StreamingBackendSTTProvider.getDroppedFrameCount()` ([StreamingBackendSTTProvider.ts:273](packages/stt/src/providers/StreamingBackendSTTProvider.ts)) has **zero non-test callers**.
- `STTProcessor.initializeStreamingRemoteProvider` ([STTProcessor.ts:693](packages/stt/src/core/STTProcessor.ts)) wires `onTranscription`/`onError` but never reads drops.
- `STTProcessor.getStats() → provider.getStats()` ([STTProcessor.ts:304](packages/stt/src/core/STTProcessor.ts)) omits drops (`BaseSTTProvider.getStats()` returns only `totalAudioProcessed`/`transcriptionCount`/`totalLatencyMs`).

So on a real consultation over the SDK, sustained backpressure drops frames, `getDroppedFrameCount()` reads the number in memory, but nothing polls it — the clinician signs an incomplete transcript with no indication of loss. This is the exact "silent, no clinician-visible signal" defect C6-01 set out to kill, still live on the SDK surface.

### Acceptance criteria

- [ ] **AC-1**: give the provider a PUSH channel mirroring the client's `onBackpressureDrop` (rather than a passive getter nothing pulls) — an event/callback the provider fires on drop.
- [ ] **AC-2**: `STTProcessor` consumes it and exposes it (via `getStats()` including a `droppedFrames` field AND/OR an event), so the vox store and consultation UI can render a degraded-connection signal — paralleling TASK-454's session-sticky "audio was lost this session" indicator.
- [ ] **AC-3**: the vox consultation UI surfaces the signal to the clinician (the specific surface depends on where the consultation UI lives — scope this when prioritizing; it may be outside `apps/admin-console`).
- [ ] **AC-4 (red first)**: a test drives the provider through a drop and asserts the count/event propagates through `STTProcessor` to the consumer — failing against current code.
- [ ] **AC-5**: `pnpm --filter @arcaai/stt build test lint` + any consumer package green.

### Non-goals / notes

- TASK-454 already fixed the playground hook path and the provider's counting — do NOT redo those.
- The deprecated `apps/ui-playground` caller ([use-realtime-transcription.ts:379]) still ignores the boolean return — correctly out of scope (deprecated app), noted so it isn't mistaken for coverage.
- Scope question to resolve at prioritization: where is the vox SDK consultation UI, and is it in this repo? That determines AC-3's surface.

## Implementation Plan

_Deferred — pending user prioritization (see TASK-449 §Discovered during Wave 1). Standard TDD stream with the orchestration contract when scheduled.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from the TASK-454 review's Important #1 finding (provider counts drops but nothing surfaces them on the SDK path). Awaiting prioritization. |
