/**
 * @arcaai/stt - STT Capture AudioWorklet Loader
 *
 * Provides an `AudioWorkletProcessor` that forwards mono Float32 audio from
 * the audio graph to the main thread. Replaces the deprecated
 * `ScriptProcessorNode` capture path used by `STTProcessor`.
 *
 * Frame coalescing (TASK-351 P0-1 / C4): instead of posting every 128-sample
 * render quantum (~2.7 ms at 48 kHz → ~375 messages/s), quanta accumulate in
 * a preallocated buffer and are posted as one coalesced frame every
 * `frameMs` (default 80 ms → ~12 messages/s). This cuts main-thread message
 * pressure and, downstream, the WS/Redis frame rate by ~10–30× without
 * perceptible latency (80 ms ≪ the 1 s partial cadence).
 *
 * Backpressure: when the main thread sends
 * `{ type: 'setEnabled', enabled: false }`, the pending remainder is flushed
 * and emission is suspended so the message queue cannot grow during pause /
 * VAD gating. `{ type: 'flush' }` forces the remainder out (e.g. before
 * stop) so trailing audio is never lost.
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
 * Default coalesced frame size in milliseconds (TASK-351 P0-1).
 */
export const DEFAULT_STT_CAPTURE_FRAME_MS = 80;

/**
 * Options for {@link createSTTCaptureWorkletNode}.
 */
export interface STTCaptureWorkletNodeOptions {
  /** Coalesced frame size in ms. Defaults to {@link DEFAULT_STT_CAPTURE_FRAME_MS}. */
  frameMs?: number;
}

/**
 * Inline AudioWorklet source. Worklet runs in the audio rendering thread, so
 * it must be defined as a string and registered via `addModule(blob)` — it
 * cannot reach back into module scope. `sampleRate` is an
 * `AudioWorkletGlobalScope` global.
 */
function generateWorkletSource(): string {
  return `
class STTCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.enabled = true;

    const processorOptions = (options && options.processorOptions) || {};
    const frameMs =
      typeof processorOptions.frameMs === 'number' && processorOptions.frameMs > 0
        ? processorOptions.frameMs
        : ${DEFAULT_STT_CAPTURE_FRAME_MS};

    // Preallocated accumulation buffer. One allocation per posted frame
    // (the transfer list detaches the buffer) instead of one per quantum.
    this.targetSamples = Math.max(128, Math.round((sampleRate * frameMs) / 1000));
    this.buffer = new Float32Array(this.targetSamples);
    this.filled = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message) {
        return;
      }
      if (message.type === 'setEnabled') {
        const enabled = !!message.enabled;
        if (this.enabled && !enabled) {
          this.flushRemainder();
        }
        this.enabled = enabled;
      } else if (message.type === 'flush') {
        this.flushRemainder();
      }
    };
  }

  flushRemainder() {
    if (this.filled === 0) {
      return;
    }
    const frame = this.buffer.slice(0, this.filled);
    this.filled = 0;
    this.port.postMessage(frame, [frame.buffer]);
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

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(this.targetSamples - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === this.targetSamples) {
        const frame = this.buffer;
        this.buffer = new Float32Array(this.targetSamples);
        this.filled = 0;
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
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
export function createSTTCaptureWorkletNode(audioContext: AudioContext, options?: STTCaptureWorkletNodeOptions): AudioWorkletNode {
  if (!loader.isRegistered(audioContext)) {
    throw new Error('[STT-Capture] Worklet not registered. Call registerSTTCaptureWorklet first.');
  }

  return new AudioWorkletNode(audioContext, STT_CAPTURE_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      frameMs: options?.frameMs ?? DEFAULT_STT_CAPTURE_FRAME_MS,
    },
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
