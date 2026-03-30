/**
 * @arcaai/stt - WhisperWorkerEngine
 *
 * Whisper engine that runs ML inference in a Web Worker.
 * This prevents blocking the main thread during transcription,
 * keeping the UI responsive.
 *
 * Falls back to main thread execution if Workers are not available.
 */

import type { TranscriptionResult, ComputeDevice, ModelLoadProgress } from '../types/index.js';
import { getLanguageCode } from '../types/index.js';
import type { EngineConfig, TranscribeOptions, EngineStats } from './types.js';
import { BaseEngine } from './BaseEngine.js';
import { isWebGPUSupported, isWebAssemblySupported } from '../utils/browserSupport.js';

/**
 * Worker message types for communication.
 */
interface WorkerRequest {
  type: 'init' | 'transcribe' | 'destroy';
  id: string;
  payload: unknown;
}

interface WorkerResponse {
  type: 'ready' | 'progress' | 'result' | 'error';
  id: string;
  payload: unknown;
}

/**
 * Pending request waiting for worker response.
 */
interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Check if Web Workers are available.
 */
function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * WhisperWorkerEngine - runs Whisper in a dedicated Web Worker.
 *
 * Benefits:
 * - Non-blocking transcription (UI stays responsive)
 * - Better performance for long audio files
 * - Automatic fallback to main thread if Workers unavailable
 *
 * @example
 * ```typescript
 * const engine = new WhisperWorkerEngine();
 *
 * await engine.init({
 *   model: 'tiny',
 *   language: 'en',
 *   device: 'auto',
 *   quantized: true,
 * });
 *
 * // Transcription runs in worker - UI stays responsive
 * const result = await engine.transcribe(audioSamples);
 * console.log(result.text);
 *
 * await engine.destroy();
 * ```
 */
export class WhisperWorkerEngine extends BaseEngine {
  readonly name = 'whisper-worker';

  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private actualDevice: ComputeDevice = 'wasm';
  private workerSupported: boolean;

  constructor() {
    super();
    this.workerSupported = isWorkerSupported();
  }

  isSupported(): boolean {
    // Requires WebAssembly at minimum, Workers are optional (fallback available)
    return isWebAssemblySupported();
  }

  /**
   * Check if this engine will use a Web Worker.
   */
  usesWorker(): boolean {
    return this.workerSupported;
  }

  async init(config: EngineConfig): Promise<void> {
    this.config = config;
    const startTime = performance.now();

    this.actualDevice = this.resolveDevice(config.device);

    const modelId = config.modelPath ?? this.getModelId(config.model, config.language, config.quantized, config.returnTimestamps);

    if (this.initialized && this.worker) {
      await this.reinitExistingWorker(modelId, config);
      this.modelLoadTimeMs = performance.now() - startTime;
      return;
    }

    if (this.initialized) {
      await this.destroy();
    }

    if (this.workerSupported) {
      await this.initWithWorker(modelId, config);
    } else {
      console.warn('[WhisperWorkerEngine] Web Workers not available, falling back to main thread');
      await this.initMainThread(modelId, config);
    }

    this.modelLoadTimeMs = performance.now() - startTime;
    this.initialized = true;
  }

  /**
   * Initialize using a Web Worker.
   */
  private async initWithWorker(modelId: string, config: EngineConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Path is relative to dist/index.mjs after tsup bundles everything into dist/
        this.worker = new Worker(new URL('./workers/whisper.worker.mjs', import.meta.url), { type: 'module' });

        // Set up message handler
        this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          this.handleWorkerMessage(event.data);
        };

        this.worker.onerror = (error) => {
          console.error('[WhisperWorkerEngine] Worker error:', error);
          const pending = this.pendingRequests.values().next().value;
          if (pending) {
            pending.reject(new Error(`Worker error: ${error.message}`));
          }
        };

        // Send init message
        const requestId = generateRequestId();

        this.pendingRequests.set(requestId, {
          resolve: (value) => {
            const initPayload = value as { device?: 'webgpu' | 'wasm' };
            if (initPayload.device) {
              this.actualDevice = initPayload.device;
            }
            resolve();
          },
          reject: (error) => reject(error),
        });

        // Set up progress forwarding
        const progressHandler = (response: WorkerResponse) => {
          if (response.type === 'progress') {
            config.onProgress?.(response.payload as ModelLoadProgress);
          }
        };

        // Temporarily store progress handler
        (this as unknown as { _progressHandler: typeof progressHandler })._progressHandler = progressHandler;

        this.worker.postMessage({
          type: 'init',
          id: requestId,
          payload: {
            modelId,
            device: this.actualDevice === 'webgpu' ? 'webgpu' : undefined,
            language: getLanguageCode(config.language),
            codeSwitching: config.codeSwitching ?? false,
            chunkLengthS: config.chunkLengthS,
            overlapLengthS: config.overlapLengthS,
            returnTimestamps: config.returnTimestamps,
          },
        } as WorkerRequest);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Re-initialize by sending an init message to the existing worker.
   * The worker will reuse the loaded pipeline if the model hasn't changed.
   */
  private async reinitExistingWorker(modelId: string, config: EngineConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = generateRequestId();

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          const initPayload = value as { device?: 'webgpu' | 'wasm' };
          if (initPayload.device) {
            this.actualDevice = initPayload.device;
          }
          resolve();
        },
        reject: (error) => reject(error),
      });

      const progressHandler = (response: WorkerResponse) => {
        if (response.type === 'progress') {
          config.onProgress?.(response.payload as ModelLoadProgress);
        }
      };
      (this as unknown as { _progressHandler: typeof progressHandler })._progressHandler = progressHandler;

      this.worker!.postMessage({
        type: 'init',
        id: requestId,
        payload: {
          modelId,
          device: this.actualDevice === 'webgpu' ? 'webgpu' : undefined,
          language: getLanguageCode(config.language),
          codeSwitching: config.codeSwitching ?? false,
          chunkLengthS: config.chunkLengthS,
          overlapLengthS: config.overlapLengthS,
          returnTimestamps: config.returnTimestamps,
        },
      } as WorkerRequest);
    });
  }

  /**
   * Fallback: Initialize on main thread using WhisperEngine.
   */
  private async initMainThread(_modelId: string, config: EngineConfig): Promise<void> {
    // Dynamically import the main-thread WhisperEngine
    const { WhisperEngine } = await import('./WhisperEngine.js');
    const mainThreadEngine = new WhisperEngine();

    await mainThreadEngine.init(config);

    // Store reference for fallback transcription
    (this as unknown as { _mainThreadEngine: typeof mainThreadEngine })._mainThreadEngine = mainThreadEngine;
  }

  /**
   * Handle messages from the worker.
   */
  private handleWorkerMessage(response: WorkerResponse): void {
    const { type, id, payload } = response;

    // Handle progress messages specially
    if (type === 'progress') {
      const progressHandler = (this as unknown as { _progressHandler?: (r: WorkerResponse) => void })._progressHandler;
      progressHandler?.(response);
      return;
    }

    // Find and resolve/reject the pending request
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      console.warn('[WhisperWorkerEngine] Received response for unknown request:', id);
      return;
    }

    this.pendingRequests.delete(id);

    if (type === 'error') {
      const errorPayload = payload as { message: string; stack?: string };
      const rawMessage = errorPayload.message;

      // ONNX Runtime WASM throws raw numeric C++ exception codes (e.g. "17248032").
      // Wrap them in a descriptive message so callers get actionable context.
      const isOnnxNumericError = /^\d+$/.test(rawMessage);
      const message = isOnnxNumericError
        ? `ONNX Runtime model loading failed (code: ${rawMessage}). ` +
          'The worker already retried with a fresh cache and backend fallback when possible. ' +
          'Try switching Local AI to WASM and/or using a smaller model, then reload.'
        : rawMessage;

      const error = new Error(message);
      if (errorPayload.stack) {
        error.stack = errorPayload.stack;
      }
      pending.reject(error);
    } else {
      pending.resolve(payload);
    }
  }

  async transcribe(audio: Float32Array, options?: TranscribeOptions): Promise<TranscriptionResult> {
    if (!this.config) {
      throw new Error('Engine not initialized. Call init() first.');
    }

    // Use main thread fallback if worker not available
    const mainThreadEngine = (this as unknown as { _mainThreadEngine?: BaseEngine })._mainThreadEngine;
    if (mainThreadEngine) {
      return mainThreadEngine.transcribe(audio, options);
    }

    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    this.transcribing = true;
    const startTime = performance.now();

    try {
      const result = await this.sendWorkerRequest<TranscriptionResult>('transcribe', {
        audio,
        options: {
          language: options?.language,
          returnTimestamps: options?.returnTimestamps,
        },
      });

      const latencyMs = performance.now() - startTime;
      this.recordTranscription(latencyMs);

      return result;
    } finally {
      this.transcribing = false;
    }
  }

  /**
   * Send a request to the worker and wait for response.
   */
  private sendWorkerRequest<T>(type: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const requestId = generateRequestId();

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.worker.postMessage({
        type,
        id: requestId,
        payload,
      } as WorkerRequest);
    });
  }

  async destroy(): Promise<void> {
    // Clean up main thread engine if used
    const mainThreadEngine = (this as unknown as { _mainThreadEngine?: BaseEngine })._mainThreadEngine;
    if (mainThreadEngine) {
      await mainThreadEngine.destroy();
      (this as unknown as { _mainThreadEngine?: BaseEngine })._mainThreadEngine = undefined;
    }

    // Clean up worker
    if (this.worker) {
      try {
        await this.sendWorkerRequest('destroy', null);
      } catch {
        // Ignore errors during destroy
      }

      this.worker.terminate();
      this.worker = null;
    }

    // Clear pending requests
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Engine destroyed'));
    }
    this.pendingRequests.clear();

    this.config = null;
    this.initialized = false;
    this.transcribing = false;
  }

  /**
   * Get the actual device being used.
   */
  getDevice(): ComputeDevice {
    return this.actualDevice;
  }

  /**
   * Get engine statistics including worker info.
   */
  override getStats(): EngineStats & { usesWorker: boolean } {
    return {
      ...super.getStats(),
      usesWorker: this.workerSupported && this.worker !== null,
    };
  }

  /**
   * Check if a model is cached in the browser's Cache API.
   * Requires the worker to be spawned (call after init, or spawn a temporary worker).
   */
  async checkModelCache(modelId: string): Promise<{ cached: boolean; files: number }> {
    if (!this.worker) {
      return { cached: false, files: 0 };
    }
    return this.sendWorkerRequest<{ cached: boolean; files: number }>('check-cache', { modelId });
  }

  /**
   * Resolve the device to use based on capabilities.
   */
  private resolveDevice(requestedDevice: ComputeDevice): ComputeDevice {
    if (requestedDevice === 'webgpu') {
      return isWebGPUSupported() ? 'webgpu' : 'wasm';
    }

    if (requestedDevice === 'auto') {
      return isWebGPUSupported() ? 'webgpu' : 'wasm';
    }

    return 'wasm';
  }
}
