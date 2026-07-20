/**
 * @arcaai/noise-filter - RNNoise AudioWorklet Processor
 *
 * AudioWorklet processor for real-time noise cancellation using RNNoise.
 * This runs in a separate thread for low-latency audio processing.
 *
 * TASK-269:
 *  - CRIT-1: WASM I/O buffers are preallocated once at init and reused for
 *    the lifetime of the processor.
 *  - CRIT-3: The WASM is instantiated with the import object the
 *    `@jitsi/rnnoise-wasm@0.2.1` binary actually expects
 *    (`{ a: { a: resize_heap, b: memcpy_big } }`) and exports are read by
 *    their stable single-letter names. Mirror of `workletRnnoiseLoader.ts`.
 *  - HIGH-1: Output ring buffer with one frame priming latency; no gaps.
 *
 * NOTE: This TS source compiles to `dist/worklets/rnnoise.worklet.js` for
 * consumers who load the worklet via `audioContext.audioWorklet.addModule`
 * directly. The runtime blob URL used by the package itself is built from
 * the inline string in `worklets/worklet-loader.ts`; the two must stay
 * algorithmically identical (see MED-8 in 05-noise-filter.md — deferred).
 */

import type { NoiseCancellationLevel, NoiseFilterStats, WorkletInboundMessage, WorkletOutboundMessage } from '../types/index.js';

const RNNOISE_FRAME_SIZE = 480;

const LEVEL_MULTIPLIERS: Record<NoiseCancellationLevel, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

interface RnnoiseExports {
  c: WebAssembly.Memory;
  d: () => void;
  e: (state: number) => number;
  f: () => number;
  g: (size: number) => number;
  h: (state: number) => void;
  i: (ptr: number) => void;
  j: (state: number, output: number, input: number) => number;
}

class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  private initialized = false;
  private enabled = true;
  private level: NoiseCancellationLevel = 'medium';

  // WASM instance + preallocated I/O (CRIT-1).
  private wasmInstance: WebAssembly.Instance | null = null;
  private wasmExports: RnnoiseExports | null = null;
  private memory: WebAssembly.Memory | null = null;
  private heapU8: Uint8Array<ArrayBuffer> | null = null;
  private heapF32: Float32Array<ArrayBuffer> | null = null;
  private denoiseState = 0;
  private inputPtr = 0;
  private outputPtr = 0;

  // Input frame accumulation.
  private readonly inputBuffer: Float32Array<ArrayBuffer>;
  private inputBufferIndex = 0;

  // Output ring buffer (HIGH-1): capacity = 2 × frame size.
  private readonly outputRing: Float32Array<ArrayBuffer>;
  private readonly outputRingCapacity = RNNOISE_FRAME_SIZE * 2;
  private outputRingRead = 0;
  private outputRingWrite = 0;
  private outputRingSize = 0;

  // Statistics
  private framesProcessed = 0;
  private framesDropped = 0;
  private lastVadProbability = 0;
  private processingTimeSum = 0;

  constructor() {
    super();
    this.inputBuffer = new Float32Array(new ArrayBuffer(RNNOISE_FRAME_SIZE * 4));
    this.outputRing = new Float32Array(new ArrayBuffer(this.outputRingCapacity * 4));

    this.port.onmessage = (event: MessageEvent<WorkletInboundMessage>) => {
      this.handleMessage(event.data);
    };
  }

  private handleMessage(message: WorkletInboundMessage): void {
    switch (message.type) {
      case 'init':
        this.initWasm(message.wasmBinary).catch((err) => {
          this.sendMessage({
            type: 'error',
            message: `WASM init failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
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

  /**
   * Refresh `heapU8`/`heapF32` after memory growth (`emscripten_resize_heap`).
   */
  private refreshViews(): void {
    if (!this.memory) return;
    this.heapU8 = new Uint8Array(this.memory.buffer);
    this.heapF32 = new Float32Array(this.memory.buffer);
  }

  private async initWasm(wasmBinary: ArrayBuffer): Promise<void> {
    const memcpyBig = (dest: number, src: number, num: number): void => {
      this.heapU8!.copyWithin(dest, src, src + num);
    };
    const resizeHeap = (requestedSize: number): 0 | 1 => {
      try {
        const oldSize = this.memory!.buffer.byteLength;
        const requested = requestedSize >>> 0;
        const delta = Math.max(0, Math.ceil((requested - oldSize) / 65536));
        this.memory!.grow(delta);
        this.refreshViews();
        return 1;
      } catch {
        return 0;
      }
    };

    const importObject = { a: { a: resizeHeap, b: memcpyBig } };
    const { instance } = await WebAssembly.instantiate(wasmBinary, importObject);
    this.wasmInstance = instance;
    this.wasmExports = instance.exports as unknown as RnnoiseExports;
    this.memory = this.wasmExports.c;
    this.refreshViews();
    this.wasmExports.d();

    this.denoiseState = this.wasmExports.f();
    this.inputPtr = this.wasmExports.g(RNNOISE_FRAME_SIZE * 4);
    this.outputPtr = this.wasmExports.g(RNNOISE_FRAME_SIZE * 4);

    this.initialized = true;
    this.sendMessage({ type: 'ready' });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) {
      return true;
    }

    if (!this.initialized || !this.enabled || !this.wasmExports) {
      output.set(input);
      return true;
    }

    const startTime = performance.now();

    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputBufferIndex++] = input[i]!;
      if (this.inputBufferIndex >= RNNOISE_FRAME_SIZE) {
        this.processRNNoiseFrame();
        this.inputBufferIndex = 0;
      }

      if (this.outputRingSize > 0) {
        output[i] = this.outputRing[this.outputRingRead]!;
        this.outputRingRead = (this.outputRingRead + 1) % this.outputRingCapacity;
        this.outputRingSize--;
      } else {
        output[i] = 0;
      }
    }

    this.processingTimeSum += performance.now() - startTime;
    return true;
  }

  private processRNNoiseFrame(): void {
    if (!this.wasmExports || !this.heapF32) return;

    const inputView = this.heapF32.subarray(this.inputPtr / 4, this.inputPtr / 4 + RNNOISE_FRAME_SIZE);
    inputView.set(this.inputBuffer);

    this.lastVadProbability = this.wasmExports.j(this.denoiseState, this.outputPtr, this.inputPtr);

    const outputView = this.heapF32.subarray(this.outputPtr / 4, this.outputPtr / 4 + RNNOISE_FRAME_SIZE);
    const multiplier = LEVEL_MULTIPLIERS[this.level];
    const dryGain = 1 - multiplier;
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      const sample = this.inputBuffer[i]! * dryGain + outputView[i]! * multiplier;
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

  private sendStats(): void {
    const avgProcessingTime = this.framesProcessed > 0 ? this.processingTimeSum / this.framesProcessed : 0;
    const frameDurationMs = (RNNOISE_FRAME_SIZE / sampleRate) * 1000;
    const cpuLoad = Math.min(1, avgProcessingTime / frameDurationMs);

    const stats: NoiseFilterStats = {
      isActive: this.enabled && this.initialized,
      noiseReductionDb: this.enabled ? 12 * LEVEL_MULTIPLIERS[this.level] : 0,
      vadProbability: this.lastVadProbability,
      latencyMs: frameDurationMs,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      cpuLoad,
      timestamp: Date.now(),
    };

    this.sendMessage({ type: 'stats', stats });
  }

  private cleanup(): void {
    if (this.wasmExports) {
      try {
        if (this.inputPtr) this.wasmExports.i(this.inputPtr);
        if (this.outputPtr) this.wasmExports.i(this.outputPtr);
        if (this.denoiseState) this.wasmExports.h(this.denoiseState);
      } catch {
        // Best-effort cleanup.
      }
    }

    this.wasmInstance = null;
    this.wasmExports = null;
    this.memory = null;
    this.heapU8 = null;
    this.heapF32 = null;
    this.denoiseState = 0;
    this.inputPtr = 0;
    this.outputPtr = 0;
    this.initialized = false;

    this.sendMessage({ type: 'destroyed' });
  }

  private sendMessage(message: WorkletOutboundMessage): void {
    this.port.postMessage(message);
  }
}

registerProcessor('rnnoise-worklet-processor', RNNoiseWorkletProcessor);
