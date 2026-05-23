/**
 * @arcaai/noise-filter - Worklet Loader
 *
 * Utilities for loading and registering the RNNoise AudioWorklet processor.
 * Uses @arcaai/room's createWorkletLoader for the blob URL + registration pattern.
 */

import { createWorkletLoader } from '@arcaai/room';
import { NoiseFilterError, NoiseFilterErrorCode } from '../types/index.js';

/**
 * Default name for the worklet processor.
 */
export const WORKLET_PROCESSOR_NAME = 'rnnoise-worklet-processor';

/**
 * Generate the worklet source code as a string.
 *
 * MUST stay algorithmically identical to `src/worklets/rnnoise.worklet.ts`
 * and `src/processors/workletRnnoiseLoader.ts`:
 *  - CRIT-1: preallocated WASM I/O pointers
 *  - CRIT-3: correct `{ a: { a: resize_heap, b: memcpy_big } }` import object
 *            for `@jitsi/rnnoise-wasm@0.2.1`; exports addressed by their
 *            minified names (c, d, e, f, g, h, i, j)
 *  - HIGH-1: two-frame ring buffer with one frame priming latency
 *
 * Unifying the source into a single file is deferred (MED-8).
 */
function generateWorkletSource(): string {
  return `
const RNNOISE_FRAME_SIZE = 480;
const LEVEL_MULTIPLIERS = { low: 0.5, medium: 0.75, high: 1.0 };

class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.initialized = false;
    this.enabled = true;
    this.level = 'medium';
    this.wasmInstance = null;
    this.exports = null;
    this.memory = null;
    this.heapU8 = null;
    this.heapF32 = null;
    this.denoiseState = 0;
    this.inputPtr = 0;
    this.outputPtr = 0;

    this.inputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.inputBufferIndex = 0;

    this.outputRingCapacity = RNNOISE_FRAME_SIZE * 2;
    this.outputRing = new Float32Array(this.outputRingCapacity);
    this.outputRingRead = 0;
    this.outputRingWrite = 0;
    this.outputRingSize = 0;

    this.framesProcessed = 0;
    this.framesDropped = 0;
    this.lastVadProbability = 0;
    this.processingTimeSum = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  refreshViews() {
    if (!this.memory) return;
    this.heapU8 = new Uint8Array(this.memory.buffer);
    this.heapF32 = new Float32Array(this.memory.buffer);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'init':
        this.initWasm(message.wasmBinary).catch((err) => {
          this.port.postMessage({
            type: 'error',
            message: 'WASM init failed: ' + ((err && err.message) || 'Unknown error'),
          });
        });
        break;
      case 'setEnabled':
        this.enabled = message.enabled;
        break;
      case 'setLevel':
        this.level = message.level;
        break;
      case 'getStats':
        this.sendStats();
        break;
      case 'destroy':
        this.cleanup();
        break;
    }
  }

  async initWasm(wasmBinary) {
    const self = this;
    const memcpyBig = (dest, src, num) => { self.heapU8.copyWithin(dest, src, src + num); };
    const resizeHeap = (requestedSize) => {
      try {
        const oldSize = self.memory.buffer.byteLength;
        const requested = requestedSize >>> 0;
        const delta = Math.max(0, Math.ceil((requested - oldSize) / 65536));
        self.memory.grow(delta);
        self.refreshViews();
        return 1;
      } catch (e) { return 0; }
    };
    const importObject = { a: { a: resizeHeap, b: memcpyBig } };

    const { instance } = await WebAssembly.instantiate(wasmBinary, importObject);
    this.wasmInstance = instance;
    this.exports = instance.exports;
    this.memory = this.exports.c;
    this.refreshViews();
    this.exports.d();

    this.denoiseState = this.exports.f();
    this.inputPtr = this.exports.g(RNNOISE_FRAME_SIZE * 4);
    this.outputPtr = this.exports.g(RNNOISE_FRAME_SIZE * 4);

    this.initialized = true;
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];

    if (!input || !output) return true;
    if (!this.initialized || !this.enabled || !this.exports) {
      output.set(input);
      return true;
    }

    const startTime = currentTime;

    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputBufferIndex++] = input[i];
      if (this.inputBufferIndex >= RNNOISE_FRAME_SIZE) {
        this.processFrame();
        this.inputBufferIndex = 0;
      }

      if (this.outputRingSize > 0) {
        output[i] = this.outputRing[this.outputRingRead];
        this.outputRingRead = (this.outputRingRead + 1) % this.outputRingCapacity;
        this.outputRingSize--;
      } else {
        output[i] = 0;
      }
    }

    this.processingTimeSum += (currentTime - startTime) * 1000;
    return true;
  }

  processFrame() {
    if (!this.exports || !this.heapF32) return;

    const inputView = this.heapF32.subarray(this.inputPtr / 4, this.inputPtr / 4 + RNNOISE_FRAME_SIZE);
    inputView.set(this.inputBuffer);

    this.lastVadProbability = this.exports.j(this.denoiseState, this.outputPtr, this.inputPtr);

    const outputView = this.heapF32.subarray(this.outputPtr / 4, this.outputPtr / 4 + RNNOISE_FRAME_SIZE);
    const multiplier = LEVEL_MULTIPLIERS[this.level];
    const dryGain = 1 - multiplier;

    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      const sample = this.inputBuffer[i] * dryGain + outputView[i] * multiplier;
      if (this.outputRingSize >= this.outputRingCapacity) {
        this.outputRingRead = (this.outputRingRead + 1) % this.outputRingCapacity;
        this.outputRingSize--;
        this.framesDropped++;
      }
      this.outputRing[this.outputRingWrite] = sample;
      this.outputRingWrite = (this.outputRingWrite + 1) % this.outputRingCapacity;
      this.outputRingSize++;
    }

    this.framesProcessed++;
  }

  sendStats() {
    const frameDurationMs = (RNNOISE_FRAME_SIZE / sampleRate) * 1000;
    const avgProcessingTime = this.framesProcessed > 0 ? this.processingTimeSum / this.framesProcessed : 0;
    const cpuLoad = Math.min(1, avgProcessingTime / frameDurationMs);
    this.port.postMessage({
      type: 'stats',
      stats: {
        isActive: this.enabled && this.initialized,
        noiseReductionDb: this.enabled ? 12 * LEVEL_MULTIPLIERS[this.level] : 0,
        vadProbability: this.lastVadProbability,
        latencyMs: frameDurationMs,
        framesProcessed: this.framesProcessed,
        framesDropped: this.framesDropped,
        cpuLoad: cpuLoad,
        timestamp: Date.now(),
      },
    });
  }

  cleanup() {
    if (this.exports) {
      try {
        if (this.inputPtr) this.exports.i(this.inputPtr);
        if (this.outputPtr) this.exports.i(this.outputPtr);
        if (this.denoiseState) this.exports.h(this.denoiseState);
      } catch (e) {}
    }
    this.wasmInstance = null;
    this.exports = null;
    this.memory = null;
    this.heapU8 = null;
    this.heapF32 = null;
    this.denoiseState = 0;
    this.inputPtr = 0;
    this.outputPtr = 0;
    this.initialized = false;
    this.port.postMessage({ type: 'destroyed' });
  }
}

registerProcessor('rnnoise-worklet-processor', RNNoiseWorkletProcessor);
`;
}

const loader = createWorkletLoader({
  generateSource: generateWorkletSource,
  label: 'RNNoise',
});

/**
 * Register the RNNoise AudioWorklet with an AudioContext.
 *
 * @param audioContext - The AudioContext to register with
 * @param workletUrl - Optional URL to the worklet file (uses blob URL if not provided)
 */
export async function registerRNNoiseWorklet(audioContext: AudioContext, workletUrl?: string): Promise<void> {
  try {
    await loader.register(audioContext, workletUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('AudioWorklet is not supported')) {
      throw new NoiseFilterError(NoiseFilterErrorCode.NOT_SUPPORTED, message);
    }

    throw new NoiseFilterError(
      NoiseFilterErrorCode.WORKLET_REGISTRATION_FAILED,
      `Failed to register AudioWorklet: ${message}`,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Check if the worklet is registered for an AudioContext.
 *
 * @param audioContext - The AudioContext to check
 */
export function isWorkletRegistered(audioContext: AudioContext): boolean {
  return loader.isRegistered(audioContext);
}

/**
 * Create an RNNoise AudioWorkletNode.
 *
 * @param audioContext - The AudioContext
 * @returns AudioWorkletNode for RNNoise processing
 */
export function createRNNoiseWorkletNode(audioContext: AudioContext): AudioWorkletNode {
  if (!loader.isRegistered(audioContext)) {
    throw new NoiseFilterError(NoiseFilterErrorCode.WORKLET_REGISTRATION_FAILED, 'Worklet not registered. Call registerRNNoiseWorklet first.');
  }

  return new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {},
  });
}

/**
 * Clean up the worklet blob URL.
 * Call this when shutting down to free resources.
 */
export function cleanupWorkletResources(): void {
  loader.cleanup();
}
