/**
 * @arcaai/med-ner - MedNERWorkerClient
 *
 * Main-thread wrapper around a Web Worker hosting the NER pipeline. The
 * client multiplexes Promise-based requests over `postMessage` by
 * generating a correlation id per request and routing the matching
 * `'ready' | 'result' | 'error'` reply back to the awaiting caller.
 *
 * The client does NOT import `@huggingface/transformers` — that import
 * lives inside the worker bundle, off the main thread.
 */

import type { EntitySpan, MedicalEntityType, MedNERDevice, ModelLoadProgress } from '../types/index.js';

/**
 * Minimal subset of the Worker DOM interface the client needs. Allows tests
 * to inject a mock implementation without monkey-patching the global.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent | Event) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent | Event) => void): void;
  terminate(): void;
}

export interface MedNERWorkerInitPayload {
  modelId: string;
  revision?: string;
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  device: MedNERDevice;
  maxTokens: number;
  stride: number;
}

export interface MedNERWorkerExtractPayload {
  text: string;
  threshold: number;
  entityTypes?: MedicalEntityType[];
  mergeAdjacent: boolean;
  mergeOverlapping: boolean;
}

export interface MedNERWorkerInitResult {
  device: MedNERDevice;
}

export interface MedNERWorkerExtractResult {
  entities: EntitySpan[];
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerResponse {
  type: 'ready' | 'progress' | 'result' | 'error';
  id: string;
  payload: unknown;
}

let __requestCounter = 0;

function generateRequestId(): string {
  __requestCounter = (__requestCounter + 1) & 0xffff;
  const rand = Math.random().toString(36).slice(2, 10);
  return `med-ner-${Date.now()}-${__requestCounter}-${rand}`;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<WorkerResponse>;
  return typeof r.type === 'string' && typeof r.id === 'string';
}

export class MedNERWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly progressHandlers = new Map<string, (p: ModelLoadProgress) => void>();
  private readonly onMessage: (event: MessageEvent | Event) => void;
  private disposed = false;

  constructor(private readonly worker: WorkerLike) {
    this.onMessage = (event: MessageEvent | Event): void => {
      const data = (event as MessageEvent).data;
      this.handleMessage(data);
    };
    this.worker.addEventListener('message', this.onMessage);
  }

  /**
   * Tell the worker to load the pipeline.
   *
   * @param onProgress - optional listener for model-load progress events.
   * Receives every `'progress'` message until either `'ready'` or `'error'`
   * arrives for this request.
   */
  async init(payload: MedNERWorkerInitPayload, onProgress?: (p: ModelLoadProgress) => void): Promise<MedNERWorkerInitResult> {
    return this.request<MedNERWorkerInitResult>('init', payload, onProgress);
  }

  /**
   * Run inference for `payload.text` inside the worker.
   *
   * The worker is responsible for token-aware chunking and entity merging
   * before resolving with the final `EntitySpan[]`.
   */
  async extract(payload: MedNERWorkerExtractPayload): Promise<EntitySpan[]> {
    const result = await this.request<MedNERWorkerExtractResult>('extract', payload);
    return result.entities;
  }

  /**
   * Ask the worker to release its pipeline. After the worker acks, callers
   * should call {@link dispose} to terminate the underlying `Worker`.
   */
  async destroy(): Promise<void> {
    await this.request<unknown>('destroy', null);
  }

  /**
   * Terminate the worker and reject any pending promises so callers do not
   * hang. Safe to call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener('message', this.onMessage);
    const error = new Error('MedNERWorkerClient was disposed before the worker replied');
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.progressHandlers.clear();
    try {
      this.worker.terminate();
    } catch {
      // Some test harnesses throw on double-terminate; ignore.
    }
  }

  private request<T>(type: 'init' | 'extract' | 'destroy', payload: unknown, onProgress?: (p: ModelLoadProgress) => void): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('MedNERWorkerClient is disposed'));
    }
    const id = generateRequestId();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject });
      if (onProgress) this.progressHandlers.set(id, onProgress);
      this.worker.postMessage({ type, id, payload });
    });
  }

  private handleMessage(data: unknown): void {
    if (!isWorkerResponse(data)) return;

    if (data.type === 'progress') {
      const handler = this.progressHandlers.get(data.id);
      handler?.(data.payload as ModelLoadProgress);
      return;
    }

    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    this.progressHandlers.delete(data.id);

    if (data.type === 'error') {
      const message = (data.payload as { message?: string } | null)?.message ?? 'Unknown worker error';
      pending.reject(new Error(message));
    } else {
      pending.resolve(data.payload);
    }
  }
}
