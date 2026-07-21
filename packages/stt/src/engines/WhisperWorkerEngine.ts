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
import { getLanguageCode, STTError, STTErrorCode } from '../types/index.js';
import type { EngineConfig, TranscribeOptions, EngineStats } from './types.js';
import { BaseEngine } from './BaseEngine.js';
import { STTWorkerCrashError } from './errors.js';
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
/**
 * Crash-recovery tuning. Constructor-overridable so tests can shrink the
 * backoff schedule without exposing it as a public API.
 */
export interface WhisperWorkerEngineOptions {
  /**
   * Maximum number of restart attempts before further `transcribe()` calls
   * are rejected with `STTWorkerCrashError`.
   *
   * @default 3
   */
  maxCrashRetries?: number;

  /**
   * Base backoff in milliseconds. Each successive restart waits
   * `crashBackoffBaseMs * 2^(attempt - 1)`.
   *
   * @default 100
   */
  crashBackoffBaseMs?: number;
}

export class WhisperWorkerEngine extends BaseEngine {
  readonly name = 'whisper-worker';

  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private actualDevice: ComputeDevice = 'wasm';
  private workerSupported: boolean;

  // Crash recovery state. `crashRetryAttempts` resets on successful restart;
  // `crashPermanent` latches when retries are exhausted so subsequent
  // transcribe() calls reject early instead of hanging.
  private readonly maxCrashRetries: number;
  private readonly crashBackoffBaseMs: number;
  private crashRetryAttempts = 0;
  private crashPermanent = false;
  private destroyed = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WhisperWorkerEngineOptions = {}) {
    super();
    this.workerSupported = isWorkerSupported();
    this.maxCrashRetries = options.maxCrashRetries ?? 3;
    this.crashBackoffBaseMs = options.crashBackoffBaseMs ?? 100;
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
          this.handleWorkerCrash(error);
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
    if (this.crashPermanent) {
      throw new STTWorkerCrashError(this.maxCrashRetries);
    }

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

    // Capability gate before crossing the worker boundary so callers get a
    // synchronous, typed STTError instead of an opaque worker failure.
    // Mirrors WhisperEngine's check on the main-thread path.
    const task = options?.task ?? this.config.task;
    if (task === 'translate') {
      const modelId =
        this.config.modelPath ?? this.getModelId(this.config.model, this.config.language, this.config.quantized, this.config.returnTimestamps);
      if (modelId.endsWith('.en')) {
        throw new STTError(
          STTErrorCode.NOT_SUPPORTED,
          `English-only Whisper models cannot translate (model: ${modelId}). Use a multilingual checkpoint (e.g. Xenova/whisper-small).`,
        );
      }
    }

    this.transcribing = true;
    const startTime = performance.now();

    try {
      // Transfer the audio buffer (zero-copy). After this call the caller's
      // `audio` view is detached; callers must not reuse it. This avoids the
      // ~1.9 MB structured-clone per 30 s chunk that would otherwise occur on
      // every transcription.
      const result = await this.sendWorkerRequest<TranscriptionResult>(
        'transcribe',
        {
          audio,
          options: {
            language: options?.language,
            returnTimestamps: options?.returnTimestamps,
            prompt: options?.prompt,
            // Forward the resolved task (per-call override else engine-level
            // default) so the worker can pipe it to the pipeline.
            task,
          },
        },
        [audio.buffer],
      );

      const latencyMs = performance.now() - startTime;
      this.recordTranscription(latencyMs);

      return result;
    } finally {
      this.transcribing = false;
    }
  }

  /**
   * Send a request to the worker and wait for response.
   *
   * @param type - Worker message type.
   * @param payload - Request payload. If `transfer` is provided, the listed
   *   `ArrayBuffer`s are detached from the main thread to avoid a copy.
   * @param transfer - Optional transferable objects (e.g. audio `ArrayBuffer`s)
   *   handed to the worker by reference. The caller forfeits ownership of any
   *   buffer included here.
   */
  private sendWorkerRequest<T>(type: string, payload: unknown, transfer: Transferable[] = []): Promise<T> {
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

      this.worker.postMessage(
        {
          type,
          id: requestId,
          payload,
        } as WorkerRequest,
        transfer,
      );
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

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
   * Handle a worker crash (`worker.onerror` or unhandled worker exception).
   * Rejects all pending requests with `STTWorkerCrashError`, tears down the
   * worker, and schedules a background restart with exponential backoff up
   * to `maxCrashRetries`.
   */
  private handleWorkerCrash(error: ErrorEvent): void {
    if (this.destroyed) {
      return;
    }

    const causeMessage = (error && (error.message || (error as unknown as { type?: string }).type)) || 'unknown worker error';
    const cause = new Error(causeMessage);

    const attempts = this.crashRetryAttempts + 1;
    const crashError = new STTWorkerCrashError(attempts, cause);

    console.error('[WhisperWorkerEngine] Worker crash', { message: causeMessage, attempts });

    // Reject all in-flight requests so callers see a typed failure instead
    // of hanging forever.
    for (const pending of this.pendingRequests.values()) {
      pending.reject(crashError);
    }
    this.pendingRequests.clear();

    // Tear down the dead worker
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* terminate may throw if worker already gone */
      }
      this.worker = null;
    }
    this.initialized = false;
    this.transcribing = false;

    // Decide whether to restart
    if (!this.config || attempts > this.maxCrashRetries) {
      this.crashPermanent = true;
      return;
    }

    this.crashRetryAttempts = attempts;
    this.scheduleRestart();
  }

  /**
   * Schedule a background worker restart attempt with exponential backoff.
   * The current attempt count drives the delay.
   */
  private scheduleRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    const delay = this.crashBackoffBaseMs * Math.pow(2, this.crashRetryAttempts - 1);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartWorker();
    }, delay);
  }

  /**
   * Attempt to re-create the worker with the cached config. Success resets
   * the crash retry counter; failure either schedules another retry or, if
   * retries are exhausted, latches `crashPermanent` so subsequent
   * `transcribe()` calls reject early.
   */
  private async restartWorker(): Promise<void> {
    if (this.destroyed || !this.config) {
      return;
    }

    const config = this.config;
    const modelId = config.modelPath ?? this.getModelId(config.model, config.language, config.quantized, config.returnTimestamps);

    try {
      await this.initWithWorker(modelId, config);
      this.initialized = true;
      this.crashRetryAttempts = 0;
    } catch {
      // initWithWorker may have called handleWorkerCrash already (which
      // schedules the next attempt). If we reach here without that having
      // triggered a re-schedule, latch crashPermanent so callers don't hang.
      if (this.crashRetryAttempts >= this.maxCrashRetries && !this.restartTimer) {
        this.crashPermanent = true;
      }
    }
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
