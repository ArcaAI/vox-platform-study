# TASK-464 — Surface SDK Provider Audio-Drop Count to the Consultation UI (C6-01 sibling, DISCOVERED)

- **Status**: Completed — adversarial review APPROVE (no Critical/Important); all ACs met + STT 25/25 + vox 172/172 green. AC-3 is delivered as tested exported selectors/hook fields (the real vox UI is an external `@arcaai/vox` consumer — scoping accepted per this README). Only the owner's push/PR to main remains.
- **Type**: bugfix (patient-safety — silent data loss on the SDK path)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · discovered follow-up
- **Origin**: found by the TASK-454 adversarial reviewer (Important #1) while verifying C6-01.
- **Severity**: Medium–High — the admin **playground** hook now surfaces drops (TASK-454), but the `@arcaai/vox` SDK consultation path — the real browser clinical surface — still counts drops without surfacing them.
- **Branch**: `fix/task-464-sdk-drop-surfacing` (cut from `fix/2605-review` @ `dfd4f4dd`)
- **Size**: M

## Requirement Analysis

TASK-454 made outbound-audio drops visible for the admin-console playground hook (push-based: `onBackpressureDrop` → banner/badge) and made `StreamingBackendSTTProvider` honor the boolean return + count drops via `getDroppedFrameCount()`. But **nothing reads that count** on the SDK path:

- `StreamingBackendSTTProvider.getDroppedFrameCount()` ([StreamingBackendSTTProvider.ts:273](packages/stt/src/providers/StreamingBackendSTTProvider.ts)) has **zero non-test callers**.
- `STTProcessor.initializeStreamingRemoteProvider` ([STTProcessor.ts:693](packages/stt/src/core/STTProcessor.ts)) wires `onTranscription`/`onError` but never reads drops.
- `STTProcessor.getStats() → provider.getStats()` ([STTProcessor.ts:304](packages/stt/src/core/STTProcessor.ts)) omits drops (`BaseSTTProvider.getStats()` returns only `totalAudioProcessed`/`transcriptionCount`/`totalLatencyMs`).

So on a real consultation over the SDK, sustained backpressure drops frames, `getDroppedFrameCount()` reads the number in memory, but nothing polls it — the clinician signs an incomplete transcript with no indication of loss. This is the exact "silent, no clinician-visible signal" defect C6-01 set out to kill, still live on the SDK surface.

### Acceptance criteria

- [x] **AC-1**: gave the provider a PUSH channel — `StreamingBackendSTTProvider.onDrop(cb)` fires once per dropped frame (with the running total) right after the `droppedFrameCount` increment in `processAudio`.
- [x] **AC-2**: `STTProcessor` consumes it (`onBackpressureDrop(cb)`, re-emitted from the provider's `onDrop`) AND surfaces the count in `getStats().droppedFrames`; the vox `TranscriptionPipeline` emits an `audioDrop` event, `PluginManager` forwards it as `onAudioDrop`, and the store exposes a session-sticky `audioLostThisSession` latch + `audioDroppedFrameCount` — paralleling TASK-454.
- [x] **AC-3**: surfaced to the SDK boundary — `useArcaAudio()` exposes `droppedFrameCount` + `audioLostThisSession`, and `@arcaai/vox` exports `selectAudioDropped` / `selectAudioDegraded` for the EXTERNAL vox consultation UI to read via `useArcaStore(selector)`. The real clinical vox UI is an external `@arcaai/vox` consumer (out of this repo); the optional admin-console demo banner was deliberately not built (task: "not required / do NOT build a production UI").
- [x] **AC-4 (red first)**: RED captured at every layer (provider `onDrop`/`getStats().droppedFrames`, `STTProcessor.onBackpressureDrop`, pipeline `audioDrop`, PluginManager forward, store actions/latch, hook wiring) before implementing.
- [x] **AC-5**: `@arcaai/stt` build/test/lint/typecheck green; `@arcaai/vox` build/test/lint green (typecheck has pre-existing baseline errors only — see §Implementation Summary).

### Non-goals / notes

- TASK-454 already fixed the playground hook path and the provider's counting — do NOT redo those.
- The deprecated `apps/ui-playground` caller ([use-realtime-transcription.ts:379]) still ignores the boolean return — correctly out of scope (deprecated app), noted so it isn't mistaken for coverage.
- Scope question to resolve at prioritization: where is the vox SDK consultation UI, and is it in this repo? That determines AC-3's surface.

## Implementation Plan (executed — strict TDD, LAYERED)

Push channel wired bottom-up, RED before code at each layer (a getter-only fix is inert because `getStats()` is unpolled on the SDK path — the push channel is load-bearing):

1. **`packages/stt` — provider** (`StreamingBackendSTTProvider`): `onDrop(cb)` registration; fire in `processAudio` right after the `droppedFrameCount++`; add `droppedFrames` to `getStats()`.
2. **`packages/stt` — processor** (`STTProcessor`): register the provider's `onDrop` in `initializeStreamingRemoteProvider`; expose `onBackpressureDrop(cb)`; `getStats().droppedFrames` flows through the existing spread. `STTStats` gains `droppedFrames?: number`.
3. **`packages/agentic-sdk-v2` — pipeline**: `audioDrop: number` event on `TranscriptionPipelineEvents`; `setupProcessorEventHandlers` registers the STT processor's `onBackpressureDrop` (guarded/optional) → emits `audioDrop`.
4. **`PluginManager`**: `onAudioDrop?` on `PluginEventCallbacks`; forward the pipeline's `audioDrop` in `setupPipelineEventHandlers`.
5. **`useArcaAudio`**: register `onAudioDrop` → `store.markAudioLost()` + `store.incrementDroppedFrames()`; `store.resetAudioDropped()` on start AND stop; expose `droppedFrameCount` + `audioLostThisSession` in the memo return.
6. **`agenticStore`**: `audioDroppedFrameCount` + `audioLostThisSession` state/initialState; `incrementDroppedFrames` / `markAudioLost` / `resetAudioDropped` actions; EXPORTED `selectAudioDropped` / `selectAudioDegraded` selectors (re-exported from `@arcaai/vox` core); reset in `reset` / `clearTenantSessionData` / `clearSensitiveData` / `clearOnLogout`.

## Implementation Summary

**What shipped** — the drop count no longer dead-ends. A single source-of-truth counter (the **provider's** `droppedFrameCount`, incremented off `sendAudioFrame`'s `false` return) is PUSHED up a new channel:

```
StreamingBackendSTTProvider.onDrop(count)              // packages/stt (provider)
  → STTProcessor.onBackpressureDrop(count)             // packages/stt (processor, re-emit)
    → TranscriptionPipeline emit 'audioDrop'(count)    // vox pipeline
      → PluginManager.callbacks.onAudioDrop(count)     // vox plugin manager
        → useArcaAudio: store.markAudioLost() + store.incrementDroppedFrames()
          → store.audioLostThisSession / audioDroppedFrameCount
            → EXPORTED selectAudioDropped / selectAudioDegraded  (external vox UI reads via useArcaStore)
```

- **Single counter (no double-counting)**: only the provider's count is consumed. The ws client's own `onBackpressureDrop` / `getDroppedFrameCount` (TASK-454 plumbing) is **not** subscribed on this path, so a drop is counted exactly once. `SttV2WebSocketClient.ts` was **not** touched.
- **Session-sticky latch (mirrors TASK-454)**: `audioLostThisSession` SURVIVES reconnect (there is no disconnect/reconnect reset — the bug TASK-454 fixed on review) and clears ONLY on capture start/stop (`resetAudioDropped()` in `startAudio` before audio flows, and in `stopAudio`). Tenant-switch / logout / security-wipe paths also reset it (a new tenant session must not inherit the outgoing signal).
- **Rule 08 compliance**: the external read path is `useArcaStore(selectAudioDropped)` / `useArcaStore(selectAudioDegraded)` via EXPORTED selectors (never a direct store import); actions live on the store; selectors read a single atomic field.
- **Scope stopped at the SDK hook boundary** — the real clinical vox UI is an external `@arcaai/vox` consumer. The optional admin-console `consultation-demo-screen` banner was intentionally not built (task marked it optional / "do NOT build a production UI").

**RED → GREEN evidence**:
- STT RED: 5 failures — `provider.onDrop is not a function`, `getStats().droppedFrames` undefined, `processor.onBackpressureDrop is not a function`. → GREEN after impl.
- SDK RED: 15 failures across store (fields/actions/selectors/latch), `useArcaAudio` (onAudioDrop wiring + expose + reset), PluginManager (`audioDrop`→`onAudioDrop`), pipeline (`onBackpressureDrop`→`audioDrop`). → GREEN after impl.

**Gate output** (worktree, `fix/task-464-sdk-drop-surfacing`):

| Package | build | test | lint | typecheck |
|---|---|---|---|---|
| `@arcaai/stt` | ✅ (DTS success) | ✅ **416** passed (25 files) | ✅ clean (`--max-warnings 0`) | ✅ clean |
| `@arcaai/vox` | ✅ | ✅ **3512** passed (198 files) | ✅ 0 errors (71 pre-existing prettier warnings, **0 new**) | ⚠️ 10 pre-existing errors only |

The vox `typecheck` (`tsc --noEmit`, includes test files) reports 10 errors in 4 files I never touched (`bundle-externals.task364.test.ts`, `SttV2WebSocketClient.test.ts`, `useHarnessAdmin.test.ts`, `promptMetrics.test.ts`). Proven pre-existing: stashing all TASK-464 changes and re-running yields the **identical** 10 errors. My changes add **0** new type errors (the vox `build` DTS step, which type-checks source, is green). Test-mock update: five pre-existing `useArca*`/`useArcaAudio*` store mocks gained the three new audio-drop actions the hook now calls (else `store.resetAudioDropped is not a function`).

**Files changed** — source: `packages/stt/src/{types/index.ts, providers/StreamingBackendSTTProvider.ts, core/STTProcessor.ts}`; `packages/agentic-sdk-v2/src/{types/pipeline.ts, core/TranscriptionPipeline.ts, core/PluginManager.ts, store/agenticStore.ts, hooks/useArcaAudio.ts, hooks/useArca.ts, core.ts}`. Tests: extended `StreamingBackendSTTProvider.test.ts`, `STTProcessor.streamingTransport.test.ts`, `agenticStore.test.ts`, `PluginManager.test.ts`; new `TranscriptionPipeline.audioDrop.task464.test.ts`, `useArcaAudio.audioDrop.task464.test.ts`; five existing store-mock updates.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from the TASK-454 review's Important #1 finding (provider counts drops but nothing surfaces them on the SDK path). Awaiting prioritization. |
| 2026-07-10 | Implemented via strict TDD, LAYERED (scaffold-faithful) approach. Single source-of-truth counter (provider's), new push channel provider→processor→pipeline→PluginManager→hook→store, EXPORTED `selectAudioDropped`/`selectAudioDegraded`, session-sticky `audioLostThisSession` latch (survives reconnect, clears on start/stop). `SttV2WebSocketClient.ts` untouched. Gates: `@arcaai/stt` 416 tests + build/lint/typecheck green; `@arcaai/vox` 3512 tests + build/lint green (typecheck: pre-existing baseline errors only, 0 new). Committed to `fix/task-464-sdk-drop-surfacing`; not merged (orchestrator review). |
| 2026-07-11 | **Closed (Status → Completed).** Adversarial review (closure gate) = APPROVE, no Critical/Important: push chain verified end-to-end (provider `onDrop` → processor → pipeline `audioDrop` → PluginManager → hook → store), reconnect-safety latch holds (no reset on reconnect), PHI/tenant resets verified in-body (`clearTenantSessionData`/`clearSensitiveData`/`clearOnLogout`/`reset`), single counter (no double-count — ws client path unsubscribed), tests meaningful (STT 25/25, vox 172/172). AC-3 external-consumer scoping accepted (real vox UI is out-of-repo; TASK-454 covers the in-repo playground). Non-blocking notes only (clearOnLogout has inspection-only coverage; hook's local +1 is intentional session-cumulative semantics). No external work remains — only the owner's push/PR. |
