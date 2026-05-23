/**
 * @arcaai/stt - C-2 transferable postMessage tests (TASK-270)
 *
 * Audio `Float32Array` buffers must be transferred (not structured-cloned) to
 * the worker on every `transcribe`. Without this, each 30 s @ 16 kHz chunk
 * causes a ~1.9 MB copy on every call, accumulating GC pressure in long
 * sessions (see 04-stt.md C-2 / P-1).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type WorkerLike = {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

describe('C-2: transferable postMessage for audio buffers', () => {
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
    vi.resetModules();
  });

  async function initEngine(): Promise<{ engine: import('../engines/WhisperWorkerEngine.js').WhisperWorkerEngine; worker: WorkerLike }> {
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

    const worker = workers[workers.length - 1];
    if (!worker) throw new Error('No worker spawned');

    const initCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'init');
    if (!initCall) throw new Error('Init message not sent');
    const initId = (initCall[0] as { id: string }).id;

    worker.onmessage?.({ data: { type: 'ready', id: initId, payload: { device: 'wasm' } } } as MessageEvent);
    await initPromise;
    return { engine, worker };
  }

  it('passes the audio ArrayBuffer in the transfer list when sending transcribe', async () => {
    const { engine, worker } = await initEngine();

    const audio = new Float32Array(16000);
    const expectedBuffer = audio.buffer;

    const transcribePromise = engine.transcribe(audio);

    const transcribeCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'transcribe');
    expect(transcribeCall).toBeDefined();

    // postMessage(message, transferList) — second arg must be an array
    // containing the audio buffer for zero-copy transfer.
    const transferList = transcribeCall![1];
    expect(Array.isArray(transferList)).toBe(true);
    expect(transferList).toContain(expectedBuffer);

    // Resolve the transcribe so the engine is in a clean state
    const transcribeId = (transcribeCall![0] as { id: string }).id;
    worker.onmessage?.({
      data: {
        type: 'result',
        id: transcribeId,
        payload: { text: 'ok', isFinal: true, language: 'en' },
      },
    } as MessageEvent);
    await transcribePromise;
  });

  it('does not include the audio buffer in transfer list for non-transcribe messages', async () => {
    const { worker } = await initEngine();

    const initCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'init');
    expect(initCall).toBeDefined();
    // init may pass a transfer list (empty) or omit it entirely — both are
    // acceptable. The audio buffer must not appear there because there is no
    // audio payload at init time.
    const initTransferList = (initCall![1] ?? []) as Transferable[];
    expect(initTransferList.length).toBe(0);
  });
});
