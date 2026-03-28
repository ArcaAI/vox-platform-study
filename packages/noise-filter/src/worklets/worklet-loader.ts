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
 */
function generateWorkletSource(): string {
  return `
/**
 * Inline RNNoise AudioWorklet Processor
 */

const RNNOISE_FRAME_SIZE = 480;
const LEVEL_MULTIPLIERS = { low: 0.5, medium: 0.75, high: 1.0 };

class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.initialized = false;
    this.enabled = true;
    this.level = 'medium';
    this.wasmInstance = null;
    this.memory = null;
    this.denoiseState = 0;
    this.inputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.inputBufferIndex = 0;
    this.outputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.outputBufferIndex = 0;
    this.outputBufferFilled = 0;
    this.framesProcessed = 0;
    this.lastVadProbability = 0;
    this.processingTimeSum = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'init':
        this.initWasm(message.wasmBinary);
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
    try {
      const wasmModule = await WebAssembly.compile(wasmBinary);
      this.memory = new WebAssembly.Memory({ initial: 256 });

      const importObject = {
        env: {
          memory: this.memory,
          emscripten_notify_memory_growth: () => {},
        },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_close: () => 0,
          fd_write: () => 0,
          fd_seek: () => 0,
        },
      };

      this.wasmInstance = await WebAssembly.instantiate(wasmModule, importObject);
      this.denoiseState = this.wasmInstance.exports.rnnoise_create();
      this.initialized = true;
      this.port.postMessage({ type: 'ready' });
    } catch (error) {
      this.port.postMessage({
        type: 'error',
        message: 'WASM init failed: ' + (error.message || 'Unknown error'),
      });
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) return true;

    if (!this.initialized || !this.enabled || !this.wasmInstance) {
      output.set(input);
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      if (this.outputBufferIndex < this.outputBufferFilled) {
        output[i] = this.outputBuffer[this.outputBufferIndex++];
      } else {
        output[i] = 0;
      }

      this.inputBuffer[this.inputBufferIndex++] = input[i];

      if (this.inputBufferIndex >= RNNOISE_FRAME_SIZE) {
        this.processFrame();
        this.inputBufferIndex = 0;
      }
    }

    return true;
  }

  processFrame() {
    if (!this.wasmInstance || !this.memory) return;

    const exports = this.wasmInstance.exports;
    const inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
    const outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);

    try {
      const inputView = new Float32Array(this.memory.buffer, inputPtr, RNNOISE_FRAME_SIZE);
      inputView.set(this.inputBuffer);

      this.lastVadProbability = exports.rnnoise_process_frame(
        this.denoiseState, outputPtr, inputPtr
      );

      const outputView = new Float32Array(this.memory.buffer, outputPtr, RNNOISE_FRAME_SIZE);
      const multiplier = LEVEL_MULTIPLIERS[this.level];

      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        this.outputBuffer[i] = this.inputBuffer[i] * (1 - multiplier) + outputView[i] * multiplier;
      }

      this.outputBufferIndex = 0;
      this.outputBufferFilled = RNNOISE_FRAME_SIZE;
      this.framesProcessed++;
    } finally {
      exports.free(inputPtr);
      exports.free(outputPtr);
    }
  }

  sendStats() {
    const frameDurationMs = (RNNOISE_FRAME_SIZE / sampleRate) * 1000;
    this.port.postMessage({
      type: 'stats',
      stats: {
        isActive: this.enabled && this.initialized,
        noiseReductionDb: this.enabled ? 12 * LEVEL_MULTIPLIERS[this.level] : 0,
        vadProbability: this.lastVadProbability,
        latencyMs: frameDurationMs,
        framesProcessed: this.framesProcessed,
        framesDropped: 0,
        cpuLoad: 0,
        timestamp: Date.now(),
      },
    });
  }

  cleanup() {
    if (this.wasmInstance && this.denoiseState) {
      try {
        this.wasmInstance.exports.rnnoise_destroy(this.denoiseState);
      } catch {}
    }
    this.wasmInstance = null;
    this.memory = null;
    this.denoiseState = 0;
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
