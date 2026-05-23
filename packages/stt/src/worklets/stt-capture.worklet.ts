/**
 * @arcaai/stt - STT Capture AudioWorklet Loader
 *
 * Provides an `AudioWorkletProcessor` that forwards raw mono Float32 frames
 * from the audio graph to the main thread. Replaces the deprecated
 * `ScriptProcessorNode` capture path used by `STTProcessor`.
 *
 * Backpressure: the worklet posts each `process()` quantum's worth of samples
 * with the underlying `ArrayBuffer` in the transfer list. When the main
 * thread sends `{ type: 'setEnabled', enabled: false }`, frame emission is
 * suspended so the message queue cannot grow during pause / VAD gating.
 *
 * Uses `@arcaai/room`'s `createWorkletLoader` for blob-URL + registration
 * caching, matching the pattern already used by `@arcaai/vad` and
 * `@arcaai/noise-filter`.
 */

import { createWorkletLoader } from '@arcaai/room';

/**
 * Registered processor name. Worklet code uses the same string.
 */
export const STT_CAPTURE_PROCESSOR_NAME = 'stt-capture-worklet-processor';

/**
 * Inline AudioWorklet source. Worklet runs in the audio rendering thread, so
 * it must be defined as a string and registered via `addModule(blob)` — it
 * cannot reach back into module scope.
 */
function generateWorkletSource(): string {
  return `
class STTCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === 'setEnabled') {
        this.enabled = !!message.enabled;
      }
    };
  }

  process(inputs) {
    if (!this.enabled) {
      return true;
    }

    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    // Copy into a freshly-allocated buffer so it can be transferred without
    // detaching the rendering thread's input view (which the host owns).
    const frame = new Float32Array(channel.length);
    frame.set(channel);
    this.port.postMessage(frame, [frame.buffer]);
    return true;
  }
}

registerProcessor('${STT_CAPTURE_PROCESSOR_NAME}', STTCaptureProcessor);
`;
}

const loader = createWorkletLoader({
  generateSource: generateWorkletSource,
  label: 'STT-Capture',
});

/**
 * Register the STT capture worklet with an `AudioContext`. Subsequent calls
 * with the same context are no-ops.
 *
 * @throws if the runtime does not support `AudioWorklet`. Callers must
 *   feature-detect via `audioContext.audioWorklet` before calling.
 */
export async function registerSTTCaptureWorklet(audioContext: AudioContext, workletUrl?: string): Promise<void> {
  await loader.register(audioContext, workletUrl);
}

/**
 * Check if the worklet is registered for an `AudioContext`.
 */
export function isSTTCaptureWorkletRegistered(audioContext: AudioContext): boolean {
  return loader.isRegistered(audioContext);
}

/**
 * Create an `AudioWorkletNode` instance for STT capture.
 *
 * @throws if the worklet has not been registered for the given context.
 */
export function createSTTCaptureWorkletNode(audioContext: AudioContext): AudioWorkletNode {
  if (!loader.isRegistered(audioContext)) {
    throw new Error('[STT-Capture] Worklet not registered. Call registerSTTCaptureWorklet first.');
  }

  return new AudioWorkletNode(audioContext, STT_CAPTURE_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {},
  });
}

/**
 * Revoke the cached blob URL. Call when shutting down the SDK to free memory.
 */
export function cleanupSTTCaptureWorkletResources(): void {
  loader.cleanup();
}

/**
 * Exposed for tests — not part of the public worklet API.
 *
 * @internal
 */
export const __testing__ = {
  generateWorkletSource,
};
