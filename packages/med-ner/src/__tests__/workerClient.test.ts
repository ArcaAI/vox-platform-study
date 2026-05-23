/**
 * @arcaai/med-ner - MedNERWorkerClient Tests (C-1)
 *
 * The client is the main-thread side of the Worker protocol. It MUST:
 *   - generate a unique correlation id per request
 *   - resolve the matching response and route errors to the requester
 *   - never touch the main-thread `@huggingface/transformers` pipeline
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { MedNERWorkerClient } from '../workers/workerClient.js';
import { MedicalEntityType } from '../types/index.js';

// Hard assertion: importing the worker client must NOT import the main-thread
// pipeline. We mock @huggingface/transformers and later assert it has not
// been called by any code path the client touches.
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: { allowLocalModels: false, useBrowserCache: true },
}));

import { pipeline as mainThreadPipeline } from '@huggingface/transformers';

type Listener = (event: MessageEvent) => void;
type ErrListener = (event: Event) => void;

class MockWorker {
  private msgListeners = new Set<Listener>();
  private errListeners = new Set<ErrListener>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  addEventListener(type: 'message' | 'error', cb: Listener | ErrListener): void {
    if (type === 'message') this.msgListeners.add(cb as Listener);
    else this.errListeners.add(cb as ErrListener);
  }

  removeEventListener(type: 'message' | 'error', cb: Listener | ErrListener): void {
    if (type === 'message') this.msgListeners.delete(cb as Listener);
    else this.errListeners.delete(cb as ErrListener);
  }

  /** Simulate a message coming back from the worker. */
  emitMessage(data: unknown): void {
    const ev = { data } as MessageEvent;
    for (const l of this.msgListeners) l(ev);
  }
}

describe('MedNERWorkerClient', () => {
  let worker: MockWorker;
  let client: MedNERWorkerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new MockWorker();
    client = new MedNERWorkerClient(worker);
  });

  it('never invokes the main-thread @huggingface/transformers pipeline', async () => {
    const initPromise = client.init({
      modelId: 'foo/bar',
      revision: 'sha',
      device: 'wasm',
      maxTokens: 384,
      stride: 64,
    });

    // Grab the id the client sent and reply.
    const { id } = worker.postMessage.mock.calls[0][0] as { id: string };
    worker.emitMessage({ type: 'ready', id, payload: { device: 'wasm' } });

    await initPromise;
    expect(mainThreadPipeline).not.toHaveBeenCalled();
  });

  it('init() posts a typed message with a correlation id and resolves on "ready"', async () => {
    const initPromise = client.init({
      modelId: 'biomedical-model',
      revision: 'pinned-sha',
      device: 'webgpu',
      maxTokens: 256,
      stride: 32,
    });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const msg = worker.postMessage.mock.calls[0][0] as { type: string; id: string; payload: unknown };
    expect(msg.type).toBe('init');
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.payload).toMatchObject({
      modelId: 'biomedical-model',
      revision: 'pinned-sha',
      device: 'webgpu',
      maxTokens: 256,
      stride: 32,
    });

    worker.emitMessage({ type: 'ready', id: msg.id, payload: { device: 'webgpu' } });

    await expect(initPromise).resolves.toEqual({ device: 'webgpu' });
  });

  it('forwards progress events to the init() onProgress callback before "ready"', async () => {
    const onProgress = vi.fn();
    const initPromise = client.init(
      { modelId: 'foo/bar', device: 'wasm', maxTokens: 384, stride: 64 },
      onProgress,
    );
    const { id } = worker.postMessage.mock.calls[0][0] as { id: string };

    worker.emitMessage({ type: 'progress', id, payload: { status: 'downloading', progress: 0.5 } });
    worker.emitMessage({ type: 'progress', id, payload: { status: 'loading', progress: 0.9 } });
    worker.emitMessage({ type: 'ready', id, payload: { device: 'wasm' } });

    await initPromise;
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0]).toMatchObject({ status: 'downloading', progress: 0.5 });
    expect(onProgress.mock.calls[1][0]).toMatchObject({ status: 'loading', progress: 0.9 });
  });

  it('extract() posts an "extract" message and resolves with the returned entities', async () => {
    const extractPromise = client.extract({
      text: 'Patient has Type 2 Diabetes.',
      threshold: 0.5,
      mergeAdjacent: true,
      mergeOverlapping: true,
    });

    const msg = worker.postMessage.mock.calls[0][0] as { type: string; id: string; payload: unknown };
    expect(msg.type).toBe('extract');
    expect(msg.payload).toMatchObject({ text: 'Patient has Type 2 Diabetes.', threshold: 0.5 });

    const entities = [
      {
        text: 'Type 2 Diabetes',
        type: MedicalEntityType.DISEASE,
        start: 12,
        end: 27,
        score: 0.95,
        rawLabel: 'Disease',
      },
    ];
    worker.emitMessage({ type: 'result', id: msg.id, payload: { entities } });

    await expect(extractPromise).resolves.toEqual(entities);
  });

  it('rejects the matching pending promise on an "error" message', async () => {
    const initPromise = client.init({ modelId: 'foo/bar', device: 'wasm', maxTokens: 384, stride: 64 });
    const { id } = worker.postMessage.mock.calls[0][0] as { id: string };

    worker.emitMessage({ type: 'error', id, payload: { message: 'model not found' } });

    await expect(initPromise).rejects.toThrow('model not found');
  });

  it('routes concurrent requests independently via correlation ids', async () => {
    const p1 = client.extract({ text: 'one', threshold: 0.5, mergeAdjacent: true, mergeOverlapping: true });
    const p2 = client.extract({ text: 'two', threshold: 0.5, mergeAdjacent: true, mergeOverlapping: true });

    const [m1, m2] = worker.postMessage.mock.calls.map((c) => c[0] as { id: string });
    expect(m1.id).not.toBe(m2.id);

    // Respond out of order on purpose.
    worker.emitMessage({ type: 'result', id: m2.id, payload: { entities: ['B'] } });
    worker.emitMessage({ type: 'result', id: m1.id, payload: { entities: ['A'] } });

    await expect(p1).resolves.toEqual(['A']);
    await expect(p2).resolves.toEqual(['B']);
  });

  it('destroy() posts a "destroy" message and terminates the worker', async () => {
    const destroyPromise = client.destroy();
    const msg = worker.postMessage.mock.calls[0][0] as { type: string; id: string };
    expect(msg.type).toBe('destroy');

    worker.emitMessage({ type: 'ready', id: msg.id, payload: { status: 'destroyed' } });
    await destroyPromise;

    client.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('dispose() rejects all pending promises so callers do not hang', async () => {
    const pending1 = client.extract({ text: 'x', threshold: 0.5, mergeAdjacent: true, mergeOverlapping: true });
    const pending2 = client.extract({ text: 'y', threshold: 0.5, mergeAdjacent: true, mergeOverlapping: true });

    client.dispose();

    await expect(pending1).rejects.toThrow(/dispose/i);
    await expect(pending2).rejects.toThrow(/dispose/i);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
