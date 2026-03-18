/**
 * @arcaai/noise-filter - RNNoise AudioWorklet Processor
 *
 * AudioWorklet processor for real-time noise cancellation using RNNoise.
 * This runs in a separate thread for low-latency audio processing.
 */

import type {
  NoiseCancellationLevel,
  NoiseFilterStats,
  WorkletInboundMessage,
  WorkletOutboundMessage,
} from '../types/index.js';

/**
 * Frame size expected by RNNoise (480 samples = 10ms at 48kHz).
 */
const RNNOISE_FRAME_SIZE = 480;

/**
 * AudioWorklet render quantum size (128 samples per process call).
 */
const RENDER_QUANTUM = 128;

/**
 * Noise attenuation multipliers for different levels.
 */
const LEVEL_MULTIPLIERS: Record<NoiseCancellationLevel, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

/**
 * RNNoise AudioWorklet Processor
 *
 * Processes audio in real-time using RNNoise WASM for noise cancellation.
 * Accumulates 128-sample render quanta into 480-sample frames for RNNoise.
 */
class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  // Processing state
  private initialized = false;
  private enabled = true;
  private level: NoiseCancellationLevel = 'medium';

  // RNNoise WASM state
  private wasmInstance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;
  private denoiseState = 0;

  // Input buffering (accumulate to RNNOISE_FRAME_SIZE)
  private inputBuffer: Float32Array;
  private inputBufferIndex = 0;

  // Output buffering (dispense processed samples)
  private outputBuffer: Float32Array;
  private outputBufferIndex = 0;
  private outputBufferFilled = 0;

  // Statistics
  private framesProcessed = 0;
  private lastVadProbability = 0;
  private processingTimeSum = 0;

  constructor() {
    super();

    this.inputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
    this.outputBuffer = new Float32Array(RNNOISE_FRAME_SIZE);

    // Handle messages from main thread
    this.port.onmessage = (event: MessageEvent<WorkletInboundMessage>) => {
      this.handleMessage(event.data);
    };
  }

  /**
   * Handle messages from the main thread.
   */
  private handleMessage(message: WorkletInboundMessage): void {
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

  /**
   * Initialize the RNNoise WASM module.
   */
  private async initWasm(wasmBinary: ArrayBuffer): Promise<void> {
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

      // Create denoise state
      const exports = this.wasmInstance.exports as {
        rnnoise_create: () => number;
      };
      this.denoiseState = exports.rnnoise_create();

      this.initialized = true;

      this.sendMessage({ type: 'ready' });
    } catch (error) {
      this.sendMessage({
        type: 'error',
        message: `WASM init failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  /**
   * Process audio data (called by AudioWorklet runtime).
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) {
      return true;
    }

    // If not initialized or disabled, pass through
    if (!this.initialized || !this.enabled || !this.wasmInstance) {
      output.set(input);
      return true;
    }

    const startTime = performance.now();

    // Process input samples
    for (let i = 0; i < input.length; i++) {
      // If we have processed output available, use it
      if (this.outputBufferIndex < this.outputBufferFilled) {
        output[i] = this.outputBuffer[this.outputBufferIndex]!;
        this.outputBufferIndex++;
      } else {
        // No processed output yet, output silence or delayed sample
        output[i] = 0;
      }

      // Accumulate input
      this.inputBuffer[this.inputBufferIndex] = input[i]!;
      this.inputBufferIndex++;

      // When we have a full frame, process it
      if (this.inputBufferIndex >= RNNOISE_FRAME_SIZE) {
        this.processRNNoiseFrame();
        this.inputBufferIndex = 0;
      }
    }

    this.processingTimeSum += performance.now() - startTime;

    return true;
  }

  /**
   * Process a full RNNoise frame (480 samples).
   */
  private processRNNoiseFrame(): void {
    if (!this.wasmInstance || !this.memory) {
      return;
    }

    const exports = this.wasmInstance.exports as {
      rnnoise_process_frame: (state: number, output: number, input: number) => number;
      malloc: (size: number) => number;
      free: (ptr: number) => void;
    };

    // Allocate memory for input/output
    const inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
    const outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);

    try {
      // Copy input to WASM memory
      const inputView = new Float32Array(
        this.memory.buffer,
        inputPtr,
        RNNOISE_FRAME_SIZE
      );
      inputView.set(this.inputBuffer);

      // Process frame
      this.lastVadProbability = exports.rnnoise_process_frame(
        this.denoiseState,
        outputPtr,
        inputPtr
      );

      // Copy output from WASM memory
      const outputView = new Float32Array(
        this.memory.buffer,
        outputPtr,
        RNNOISE_FRAME_SIZE
      );

      // Apply level multiplier and mix
      const multiplier = LEVEL_MULTIPLIERS[this.level];
      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        this.outputBuffer[i] =
          this.inputBuffer[i]! * (1 - multiplier) + outputView[i]! * multiplier;
      }

      this.outputBufferIndex = 0;
      this.outputBufferFilled = RNNOISE_FRAME_SIZE;
      this.framesProcessed++;
    } finally {
      // Free memory
      exports.free(inputPtr);
      exports.free(outputPtr);
    }
  }

  /**
   * Send processing statistics to main thread.
   */
  private sendStats(): void {
    const avgProcessingTime =
      this.framesProcessed > 0
        ? this.processingTimeSum / this.framesProcessed
        : 0;

    const frameDurationMs = (RNNOISE_FRAME_SIZE / sampleRate) * 1000;
    const cpuLoad = Math.min(1, avgProcessingTime / frameDurationMs);

    const stats: NoiseFilterStats = {
      isActive: this.enabled && this.initialized,
      noiseReductionDb: this.enabled ? 12 * LEVEL_MULTIPLIERS[this.level] : 0,
      vadProbability: this.lastVadProbability,
      latencyMs: frameDurationMs,
      framesProcessed: this.framesProcessed,
      framesDropped: 0,
      cpuLoad,
      timestamp: Date.now(),
    };

    this.sendMessage({ type: 'stats', stats });
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
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

    this.wasmInstance = null;
    this.memory = null;
    this.denoiseState = 0;
    this.initialized = false;

    this.sendMessage({ type: 'destroyed' });
  }

  /**
   * Send a message to the main thread.
   */
  private sendMessage(message: WorkletOutboundMessage): void {
    this.port.postMessage(message);
  }
}

// Register the worklet processor
registerProcessor('rnnoise-worklet-processor', RNNoiseWorkletProcessor);
