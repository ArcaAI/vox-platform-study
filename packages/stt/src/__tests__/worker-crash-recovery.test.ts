/**
 * @arcaai/stt - H-2 worker crash recovery tests (TASK-270)
 *
 * Verifies that `WhisperWorkerEngine`:
 *   - Rejects all pending requests with `STTWorkerCrashError` when the worker
 *     fires `onerror`.
 *   - Restarts the worker with exponential backoff up to 3 attempts.
 *   - Refuses further work once retries are exhausted.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type WorkerLike = {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  __id: number;
};

let workerCounter = 0;
let workers: WorkerLike[];
let originalWorker: typeof Worker;

function setupWorkerMock(): void {
  originalWorker = globalThis.Worker;
  workerCounter = 0;
  workers = [];

  class MockWorker implements WorkerLike {
    postMessage = vi.fn();
    terminate = vi.fn();
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    __id: number;

    constructor(_url: URL | string, _opts?: WorkerOptions) {
      this.__id = ++workerCounter;
      workers.push(this);
    }
  }
  // @ts-expect-error - test-only Worker
  globalThis.Worker = MockWorker;
}

function restoreWorkerMock(): void {
  globalThis.Worker = originalWorker;
}

function latestWorker(): WorkerLike {
  const w = workers[workers.length - 1];
  if (!w) throw new Error('No worker spawned');
  return w;
}

function findInitRequestId(worker: WorkerLike): string {
  const initCall = worker.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'init');
  if (!initCall) throw new Error('No init message sent');
  return (initCall[0] as { id: string }).id;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

async function initAndReady(engine: import('../engines/WhisperWorkerEngine.js').WhisperWorkerEngine): Promise<WorkerLike> {
  const initPromise = engine.init({
    model: 'tiny',
    language: 'en',
    device: 'wasm',
    quantized: true,
    chunkLengthS: 30,
    overlapLengthS: 5,
    returnTimestamps: true,
  });
  const worker = latestWorker();
  await flushMicrotasks();
  const initId = findInitRequestId(worker);
  worker.onmessage?.({ data: { type: 'ready', id: initId, payload: { device: 'wasm' } } } as MessageEvent);
  await initPromise;
  return worker;
}

describe('H-2: worker crash recovery', () => {
  beforeEach(() => {
    setupWorkerMock();
  });

  afterEach(() => {
    restoreWorkerMock();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('exports STTWorkerCrashError as a typed Error', async () => {
    const mod = await import('../engines/index.js');
    expect((mod as unknown as { STTWorkerCrashError?: unknown }).STTWorkerCrashError).toBeTypeOf('function');
    const err = new (mod as unknown as { STTWorkerCrashError: new (a: number, c?: Error) => Error }).STTWorkerCrashError(1);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('STTWorkerCrashError');
  });

  it('rejects pending transcribe request with STTWorkerCrashError on worker.onerror', async () => {
    vi.useFakeTimers();

    const { WhisperWorkerEngine } = await import('../engines/WhisperWorkerEngine.js');
    const { STTWorkerCrashError } = await import('../engines/index.js');
    const engine = new WhisperWorkerEngine();

    const worker = await initAndReady(engine);
    const transcribePromise = engine.transcribe(new Float32Array(16000));
    const rejection = transcribePromise.catch((e: unknown) => e);

    worker.onerror?.({ message: 'worker boom' } as ErrorEvent);

    const result = await rejection;
    expect(result).toBeInstanceOf(STTWorkerCrashError);
    expect((result as Error).name).toBe('STTWorkerCrashError');
    expect((result as { cause?: Error }).cause?.message).toBe('worker boom');
  });

  it('schedules a restart with exponential backoff and respawns the worker', async () => {
    vi.useFakeTimers();

    const { WhisperWorkerEngine } = await import('../engines/WhisperWorkerEngine.js');
    const engine = new WhisperWorkerEngine();

    const firstWorker = await initAndReady(engine);
    expect(workers.length).toBe(1);

    // Background a pending transcribe and crash
    const tx = engine.transcribe(new Float32Array(16000));
    void tx.catch(() => {});

    firstWorker.onerror?.({ message: 'kapow' } as ErrorEvent);

    // No respawn before the backoff timer fires
    expect(workers.length).toBe(1);

    // First backoff = 100ms * 2^0 = 100ms (engine uses 100ms base in this test config)
    await vi.advanceTimersByTimeAsync(200);

    // Restart attempt should spawn a new worker
    expect(workers.length).toBe(2);
  });

  it('surfaces STTWorkerCrashError on transcribe after the third consecutive crash', async () => {
    vi.useFakeTimers();

    const { WhisperWorkerEngine } = await import('../engines/WhisperWorkerEngine.js');
    const { STTWorkerCrashError } = await import('../engines/index.js');
    const engine = new WhisperWorkerEngine();

    const firstWorker = await initAndReady(engine);

    // Crash #1: triggered by an in-flight transcribe
    const firstTx = engine.transcribe(new Float32Array(16000));
    void firstTx.catch(() => {});
    firstWorker.onerror?.({ message: 'crash 1' } as ErrorEvent);

    // Walk through 3 retries — each restart fires onerror immediately
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
      const restarted = latestWorker();
      // Simulate immediate crash on the restart attempt
      restarted.onerror?.({ message: `crash ${attempt + 1}` } as ErrorEvent);
    }

    // After exhausting retries, further transcribe calls must reject with
    // STTWorkerCrashError instead of hanging or producing a generic error.
    const failingPromise = engine.transcribe(new Float32Array(16000));
    const result = await failingPromise.catch((e: unknown) => e);
    expect(result).toBeInstanceOf(STTWorkerCrashError);
  });

  it('does not schedule restart when destroyed', async () => {
    vi.useFakeTimers();

    const { WhisperWorkerEngine } = await import('../engines/WhisperWorkerEngine.js');
    const engine = new WhisperWorkerEngine();

    const worker = await initAndReady(engine);

    // Begin destroy. `destroy()` waits on a worker ack we never deliver, so we
    // intentionally do not await it — the `destroyed` flag is set
    // synchronously and that is the only assertion this test needs.
    void engine.destroy();
    await flushMicrotasks();

    worker.onerror?.({ message: 'late crash' } as ErrorEvent);

    await vi.advanceTimersByTimeAsync(5000);

    // No second worker spawned because engine is destroyed
    expect(workers.length).toBe(1);
  });
});
