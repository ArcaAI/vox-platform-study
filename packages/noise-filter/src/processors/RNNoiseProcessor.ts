/**
 * @arcaai/noise-filter - RNNoiseProcessor
 *
 * Low-level wrapper for RNNoise WebAssembly module.
 * Handles frame buffering, allocator-free processing, and a one-frame
 * ring buffer so the audio output is gap-free for any input quantum size.
 *
 * Design constraints:
 *  - WASM I/O buffers are allocated once at `init()` and freed at
 *    `destroy()` — never on the audio-thread hot path.
 *  - WASM is instantiated through the official upstream loader
 *    (`createRNNWasmModule`) via `rnnoiseModule.ts`.
 *  - Output is produced via a 2×FRAME_SIZE ring buffer that is
 *    pre-filled with one priming frame; subsequent samples never include
 *    spurious silence gaps regardless of input quantum size.
 *  - `process(input, output)` accepts `Float32Array<ArrayBufferLike>`
 *    so consumers of both `AudioWorklet` inputs and `WebAssembly.Memory`
 *    views compile under TS strict mode.
 */

import type { NoiseCancellationLevel, RNNoiseResult, NoiseFilterStats } from '../types/index.js';
import { createRnnoiseModule, type RnnoiseModule } from './rnnoiseModule.js';

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
 * Audio buffer alias: matches both `Float32Array` views over `ArrayBuffer`
 * (WASM memory) and over `ArrayBufferLike` (AudioWorklet quanta).
 */
type AudioBuffer = Float32Array<ArrayBufferLike>;

export class RNNoiseProcessor {
  private module: RnnoiseModule | null = null;
  private denoiseState = 0;

  // Preallocated WASM I/O pointers (CRIT-1).
  private inputPtr = 0;
  private outputPtr = 0;

  // Frame accumulation buffer (per-call render quantum → 480-sample frames).
  private readonly inputBuffer: Float32Array<ArrayBuffer>;
  private bufferIndex = 0;

  // Output ring buffer (HIGH-1): capacity = 2 × frame size so we can always
  // hold one freshly-processed frame ahead of the consumer.
  private readonly outputRing: Float32Array<ArrayBuffer>;
  private readonly outputRingCapacity = RNNOISE_FRAME_SIZE * 2;
  private outputRingRead = 0;
  private outputRingWrite = 0;
  private outputRingSize = 0;

  // Processing state
  private _isInitialized = false;
  private _enabled = true;
  private _level: NoiseCancellationLevel = 'medium';

  // Statistics
  private framesProcessed = 0;
  private framesDropped = 0;
  private lastVadProbability = 0;
  private totalProcessingTime = 0;

  constructor() {
    this.inputBuffer = new Float32Array(new ArrayBuffer(RNNOISE_FRAME_SIZE * 4));
    this.outputRing = new Float32Array(new ArrayBuffer(this.outputRingCapacity * 4));
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get level(): NoiseCancellationLevel {
    return this._level;
  }

  /**
   * Initialize the RNNoise WASM module via the official upstream loader.
   *
   * @param wasmBinary - RNNoise WASM binary (e.g. fetched from the bundled
   *   `assets/rnnoise.wasm`).
   */
  async init(wasmBinary: ArrayBuffer): Promise<void> {
    if (this._isInitialized) {
      return;
    }

    try {
      this.module = await createRnnoiseModule({ wasmBinary });
      this.denoiseState = this.module.rnnoise_create();
      this.inputPtr = this.module.malloc(RNNOISE_FRAME_SIZE * 4);
      this.outputPtr = this.module.malloc(RNNOISE_FRAME_SIZE * 4);
      this._isInitialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize RNNoise: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Process audio samples through RNNoise.
   *
   * Accepts any input length; accumulates samples into 480-sample frames,
   * runs the WASM denoiser without per-frame allocation, and dispenses
   * processed samples through a ring buffer that incurs a fixed one-frame
   * priming latency but is gap-free thereafter.
   */
  process(input: AudioBuffer, output: AudioBuffer): RNNoiseResult {
    if (!this._isInitialized || !this.module) {
      output.set(input);
      return { samples: output, vadProbability: 0 };
    }

    if (!this._enabled) {
      output.set(input);
      return { samples: output, vadProbability: this.lastVadProbability };
    }

    const startTime = performance.now();
    let vadProbability = this.lastVadProbability;

    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.bufferIndex++] = input[i]!;

      if (this.bufferIndex >= RNNOISE_FRAME_SIZE) {
        vadProbability = this.processFrame();
        this.bufferIndex = 0;
      }

      if (this.outputRingSize > 0) {
        output[i] = this.outputRing[this.outputRingRead]!;
        this.outputRingRead = (this.outputRingRead + 1) % this.outputRingCapacity;
        this.outputRingSize--;
      } else {
        output[i] = 0;
      }
    }

    this.lastVadProbability = vadProbability;
    this.totalProcessingTime += performance.now() - startTime;
    return { samples: output, vadProbability };
  }

  /**
   * Run RNNoise on the currently-accumulated frame and enqueue the result
   * into the output ring buffer. The result is mixed with the dry input
   * according to the current level multiplier.
   */
  private processFrame(): number {
    if (!this.module) return 0;

    const { heapF32 } = this.module;
    const inputView = heapF32.subarray(this.inputPtr / 4, this.inputPtr / 4 + RNNOISE_FRAME_SIZE);
    inputView.set(this.inputBuffer);

    const vad = this.module.rnnoise_process_frame(this.denoiseState, this.outputPtr, this.inputPtr);

    const outputView = heapF32.subarray(this.outputPtr / 4, this.outputPtr / 4 + RNNOISE_FRAME_SIZE);

    const multiplier = LEVEL_MULTIPLIERS[this._level];
    const dryGain = 1 - multiplier;
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      const sample = this.inputBuffer[i]! * dryGain + outputView[i]! * multiplier;
      if (this.outputRingSize >= this.outputRingCapacity) {
        // Ring overflow: consumer fell behind. Drop oldest sample to keep
        // the head moving and increment the dropped-frame counter.
        this.outputRingRead = (this.outputRingRead + 1) % this.outputRingCapacity;
        this.outputRingSize--;
        this.framesDropped++;
      }
      this.outputRing[this.outputRingWrite] = sample;
      this.outputRingWrite = (this.outputRingWrite + 1) % this.outputRingCapacity;
      this.outputRingSize++;
    }

    this.framesProcessed++;
    return vad;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  setLevel(level: NoiseCancellationLevel): void {
    this._level = level;
  }

  getStats(): NoiseFilterStats {
    const avgProcessingTime = this.framesProcessed > 0 ? this.totalProcessingTime / this.framesProcessed : 0;
    const frameDurationMs = (RNNOISE_FRAME_SIZE / RNNOISE_SAMPLE_RATE) * 1000;
    const cpuLoad = Math.min(1, avgProcessingTime / frameDurationMs);

    return {
      isActive: this._enabled && this._isInitialized,
      noiseReductionDb: this._enabled ? 12 * LEVEL_MULTIPLIERS[this._level] : 0,
      vadProbability: this.lastVadProbability,
      latencyMs: frameDurationMs,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      cpuLoad,
      timestamp: Date.now(),
    };
  }

  resetStats(): void {
    this.framesProcessed = 0;
    this.framesDropped = 0;
    this.totalProcessingTime = 0;
  }

  destroy(): void {
    if (this.module) {
      try {
        if (this.inputPtr) this.module.free(this.inputPtr);
        if (this.outputPtr) this.module.free(this.outputPtr);
        if (this.denoiseState) this.module.rnnoise_destroy(this.denoiseState);
      } catch {
        // Best-effort cleanup; the underlying module may already be torn down.
      }
    }

    this.module = null;
    this.denoiseState = 0;
    this.inputPtr = 0;
    this.outputPtr = 0;
    this._isInitialized = false;

    this.bufferIndex = 0;
    this.outputRingRead = 0;
    this.outputRingWrite = 0;
    this.outputRingSize = 0;
  }
}
