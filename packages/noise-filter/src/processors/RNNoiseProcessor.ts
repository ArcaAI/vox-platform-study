/**
 * @arcaai/noise-filter - RNNoiseProcessor
 *
 * Low-level wrapper for RNNoise WebAssembly module.
 * Handles frame buffering and processing.
 */

import type { NoiseCancellationLevel, RNNoiseResult, NoiseFilterStats } from '../types/index.js';

/**
 * Frame size expected by RNNoise (480 samples = 10ms at 48kHz).
 */
export const RNNOISE_FRAME_SIZE = 480;

/**
 * Sample rate expected by RNNoise.
 */
export const RNNOISE_SAMPLE_RATE = 48000;

/**
 * Noise attenuation multipliers for different levels.
 */
const LEVEL_MULTIPLIERS: Record<NoiseCancellationLevel, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

/**
 * RNNoiseProcessor provides low-level RNNoise WASM integration.
 *
 * This class handles:
 * - Loading and initializing the RNNoise WASM module
 * - Frame buffering (converting 128-sample blocks to 480-sample frames)
 * - Processing audio through RNNoise
 * - Tracking statistics
 */
export class RNNoiseProcessor {
  private wasmModule: WebAssembly.Module | null = null;
  private wasmInstance: WebAssembly.Instance | null = null;
  private denoiseState: number = 0;
  private memory: WebAssembly.Memory | null = null;

  // Frame buffer for accumulating samples
  private inputBuffer: Float32Array;
  private outputBuffer: Float32Array;
  private bufferIndex = 0;

  // Processing state
  private _isInitialized = false;
  private _enabled = true;
  private _level: NoiseCancellationLevel = 'medium';

  // Statistics
  private framesProcessed = 0;
  private framesDropped = 0;
  private lastVadProbability = 0;
  private processingStartTime = 0;
  private totalProcessingTime = 0;

  constructor() {
    this.inputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.outputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
  }

  /**
   * Check if the processor is initialized.
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Check if processing is enabled.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Get current noise cancellation level.
   */
  get level(): NoiseCancellationLevel {
    return this._level;
  }

  /**
   * Initialize the RNNoise WASM module.
   *
   * @param wasmBinary - Optional pre-loaded WASM binary
   */
  async init(wasmBinary?: ArrayBuffer): Promise<void> {
    if (this._isInitialized) {
      return;
    }

    try {
      // Load WASM module
      if (wasmBinary) {
        this.wasmModule = await WebAssembly.compile(wasmBinary);
      } else {
        // Dynamically import the rnnoise-wasm package
        const { Rnnoise } = await import('@jitsi/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();

        // Create denoise state using the library's API
        const state = rnnoise.createDenoiseState();

        // Store reference for cleanup
        (this as unknown as { _rnnoiseLib: typeof rnnoise })._rnnoiseLib = rnnoise;
        (this as unknown as { _denoiseState: typeof state })._denoiseState = state;

        this._isInitialized = true;
        return;
      }

      // Instantiate WASM with memory
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

      this.wasmInstance = await WebAssembly.instantiate(this.wasmModule, importObject);

      // Get exported functions
      const exports = this.wasmInstance.exports as {
        rnnoise_create: () => number;
        rnnoise_process_frame: (state: number, output: number, input: number) => number;
        rnnoise_destroy: (state: number) => void;
        malloc: (size: number) => number;
        free: (ptr: number) => void;
      };

      // Create denoise state
      this.denoiseState = exports.rnnoise_create();

      this._isInitialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize RNNoise: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Process audio samples through RNNoise.
   *
   * @param input - Input audio samples (any length)
   * @param output - Output buffer for processed samples (same length as input)
   * @returns Processing result with VAD probability
   */
  process(input: Float32Array, output: Float32Array): RNNoiseResult {
    if (!this._isInitialized) {
      // Pass through if not initialized
      output.set(input);
      return { samples: output, vadProbability: 0 };
    }

    if (!this._enabled) {
      // Pass through if disabled
      output.set(input);
      return { samples: output, vadProbability: this.lastVadProbability };
    }

    this.processingStartTime = performance.now();

    let outputIndex = 0;
    let vadProbability = 0;

    // Process input samples, buffering to RNNOISE_FRAME_SIZE
    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.bufferIndex] = input[i]!;
      this.bufferIndex++;

      // When buffer is full, process the frame
      if (this.bufferIndex >= RNNOISE_FRAME_SIZE) {
        vadProbability = this.processFrame(this.inputBuffer, this.outputBuffer);

        // Copy processed samples to output
        const copyLength = Math.min(RNNOISE_FRAME_SIZE, output.length - outputIndex);
        for (let j = 0; j < copyLength; j++) {
          output[outputIndex + j] = this.outputBuffer[j]!;
        }
        outputIndex += copyLength;

        this.bufferIndex = 0;
        this.framesProcessed++;
      }
    }

    // Handle remaining samples in buffer (output zeros or pass through)
    while (outputIndex < output.length) {
      output[outputIndex] = 0;
      outputIndex++;
    }

    this.lastVadProbability = vadProbability;
    this.totalProcessingTime += performance.now() - this.processingStartTime;

    return { samples: output, vadProbability };
  }

  /**
   * Process a single RNNoise frame (480 samples).
   *
   * @param input - Input frame (480 samples)
   * @param output - Output frame (480 samples)
   * @returns VAD probability (0-1)
   */
  private processFrame(input: Float32Array, output: Float32Array): number {
    // Check if using the library API
    const libState = (this as unknown as { _denoiseState?: { processFrame: (frame: Float32Array) => number } })._denoiseState;

    if (libState) {
      // Use library's processFrame method
      // Clone input to avoid mutation
      const processedFrame = new Float32Array(input);
      const vadProb = libState.processFrame(processedFrame);

      // Apply level multiplier
      const multiplier = LEVEL_MULTIPLIERS[this._level];
      for (let i = 0; i < processedFrame.length; i++) {
        output[i] = input[i]! * (1 - multiplier) + processedFrame[i]! * multiplier;
      }

      return vadProb;
    }

    // Fallback to direct WASM calls
    if (!this.wasmInstance || !this.memory) {
      output.set(input);
      return 0;
    }

    const exports = this.wasmInstance.exports as {
      rnnoise_process_frame: (state: number, output: number, input: number) => number;
      malloc: (size: number) => number;
      free: (ptr: number) => void;
    };

    // Allocate memory for input/output
    const inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
    const outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);

    // Copy input to WASM memory
    const inputView = new Float32Array(this.memory.buffer, inputPtr, RNNOISE_FRAME_SIZE);
    inputView.set(input);

    // Process frame
    const vadProb = exports.rnnoise_process_frame(this.denoiseState, outputPtr, inputPtr);

    // Copy output from WASM memory
    const outputView = new Float32Array(this.memory.buffer, outputPtr, RNNOISE_FRAME_SIZE);

    // Apply level multiplier
    const multiplier = LEVEL_MULTIPLIERS[this._level];
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      output[i] = input[i]! * (1 - multiplier) + outputView[i]! * multiplier;
    }

    // Free memory
    exports.free(inputPtr);
    exports.free(outputPtr);

    return vadProb;
  }

  /**
   * Enable or disable processing.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /**
   * Set noise cancellation level.
   */
  setLevel(level: NoiseCancellationLevel): void {
    this._level = level;
  }

  /**
   * Get current processing statistics.
   */
  getStats(): NoiseFilterStats {
    const avgProcessingTime = this.framesProcessed > 0 ? this.totalProcessingTime / this.framesProcessed : 0;

    // Estimate CPU load based on processing time vs frame duration
    const frameDurationMs = (RNNOISE_FRAME_SIZE / RNNOISE_SAMPLE_RATE) * 1000;
    const cpuLoad = Math.min(1, avgProcessingTime / frameDurationMs);

    return {
      isActive: this._enabled && this._isInitialized,
      noiseReductionDb: this._enabled ? 12 * LEVEL_MULTIPLIERS[this._level] : 0,
      vadProbability: this.lastVadProbability,
      latencyMs: (RNNOISE_FRAME_SIZE / RNNOISE_SAMPLE_RATE) * 1000,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      cpuLoad,
      timestamp: Date.now(),
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.framesProcessed = 0;
    this.framesDropped = 0;
    this.totalProcessingTime = 0;
  }

  /**
   * Destroy the processor and free resources.
   */
  destroy(): void {
    // Clean up library state if used
    const libState = (this as unknown as { _denoiseState?: { destroy: () => void } })._denoiseState;
    if (libState) {
      libState.destroy();
      (this as unknown as { _denoiseState: undefined })._denoiseState = undefined;
      (this as unknown as { _rnnoiseLib: undefined })._rnnoiseLib = undefined;
    }

    // Clean up WASM state
    if (this.wasmInstance && this.denoiseState) {
      try {
        const exports = this.wasmInstance.exports as {
          rnnoise_destroy: (state: number) => void;
        };
        exports.rnnoise_destroy(this.denoiseState);
      } catch {
        // Ignore cleanup errors
      }
    }

    this.wasmModule = null;
    this.wasmInstance = null;
    this.denoiseState = 0;
    this.memory = null;
    this._isInitialized = false;

    // Clear buffers
    this.inputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.outputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.bufferIndex = 0;
  }
}
