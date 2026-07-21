/**
 * @arcaai/med-ner - MedNERProcessor Worker integration test
 *
 * Asserts that when a `workerFactory` is supplied:
 *   1. `MedNERProcessor` posts `init`/`extract`/`destroy` messages to the
 *      worker with correlation ids and resolves on the matching reply.
 *   2. The main-thread `@huggingface/transformers` pipeline is NEVER
 *      invoked (inference happens off the main thread).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: { allowLocalModels: false, useBrowserCache: true },
}));

vi.mock('../utils/browserSupport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/browserSupport.js')>();
  return {
    ...actual,
    getRecommendedDevice: vi.fn().mockResolvedValue('wasm'),
  };
});

import { pipeline as mainThreadPipeline } from '@huggingface/transformers';
import { MedNERProcessor } from '../processors/MedNERProcessor.js';
import { MedicalEntityType, MODEL_MAP } from '../types/index.js';

type Listener = (event: MessageEvent) => void;

class MockWorker {
  private listeners = new Set<Listener>();
  readonly postMessage = vi.fn((message: unknown) => {
    // Auto-reply to keep the protocol simple: any request gets a ready/result.
    const msg = message as { type: string; id: string; payload: unknown };
    queueMicrotask(() => {
      if (msg.type === 'init') {
        this.emitMessage({ type: 'ready', id: msg.id, payload: { device: 'wasm' } });
      } else if (msg.type === 'extract') {
        this.emitMessage({
          type: 'result',
          id: msg.id,
          payload: {
            entities: [
              {
                text: 'Type 2 Diabetes',
                type: MedicalEntityType.DISEASE,
                start: 0,
                end: 15,
                score: 0.95,
                rawLabel: 'Disease',
              },
            ],
          },
        });
      } else if (msg.type === 'destroy') {
        this.emitMessage({ type: 'ready', id: msg.id, payload: { status: 'destroyed' } });
      }
    });
  });
  readonly terminate = vi.fn();

  addEventListener(type: 'message' | 'error', cb: (event: MessageEvent | Event) => void): void {
    if (type === 'message') this.listeners.add(cb as Listener);
  }
  removeEventListener(type: 'message' | 'error', cb: (event: MessageEvent | Event) => void): void {
    if (type === 'message') this.listeners.delete(cb as Listener);
  }
  emitMessage(data: unknown): void {
    const ev = { data } as MessageEvent;
    for (const l of this.listeners) l(ev);
  }
}

describe('MedNERProcessor with workerFactory (C-1)', () => {
  let worker: MockWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new MockWorker();
  });

  it('NEVER invokes main-thread @huggingface/transformers when a workerFactory is supplied', async () => {
    const factory = vi.fn(() => worker as unknown as Worker);
    const processor = new MedNERProcessor({ model: 'biomedical', workerFactory: factory });

    await processor.init();
    const result = await processor.extract('Patient has Type 2 Diabetes.');
    await processor.destroy();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(mainThreadPipeline).not.toHaveBeenCalled();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].text).toBe('Type 2 Diabetes');
  });

  it('sends the pinned model id, revision, and resolved device to the worker on init', async () => {
    const factory = vi.fn(() => worker as unknown as Worker);
    const processor = new MedNERProcessor({ model: 'biomedical', workerFactory: factory });

    await processor.init();

    const initCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'init');
    expect(initCall, 'expected an init message').toBeDefined();
    const initMsg = initCall![0] as { type: string; id: string; payload: { modelId: string; revision: string; device: string } };
    expect(initMsg.payload.modelId).toBe(MODEL_MAP.biomedical.id);
    expect(initMsg.payload.revision).toBe(MODEL_MAP.biomedical.revision);
    expect(initMsg.payload.device).toBe('wasm');
    expect(processor.getActiveDevice()).toBe('wasm');
  });

  it('extract() proxies the post-processing knobs to the worker', async () => {
    const factory = vi.fn(() => worker as unknown as Worker);
    const processor = new MedNERProcessor({
      model: 'biomedical',
      threshold: 0.7,
      mergeAdjacent: false,
      mergeOverlapping: true,
      entityTypes: [MedicalEntityType.DISEASE],
      workerFactory: factory,
    });

    await processor.init();
    await processor.extract('text');

    const extractCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'extract');
    expect(extractCall, 'expected an extract message').toBeDefined();
    const extractMsg = extractCall![0] as { payload: Record<string, unknown> };
    expect(extractMsg.payload).toMatchObject({
      text: 'text',
      threshold: 0.7,
      mergeAdjacent: false,
      mergeOverlapping: true,
      entityTypes: [MedicalEntityType.DISEASE],
    });
  });

  it('destroy() terminates the worker', async () => {
    const factory = vi.fn(() => worker as unknown as Worker);
    const processor = new MedNERProcessor({ model: 'biomedical', workerFactory: factory });

    await processor.init();
    await processor.destroy();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(processor.isInitialized()).toBe(false);
    expect(processor.getActiveDevice()).toBeNull();
  });
});
