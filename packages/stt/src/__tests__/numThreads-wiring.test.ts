/**
 * @arcaai/stt - TASK-300 L-9 multi-threaded WASM
 *
 * Verifies whisper.worker.ts opts into multi-threaded ONNX Runtime WASM when
 * (and only when) the page is cross-origin-isolated.
 *
 * The worker reads `globalThis.crossOriginIsolated` to decide whether to
 * promote `ort.env.wasm.numThreads` from the safe default (`1`) to
 * `navigator.hardwareConcurrency`. Without COOP/COEP, SharedArrayBuffer is
 * unavailable and a higher numThreads triggers an instant ORT crash.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface OnnxWasmEnv {
  proxy?: boolean;
  numThreads?: number;
  wasmPaths?: string;
}

interface SharedEnv {
  useBrowserCache: boolean;
  useCustomCache: boolean;
  allowLocalModels: boolean;
  backends: { onnx: { wasm: OnnxWasmEnv; webgpu?: Record<string, unknown> } };
}

describe('L-9: whisper.worker ort.env.wasm.numThreads gating', () => {
  let pipelineCreations: Array<{ device: 'webgpu' | undefined; wasmCfgAtCreate: OnnxWasmEnv }>;
  let env: SharedEnv;
  let originalSelf: typeof globalThis.self;
  let originalNavigator: typeof globalThis.navigator;
  let postedMessages: Array<{ type: string; id: string; payload: unknown }>;

  beforeEach(() => {
    postedMessages = [];
    pipelineCreations = [];
    env = {
      useBrowserCache: false,
      useCustomCache: true,
      allowLocalModels: true,
      backends: { onnx: { wasm: {} } },
    };

    vi.doMock('@huggingface/transformers', () => ({
      env,
      pipeline: vi.fn(async (_task: string, _modelId: string, options: { device?: 'webgpu' }) => {
        // Snapshot the wasm config AT pipeline-creation time (not later)
        pipelineCreations.push({
          device: options?.device,
          wasmCfgAtCreate: { ...env.backends.onnx.wasm },
        });
        return vi.fn(async () => ({ text: 'ok', chunks: [] }));
      }),
    }));

    originalSelf = globalThis.self;
    originalNavigator = globalThis.navigator;
    // @ts-expect-error - test-only self shim
    globalThis.self = {
      onmessage: null,
      postMessage: (msg: { type: string; id: string; payload: unknown }) => {
        postedMessages.push(msg);
      },
    };
  });

  afterEach(() => {
    // @ts-expect-error - restore
    globalThis.self = originalSelf;
    // @ts-expect-error - restore
    globalThis.navigator = originalNavigator;
    // @ts-expect-error - restore (delete crossOriginIsolated)
    delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    vi.doUnmock('@huggingface/transformers');
    vi.resetModules();
  });

  async function waitForMessage(predicate: (msg: { type: string; id: string }) => boolean, attempts = 50): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (postedMessages.find((m) => predicate(m))) return;
      await Promise.resolve();
    }
    throw new Error(`Message not found. Got: ${JSON.stringify(postedMessages)}`);
  }

  async function callInit(): Promise<void> {
    await import('../workers/whisper.worker.js');
    const handler = (globalThis.self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage;
    expect(handler).toBeTypeOf('function');
    const initId = 'init-thr-1';
    await handler({
      data: {
        type: 'init',
        id: initId,
        payload: {
          modelId: 'onnx-community/whisper-small',
          device: undefined,
          language: 'en',
          codeSwitching: false,
          chunkLengthS: 30,
          overlapLengthS: 5,
          returnTimestamps: true,
        },
      },
    });
    await waitForMessage((m) => (m.type === 'ready' || m.type === 'error') && m.id === initId);
  }

  it('sets numThreads to navigator.hardwareConcurrency when crossOriginIsolated is true', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 8,
      configurable: true,
    });

    await callInit();

    // The wasm config snapshotted at pipeline creation must reflect the
    // promoted thread count (the worker writes BEFORE awaiting `pipeline`).
    expect(pipelineCreations.length).toBeGreaterThan(0);
    expect(pipelineCreations[0]!.wasmCfgAtCreate.numThreads).toBe(8);
    // Also assert post-state in case anything reads it later.
    expect(env.backends.onnx.wasm.numThreads).toBe(8);
  });

  it('keeps numThreads at 1 when crossOriginIsolated is false', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 8,
      configurable: true,
    });

    await callInit();

    expect(pipelineCreations.length).toBeGreaterThan(0);
    expect(pipelineCreations[0]!.wasmCfgAtCreate.numThreads).toBe(1);
  });

  it('keeps numThreads at 1 when crossOriginIsolated is undefined (legacy environments)', async () => {
    // crossOriginIsolated intentionally not set
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 8,
      configurable: true,
    });

    await callInit();

    expect(pipelineCreations.length).toBeGreaterThan(0);
    expect(pipelineCreations[0]!.wasmCfgAtCreate.numThreads).toBe(1);
  });

  it('falls back to 1 when navigator.hardwareConcurrency is missing even if isolated', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: undefined,
      configurable: true,
    });

    await callInit();

    expect(pipelineCreations.length).toBeGreaterThan(0);
    expect(pipelineCreations[0]!.wasmCfgAtCreate.numThreads).toBe(1);
  });

  it('clamps wildly high hardwareConcurrency reports to a safe maximum (<= 8)', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 128,
      configurable: true,
    });

    await callInit();

    expect(pipelineCreations.length).toBeGreaterThan(0);
    const n = pipelineCreations[0]!.wasmCfgAtCreate.numThreads;
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(8);
  });
});
