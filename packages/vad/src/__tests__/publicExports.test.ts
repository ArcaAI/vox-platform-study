/**
 * @arcaai/vad - Public exports surface
 *
 * Lock the public export list of the package entry point.
 *
 * The custom `vad-worklet-processor` and its loader were dead code (registered
 * by nobody, consumed by nobody). After cleanup, the public API surface MUST
 * NOT advertise those worklet utilities. This test pins the export list via
 * snapshot so any future addition or removal is intentional.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import * as vadPublicApi from '../index.js';

const REMOVED_WORKLET_EXPORTS = [
  'WORKLET_PROCESSOR_NAME',
  'registerVADWorklet',
  'isVADWorkletRegistered',
  'createVADWorkletNode',
  'cleanupVADWorkletResources',
] as const;

describe('public export surface', () => {
  const exportedNames = Object.keys(vadPublicApi).sort();

  it('does not expose the removed worklet loader API', () => {
    for (const removed of REMOVED_WORKLET_EXPORTS) {
      expect(exportedNames).not.toContain(removed);
    }
  });

  it('matches the locked public export snapshot', () => {
    expect(exportedNames).toMatchInlineSnapshot(`
      [
        "AudioRingBuffer",
        "DEFAULT_BASE_ASSET_PATH",
        "DEFAULT_ONNX_WASM_BASE_PATH",
        "DEFAULT_VAD_OPTIONS",
        "FRAME_SIZE_LEGACY",
        "FRAME_SIZE_V5",
        "FrameAccumulator",
        "ORT_WEB_VERSION",
        "Resampler",
        "VADError",
        "VADErrorCode",
        "VADProcessor",
        "VAD_SAMPLE_RATE",
        "VAD_WEB_VERSION",
        "createVAD",
        "downsampleTo16kHz",
        "durationToFrames",
        "durationToSamples",
        "framesToDuration",
        "getFrameSamplesForModel",
        "getRecommendedModel",
        "getSafariVersion",
        "getVADBrowserSupport",
        "isAudioContextSupported",
        "isAudioWorkletSupported",
        "isBrowser",
        "isCrossOriginIsolated",
        "isGetUserMediaSupported",
        "isIOS",
        "isMediaStreamTrackSupported",
        "isMultiThreadedONNXSupported",
        "isONNXRuntimeSupported",
        "isSafari",
        "isSafariAudioWorkletSupported",
        "isScriptProcessorSupported",
        "isSharedArrayBufferSupported",
        "isVADSupported",
        "isWebAssemblySupported",
        "linearResample",
        "logVADBrowserSupport",
        "resampleToVADRate",
        "samplesToDuration",
        "upsampleFrom16kHz",
        "useVAD",
      ]
    `);
  });

  it('exports the AudioRingBuffer utility (re-export required after cleanup)', () => {
    expect(exportedNames).toContain('Resampler');
    expect(exportedNames).toContain('FrameAccumulator');
  });

  it('exports the duration helpers needed by consumers', () => {
    expect(exportedNames).toContain('samplesToDuration');
  });
});
