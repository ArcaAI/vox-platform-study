/**
 * SDK Exports Verification — audio-shaped public types.
 *
 * `AudioStartOptions`, `AudioProcessingConstraints`, `DualCaptureResult`,
 * `ActivePipelineInfo` and `SttConnectionState` are the argument/return shapes
 * of already-public surfaces (`audio.start(options)`, `audio.dualCapture`,
 * `useArcaStore` pipeline/connection state), yet none of them was reachable
 * from ANY entry point: `core.ts` never re-exported them, `plugins.ts` exports
 * no types at all, and three of the five were missing from the `types` barrel
 * too. A consumer could call the API but not name its types.
 *
 * They are TYPES, so the assertion that matters is a compile-time one: the
 * `import type` below fails `tsc --noEmit` (the `typecheck` gate) when an
 * identifier is not exported from that entry. The runtime bodies exist so the
 * file also participates in the `test` gate.
 *
 * `core.ts` is the correct entry: these are erased at build time, so exporting
 * them adds no audio/ML runtime code to `/core` — which already exports the
 * neighbouring `AudioState`/`AudioActions`/`TranscriptSegment` types.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import type {
  ActivePipelineInfo,
  AudioProcessingConstraints,
  AudioStartOptions,
  DualCaptureResult,
  SttConnectionState,
} from '../core.js';
import type {
  ActivePipelineInfo as RootActivePipelineInfo,
  AudioProcessingConstraints as RootAudioProcessingConstraints,
  AudioStartOptions as RootAudioStartOptions,
  DualCaptureResult as RootDualCaptureResult,
  SttConnectionState as RootSttConnectionState,
} from '../index.js';

describe('audio type exports — core barrel', () => {
  it('names AudioStartOptions and AudioProcessingConstraints', () => {
    const processing: AudioProcessingConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const options: AudioStartOptions = { language: 'en', audioProcessing: processing };
    expect(options.audioProcessing?.autoGainControl).toBe(false);
  });

  it('names DualCaptureResult', () => {
    const capture: DualCaptureResult = { raw: new Blob(['raw']), processed: new Blob(['processed']) };
    expect(capture.raw).toBeInstanceOf(Blob);
    expect(capture.processed).toBeInstanceOf(Blob);
  });

  it('names ActivePipelineInfo and SttConnectionState', () => {
    const pipeline: ActivePipelineInfo = { id: 'p-1', name: 'Primary', isFallback: false };
    const state: SttConnectionState = 'switched_fallback';
    expect(pipeline.isFallback).toBe(false);
    expect(state).toBe('switched_fallback');
  });
});

describe('audio type exports — root barrel', () => {
  it('re-exports all five through @arcaai/vox', () => {
    const processing: RootAudioProcessingConstraints = { noiseSuppression: true };
    const options: RootAudioStartOptions = { audioProcessing: processing };
    const capture: RootDualCaptureResult = { raw: new Blob(), processed: new Blob() };
    const pipeline: RootActivePipelineInfo = { id: 'p-2', name: 'Fallback', isFallback: true };
    const state: RootSttConnectionState = 'reconnecting';

    expect(options.audioProcessing?.noiseSuppression).toBe(true);
    expect(capture.processed.size).toBe(0);
    expect(pipeline.isFallback).toBe(true);
    expect(state).toBe('reconnecting');
  });
});
