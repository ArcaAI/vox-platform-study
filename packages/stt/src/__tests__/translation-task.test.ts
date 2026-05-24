/**
 * @arcaai/stt - TASK-300 L-2 translation task wiring
 *
 * Verifies the `task: 'transcribe' | 'translate'` field flows end-to-end:
 *
 *   STTOptions.features.task / LocalProviderConfig.task / TranscribeOptions.task
 *     -> WhisperEngine.transcribe -> pipeline(..., { task })
 *     -> WhisperWorkerEngine.transcribe -> worker postMessage({ options: { task } })
 *     -> whisper.worker.ts -> pipeline(..., { task })
 *
 * Plus capability gate: English-only Whisper models (`.en` suffix) cannot
 * translate, so `task: 'translate'` against an `.en` model must throw
 * `STTError(NOT_SUPPORTED)` synchronously (before any pipeline call).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { STTError, STTErrorCode } from '../types/index.js';

describe('L-2: translation task wiring -> Whisper task option', () => {
  describe('WhisperEngine.transcribe', () => {
    let pipelineCall: { audio: Float32Array; options: Record<string, unknown> } | null;
    let fakePipeline: (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks: never[] }>;

    beforeEach(() => {
      pipelineCall = null;
      fakePipeline = vi.fn((audio: Float32Array, options: Record<string, unknown>) => {
        pipelineCall = { audio, options };
        return Promise.resolve({ text: 'translated', chunks: [] });
      });

      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => fakePipeline),
        env: {},
      }));
    });

    afterEach(() => {
      vi.doUnmock('@huggingface/transformers');
      vi.resetModules();
    });

    it('forwards options.task to the pipeline as task', async () => {
      const { WhisperEngine } = await import('../engines/WhisperEngine.js');
      const engine = new WhisperEngine();

      await engine.init({
        model: 'small',
        language: 'es-ES',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
      });

      await engine.transcribe(new Float32Array(16000), { task: 'translate' });

      expect(pipelineCall).not.toBeNull();
      expect(pipelineCall!.options.task).toBe('translate');
    });

    it('forwards engine-level task (from EngineConfig) when transcribe is called without per-call override', async () => {
      const { WhisperEngine } = await import('../engines/WhisperEngine.js');
      const engine = new WhisperEngine();

      await engine.init({
        model: 'small',
        language: 'es-ES',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
        task: 'translate',
      });

      await engine.transcribe(new Float32Array(16000));

      expect(pipelineCall).not.toBeNull();
      expect(pipelineCall!.options.task).toBe('translate');
    });

    it('defaults to NOT passing task when neither config nor options specify it', async () => {
      const { WhisperEngine } = await import('../engines/WhisperEngine.js');
      const engine = new WhisperEngine();

      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
      });

      await engine.transcribe(new Float32Array(16000));

      expect(pipelineCall).not.toBeNull();
      // Either omitted entirely or explicitly 'transcribe'; both are valid.
      // Pin to the smaller surface: do not pass it when not requested.
      expect(pipelineCall!.options).not.toHaveProperty('task');
    });

    it('throws STTError(NOT_SUPPORTED) when task is translate AND modelId ends with .en (config modelPath)', async () => {
      const { WhisperEngine } = await import('../engines/WhisperEngine.js');
      const engine = new WhisperEngine();

      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
        modelPath: 'Xenova/whisper-tiny.en',
      });

      await expect(engine.transcribe(new Float32Array(16000), { task: 'translate' })).rejects.toMatchObject({
        name: 'STTError',
        code: STTErrorCode.NOT_SUPPORTED,
      });
    });

    it('throws STTError(NOT_SUPPORTED) when task is translate AND the resolved model ID ends with .en (via getModelId)', async () => {
      const { WhisperEngine } = await import('../engines/WhisperEngine.js');
      const engine = new WhisperEngine();

      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
        task: 'translate',
      });

      await expect(engine.transcribe(new Float32Array(16000))).rejects.toMatchObject({
        name: 'STTError',
        code: STTErrorCode.NOT_SUPPORTED,
      });
    });

    it('allows task: transcribe on .en models (no capability error)', async () => {
      const { WhisperEngine } = await import('../engines/WhisperEngine.js');
      const engine = new WhisperEngine();

      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
      });

      await expect(engine.transcribe(new Float32Array(16000), { task: 'transcribe' })).resolves.toBeDefined();
    });
  });

  describe('WhisperWorkerEngine.transcribe', () => {
    type WorkerLike = {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: () => void;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
    };

    let workers: WorkerLike[];
    let originalWorker: typeof Worker;

    beforeEach(() => {
      workers = [];
      originalWorker = globalThis.Worker;

      class MockWorker implements WorkerLike {
        postMessage = vi.fn();
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        terminate(): void {
          /* noop */
        }
        constructor(_url: URL | string, _opts?: WorkerOptions) {
          workers.push(this);
        }
      }
      // @ts-expect-error - test-only Worker mock
      globalThis.Worker = MockWorker;
    });

    afterEach(() => {
      globalThis.Worker = originalWorker;
    });

    function getLatestWorker(): WorkerLike {
      const w = workers[workers.length - 1];
      if (!w) throw new Error('No worker spawned');
      return w;
    }

    function findInitRequestId(worker: WorkerLike): string {
      const initCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'init');
      if (!initCall) throw new Error('No init postMessage');
      return (initCall[0] as { id: string }).id;
    }

    function findTranscribeCall(
      worker: WorkerLike,
    ): { type: string; id: string; payload: { audio: Float32Array; options?: { task?: string } } } | undefined {
      const call = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'transcribe');
      return call?.[0] as never;
    }

    it('forwards task in the transcribe payload to the worker', async () => {
      const { WhisperWorkerEngine } = await import('../engines/WhisperWorkerEngine.js');
      const engine = new WhisperWorkerEngine();

      const initPromise = engine.init({
        model: 'small',
        language: 'fr',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
      });

      const worker = getLatestWorker();
      const initId = findInitRequestId(worker);
      worker.onmessage?.({ data: { type: 'ready', id: initId, payload: { device: 'wasm' } } } as MessageEvent);

      await initPromise;

      const transcribePromise = engine.transcribe(new Float32Array(16000), { task: 'translate' });

      const transcribeCall = findTranscribeCall(worker);
      expect(transcribeCall).toBeDefined();
      expect(transcribeCall!.payload.options?.task).toBe('translate');

      worker.onmessage?.({
        data: {
          type: 'result',
          id: transcribeCall!.id,
          payload: { text: 'ok', isFinal: true, language: 'fr' },
        },
      } as MessageEvent);

      await transcribePromise;
    });

    it('throws STTError(NOT_SUPPORTED) before postMessage when task is translate AND model ends with .en', async () => {
      const { WhisperWorkerEngine } = await import('../engines/WhisperWorkerEngine.js');
      const engine = new WhisperWorkerEngine();

      const initPromise = engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        overlapLengthS: 5,
        returnTimestamps: true,
        modelPath: 'Xenova/whisper-tiny.en',
      });

      const worker = getLatestWorker();
      const initId = findInitRequestId(worker);
      worker.onmessage?.({ data: { type: 'ready', id: initId, payload: { device: 'wasm' } } } as MessageEvent);

      await initPromise;

      await expect(engine.transcribe(new Float32Array(16000), { task: 'translate' })).rejects.toMatchObject({
        name: 'STTError',
        code: STTErrorCode.NOT_SUPPORTED,
      });

      const transcribeCall = findTranscribeCall(worker);
      expect(transcribeCall).toBeUndefined();
    });
  });

  describe('whisper.worker.ts pipeline call', () => {
    let pipelineMock: ReturnType<typeof vi.fn>;
    let originalSelf: typeof globalThis;
    let postedMessages: unknown[];

    beforeEach(() => {
      postedMessages = [];
      pipelineMock = vi.fn(async () => ({ text: 'translated', chunks: [] }));

      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => pipelineMock),
        env: {},
      }));

      originalSelf = globalThis.self;
      // @ts-expect-error - test-only self shim
      globalThis.self = {
        onmessage: null,
        postMessage: (msg: unknown) => {
          postedMessages.push(msg);
        },
      };
    });

    afterEach(() => {
      // @ts-expect-error - restore
      globalThis.self = originalSelf;
      vi.doUnmock('@huggingface/transformers');
      vi.resetModules();
    });

    async function waitForMessage(predicate: (msg: { type: string; id: string }) => boolean, attempts = 50): Promise<{ type: string; id: string; payload: unknown }> {
      for (let i = 0; i < attempts; i++) {
        const found = postedMessages.find((m) => predicate(m as { type: string; id: string }));
        if (found) return found as { type: string; id: string; payload: unknown };
        await Promise.resolve();
      }
      throw new Error(`Message not found after ${attempts} ticks. Got: ${JSON.stringify(postedMessages)}`);
    }

    it('passes options.task as task to the pipeline', async () => {
      await import('../workers/whisper.worker.js');

      const handler = (globalThis.self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage;
      expect(handler).toBeTypeOf('function');

      const initId = 'init-tx-1';
      await handler({
        data: {
          type: 'init',
          id: initId,
          payload: {
            modelId: 'onnx-community/whisper-small',
            device: undefined,
            language: 'es',
            codeSwitching: false,
            chunkLengthS: 30,
            overlapLengthS: 5,
            returnTimestamps: true,
          },
        },
      });

      await waitForMessage((m) => m.type === 'ready' && m.id === initId);

      const transcribeId = 'tx-translate-1';
      await handler({
        data: {
          type: 'transcribe',
          id: transcribeId,
          payload: {
            audio: new Float32Array(16000),
            options: { task: 'translate' },
          },
        },
      });

      await waitForMessage((m) => m.type === 'result' && m.id === transcribeId);

      const pipelineCalls = pipelineMock.mock.calls;
      const lastCall = pipelineCalls[pipelineCalls.length - 1];
      expect(lastCall).toBeDefined();
      const options = lastCall![1] as Record<string, unknown>;
      expect(options.task).toBe('translate');
    });
  });
});

describe('L-2: STTFeatureFlags.task surface', () => {
  it('STTFeatureFlags accepts task: transcribe | translate (type-level)', async () => {
    const { DEFAULT_FEATURE_FLAGS } = await import('../types/index.js');
    // Type-level smoke: assignment must compile and round-trip at runtime.
    const flags: import('../types/index.js').STTFeatureFlags = {
      ...DEFAULT_FEATURE_FLAGS,
      task: 'translate',
    };
    expect(flags.task).toBe('translate');

    const flags2: import('../types/index.js').STTFeatureFlags = {
      ...DEFAULT_FEATURE_FLAGS,
      task: 'transcribe',
    };
    expect(flags2.task).toBe('transcribe');
  });

  it('EngineConfig accepts optional task field (engine layer plumbing)', () => {
    const cfg: import('../engines/types.js').EngineConfig = {
      model: 'small',
      language: 'es-ES',
      device: 'wasm',
      quantized: true,
      chunkLengthS: 30,
      overlapLengthS: 5,
      returnTimestamps: true,
      task: 'translate',
    };
    expect(cfg.task).toBe('translate');
  });

  it('TranscribeOptions accepts optional task field (per-call override)', () => {
    const opts: import('../engines/types.js').TranscribeOptions = {
      task: 'translate',
    };
    expect(opts.task).toBe('translate');
  });

  it('STTError unused import sanity (anchors module import)', () => {
    expect(STTError).toBeDefined();
  });
});
