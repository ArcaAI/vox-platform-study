/**
 * @arcaai/stt - prompt wiring tests
 *
 * Verifies the `prompt` field flows end-to-end into the Transformers.js
 * pipeline as `initial_prompt`:
 *
 *   STTOptions.prompt
 *     -> LocalProviderConfig.prompt
 *     -> LocalSTTProvider.transcribeSegment -> engine.transcribe(audio, { prompt })
 *     -> WhisperEngine: pipeline(audio, { initial_prompt })
 *     -> WhisperWorkerEngine: postMessage({ type: 'transcribe', payload: { audio, options: { prompt } }})
 *     -> whisper.worker.ts -> pipeline(audio, { initial_prompt })
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('C-1: prompt wiring -> Whisper initial_prompt', () => {
  describe('WhisperEngine.transcribe', () => {
    let pipelineCall: { audio: Float32Array; options: Record<string, unknown> } | null;
    let fakePipeline: (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks: never[] }>;

    beforeEach(() => {
      pipelineCall = null;
      fakePipeline = vi.fn((audio: Float32Array, options: Record<string, unknown>) => {
        pipelineCall = { audio, options };
        return Promise.resolve({ text: 'hello', chunks: [] });
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

    it('forwards options.prompt to the pipeline as initial_prompt', async () => {
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

      await engine.transcribe(new Float32Array(16000), { prompt: 'cardiology consultation' });

      expect(pipelineCall).not.toBeNull();
      expect(pipelineCall!.options.initial_prompt).toBe('cardiology consultation');
    });

    it('does not pass initial_prompt when no prompt provided', async () => {
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
      expect(pipelineCall!.options).not.toHaveProperty('initial_prompt');
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

    function findTranscribeCall(worker: WorkerLike): { type: string; id: string; payload: { audio: Float32Array; options?: { prompt?: string } } } | undefined {
      const call = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'transcribe');
      return call?.[0] as never;
    }

    it('forwards prompt in the transcribe payload to the worker', async () => {
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
      });

      const worker = getLatestWorker();
      const initId = findInitRequestId(worker);
      worker.onmessage?.({ data: { type: 'ready', id: initId, payload: { device: 'wasm' } } } as MessageEvent);

      await initPromise;

      const transcribePromise = engine.transcribe(new Float32Array(16000), { prompt: 'pediatric oncology' });

      const transcribeCall = findTranscribeCall(worker);
      expect(transcribeCall).toBeDefined();
      expect(transcribeCall!.payload.options?.prompt).toBe('pediatric oncology');

      worker.onmessage?.({
        data: {
          type: 'result',
          id: transcribeCall!.id,
          payload: { text: 'ok', isFinal: true, language: 'en' },
        },
      } as MessageEvent);

      await transcribePromise;
    });
  });

  describe('LocalSTTProvider.transcribeSegment', () => {
    it('forwards the configured prompt to engine.transcribe on every segment', async () => {
      const { LocalSTTProvider } = await import('../providers/LocalSTTProvider.js');

      const provider = new LocalSTTProvider();

      const observedOptionsList: Array<{ prompt?: string } | undefined> = [];
      const fakeEngine = {
        async init() {
          /* noop */
        },
        async destroy() {
          /* noop */
        },
        async transcribe(_audio: Float32Array, options?: { prompt?: string }) {
          observedOptionsList.push(options);
          return { text: 'ok', isFinal: true, language: 'en', duration: _audio.length / 16000 };
        },
        getStats() {
          return { isInitialized: true, isTranscribing: false, model: 'tiny', device: 'wasm' as const, transcriptionCount: 0, averageLatencyMs: 0 };
        },
      };

      // Inject fake engine via private slot
      (provider as unknown as { engine: typeof fakeEngine }).engine = fakeEngine;
      (provider as unknown as { initialized: boolean }).initialized = true;
      (provider as unknown as { config: { prompt?: string; diarization: boolean; sampleRate: number } }).config = {
        prompt: 'medical interview',
        diarization: false,
        sampleRate: 16000,
      };

      await provider.transcribeSegment(new Float32Array(16000));
      await provider.transcribeSegment(new Float32Array(16000));

      expect(observedOptionsList).toHaveLength(2);
      expect(observedOptionsList[0]?.prompt).toBe('medical interview');
      expect(observedOptionsList[1]?.prompt).toBe('medical interview');
    });
  });

  describe('whisper.worker.ts pipeline call', () => {
    let pipelineMock: ReturnType<typeof vi.fn>;
    let originalSelf: typeof globalThis;
    let postedMessages: unknown[];

    beforeEach(() => {
      postedMessages = [];
      pipelineMock = vi.fn(async () => ({ text: 'ok', chunks: [] }));

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

    it('passes options.prompt as initial_prompt to the pipeline', async () => {
      await import('../workers/whisper.worker.js');

      const handler = (globalThis.self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage;
      expect(handler).toBeTypeOf('function');

      const initId = 'init-1';
      await handler({
        data: {
          type: 'init',
          id: initId,
          payload: {
            modelId: 'onnx-community/whisper-tiny',
            device: undefined,
            language: 'en',
            codeSwitching: false,
            chunkLengthS: 30,
            overlapLengthS: 5,
            returnTimestamps: true,
          },
        },
      });

      await waitForMessage((m) => m.type === 'ready' && m.id === initId);

      const transcribeId = 'tx-1';
      await handler({
        data: {
          type: 'transcribe',
          id: transcribeId,
          payload: {
            audio: new Float32Array(16000),
            options: { prompt: 'medical' },
          },
        },
      });

      await waitForMessage((m) => m.type === 'result' && m.id === transcribeId);

      const pipelineCalls = pipelineMock.mock.calls;
      const lastCall = pipelineCalls[pipelineCalls.length - 1];
      expect(lastCall).toBeDefined();
      const options = lastCall![1] as Record<string, unknown>;
      expect(options.initial_prompt).toBe('medical');
    });
  });
});
