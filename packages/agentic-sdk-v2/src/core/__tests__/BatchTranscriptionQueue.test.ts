/**
 * BatchTranscriptionQueue — the native (non-compat) batch engine (TASK-604 lane C).
 *
 * The requirement it implements: upload up to 5 recordings of at most 60 minutes
 * each, monitor each one, and collect its result. The engine is framework-free
 * so the caps and the transport wiring are testable without React, and so the
 * React hook on top stays a rendering concern.
 *
 * Two transport details are load-bearing and locked below, because getting
 * either wrong fails SILENTLY (the stream simply never delivers):
 *   1. `new SSEClient(scope, apiClient, logger)` — the 3-argument form. The
 *      legacy 1-arg form is blocked inside `openWithTicket`.
 *   2. The ticket scope is PER JOB — `transcription_job:<jobId>` — because the
 *      route declares `@StreamScope({namespace:'transcription_job',param:'id'})`
 *      and the guard compares for equality. Anything else is a 401.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// All mock state lives in one `vi.hoisted` block: `vi.mock` factories are
// hoisted above every other statement, so anything they close over must be too.
const h = vi.hoisted(() => {
  class MockSSE {
    scope: string;
    apiClient: unknown;
    named = new Map<string, (raw: string) => void>();
    messageCb?: (raw: string) => void;
    connectedUrl: string | null = null;
    disconnected = false;

    constructor(scope: string, apiClient: unknown) {
      this.scope = scope;
      this.apiClient = apiClient;
      state.sseInstances.push(this);
    }
    onEvent(name: string, cb: (raw: string) => void) {
      this.named.set(name, cb);
    }
    onMessage(cb: (raw: string) => void) {
      this.messageCb = cb;
    }
    onError() {}
    connect(url: string) {
      this.connectedUrl = url;
    }
    disconnect() {
      this.disconnected = true;
    }
    /** Drive a named SSE event the way the gateway would. */
    emit(event: string, payload: unknown) {
      this.named.get(event)?.(JSON.stringify(payload));
    }
  }

  const state = {
    MockSSE,
    sseInstances: [] as MockSSE[],
    uploadCalls: [] as { file: File; options: Record<string, unknown> }[],
    cancelJobCalls: [] as string[],
    probedDuration: 60 as number | null,
    uploadImpl: (async () => ({ id: 'job-1' })) as (file: File, options: Record<string, unknown>) => Promise<{ id: string }>,
    getJobImpl: (async (jobId: string) => ({ id: jobId, status: 'COMPLETED', resultText: 'authoritative text' })) as (
      jobId: string,
    ) => Promise<Record<string, unknown>>,
  };
  return state;
});

vi.mock('../SSEClient', () => ({ SSEClient: h.MockSSE }));

vi.mock('../FileTranscriptionService', () => ({
  FileTranscriptionService: class {
    async uploadAndTranscribeWithProgress(file: File, options: Record<string, unknown>) {
      h.uploadCalls.push({ file, options });
      (options.onProgress as ((n: number) => void) | undefined)?.(50);
      return h.uploadImpl(file, options);
    }
    async getJob(jobId: string) {
      return h.getJobImpl(jobId);
    }
    async cancelJob(jobId: string) {
      h.cancelJobCalls.push(jobId);
    }
    buildJobStreamUrl(jobId: string) {
      return `https://api.test/api/v1/audio/transcription-jobs/${jobId}/stream`;
    }
    dispose() {}
  },
}));

// Duration probing is stubbed per-test; the real one needs a decoding browser.
vi.mock('../audioDuration', () => ({
  probeAudioDurationSeconds: vi.fn(async () => h.probedDuration),
}));

import { BatchTranscriptionQueue } from '../BatchTranscriptionQueue';

const apiClient = { get: vi.fn(), post: vi.fn(), getBaseUrl: () => 'https://api.test/api/v1' };

function makeFile(name = 'consult.wav', sizeBytes = 1024, type = 'audio/wav'): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

function makeQueue(overrides: Record<string, unknown> = {}) {
  return new BatchTranscriptionQueue({
    apiClient: apiClient as never,
    options: { pipelineId: 'pipe-1' },
    ...overrides,
  });
}

/** Let the engine's internal promise chain settle. */
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sseInstances.length = 0;
  h.uploadCalls.length = 0;
  h.cancelJobCalls.length = 0;
  h.probedDuration = 60;
  h.uploadImpl = async () => ({ id: 'job-1' });
  h.getJobImpl = async (jobId) => ({ id: jobId, status: 'COMPLETED', resultText: 'authoritative text' });
});

describe('caps — up to 5 recordings, 60 minutes each', () => {
  it('accepts a batch at exactly the file limit', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d'), makeFile('e')]);
    await flush();
    expect(queue.getSnapshot().filter((i) => i.status === 'failed')).toHaveLength(0);
  });

  it('rejects the files beyond the limit — and keeps the ones within it', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d'), makeFile('e'), makeFile('f')]);
    await flush();

    const snapshot = queue.getSnapshot();
    expect(snapshot).toHaveLength(6);
    expect(snapshot[5]!.status).toBe('failed');
    expect(snapshot[5]!.rejectionReason).toBe('too_many');
    expect(snapshot.slice(0, 5).every((i) => i.status !== 'failed')).toBe(true);
  });

  it('counts already-queued items toward the limit across separate enqueues', async () => {
    // Three drops of two files each is still one batch of six.
    const queue = makeQueue();
    queue.enqueue([makeFile('a'), makeFile('b')]);
    queue.enqueue([makeFile('c'), makeFile('d')]);
    queue.enqueue([makeFile('e'), makeFile('f')]);
    await flush();
    expect(queue.getSnapshot().filter((i) => i.rejectionReason === 'too_many')).toHaveLength(1);
  });

  it('does not count removed or cancelled rows toward the limit', async () => {
    const queue = makeQueue();
    const ids = queue.enqueue([makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d'), makeFile('e')]);
    await flush();
    queue.remove(ids[0]!);
    queue.enqueue([makeFile('f')]);
    await flush();
    expect(queue.getSnapshot().filter((i) => i.rejectionReason === 'too_many')).toHaveLength(0);
  });

  it('rejects a recording over the duration ceiling before uploading a byte', async () => {
    h.probedDuration = 61 * 60;
    const queue = makeQueue();
    queue.enqueue([makeFile('long.wav')]);
    await flush();

    const [item] = queue.getSnapshot();
    expect(item!.status).toBe('failed');
    expect(item!.rejectionReason).toBe('too_long');
    expect(item!.durationSeconds).toBe(61 * 60);
    expect(h.uploadCalls).toHaveLength(0);
  });

  it('accepts a recording exactly at the ceiling', async () => {
    h.probedDuration = 60 * 60;
    const queue = makeQueue();
    queue.enqueue([makeFile('exactly-60.wav')]);
    await flush();
    expect(h.uploadCalls).toHaveLength(1);
  });

  it('uploads anyway when the browser cannot read the duration — the gateway decides', async () => {
    // Client-side probing is an optimisation. Refusing everything the browser
    // cannot decode would block valid uploads the server would have accepted.
    h.probedDuration = null;
    const queue = makeQueue();
    queue.enqueue([makeFile('opaque.webm', 1024, 'audio/webm')]);
    await flush();
    expect(h.uploadCalls).toHaveLength(1);
    expect(queue.getSnapshot()[0]!.durationSeconds).toBeNull();
  });

  it('rejects an oversize file and an unsupported type with distinct reasons', async () => {
    const queue = makeQueue({ limits: { maxFileSizeBytes: 1000, allowedMimeTypes: ['audio/wav'] } });
    queue.enqueue([makeFile('big.wav', 2000), makeFile('clip.aiff', 100, 'audio/aiff')]);
    await flush();

    const [big, wrongType] = queue.getSnapshot();
    expect(big!.rejectionReason).toBe('too_large');
    expect(wrongType!.rejectionReason).toBe('unsupported_type');
    expect(h.uploadCalls).toHaveLength(0);
  });

  it('applies server-resolved limits over the built-in defaults', async () => {
    const queue = makeQueue();
    queue.setLimits({ maxFilesPerBatch: 2, maxDurationMinutes: 60 });
    queue.enqueue([makeFile('a'), makeFile('b'), makeFile('c')]);
    await flush();
    expect(queue.getSnapshot()[2]!.rejectionReason).toBe('too_many');
  });
});

describe('upload → monitor → result', () => {
  it('uploads with the resolved pipeline and forwards upload progress', async () => {
    const queue = makeQueue();
    const seen: number[] = [];
    queue.subscribe(() => seen.push(queue.getSnapshot()[0]!.uploadProgress));

    queue.enqueue([makeFile('a.wav')]);
    await flush();

    expect(h.uploadCalls[0]!.options.pipelineId).toBe('pipe-1');
    // The 50 comes from the transport's onProgress callback; the terminal 100
    // is set by the engine once the upload resolves.
    expect(seen).toContain(50);
    expect(queue.getSnapshot()[0]!.uploadProgress).toBe(100);
  });

  it('lets a per-enqueue option override the queue default', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')], { pipelineId: 'pipe-2', language: 'ml' });
    await flush();
    expect(h.uploadCalls[0]!.options).toMatchObject({ pipelineId: 'pipe-2', language: 'ml' });
  });

  it('fails the item (never uploads blindly) when no pipeline is resolvable', async () => {
    const queue = new BatchTranscriptionQueue({ apiClient: apiClient as never });
    queue.enqueue([makeFile('a.wav')]);
    await flush();
    expect(queue.getSnapshot()[0]!.status).toBe('failed');
    expect(h.uploadCalls).toHaveLength(0);
  });

  it('opens the result stream with a PER-JOB ticket scope and the 3-arg client', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    expect(h.sseInstances).toHaveLength(1);
    expect(h.sseInstances[0]!.scope).toBe('transcription_job:job-1');
    expect(h.sseInstances[0]!.apiClient).toBe(apiClient);
    expect(h.sseInstances[0]!.connectedUrl).toContain('/audio/transcription-jobs/job-1/stream');
  });

  it('accumulates streamed final segments into the transcript', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    h.sseInstances[0]!.emit('chunk', { text: 'patient reports', isFinal: true });
    h.sseInstances[0]!.emit('chunk', { text: 'chest pain', isFinal: true });
    h.sseInstances[0]!.emit('chunk', { text: 'maybe', isFinal: false });

    const item = queue.getSnapshot()[0]!;
    expect(item.text).toBe('patient reports chest pain');
    expect(item.segments).toHaveLength(3);
  });

  it('replaces the streamed text with the job’s authoritative result on completion', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    h.sseInstances[0]!.emit('chunk', { text: 'partial', isFinal: true });
    h.sseInstances[0]!.emit('complete', { status: 'COMPLETED' });
    await flush();

    const item = queue.getSnapshot()[0]!;
    expect(item.status).toBe('completed');
    expect(item.text).toBe('authoritative text');
    expect(h.sseInstances[0]!.disconnected).toBe(true);
  });

  it('keeps the streamed transcript when the authoritative read-back fails', async () => {
    h.getJobImpl = async () => {
      throw new Error('gateway blip');
    };
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    h.sseInstances[0]!.emit('chunk', { text: 'streamed only', isFinal: true });
    h.sseInstances[0]!.emit('complete', { status: 'COMPLETED' });
    await flush();

    expect(queue.getSnapshot()[0]!).toMatchObject({ status: 'completed', text: 'streamed only' });
  });

  it('marks the item failed when the job reports FAILED', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    h.sseInstances[0]!.emit('status', { status: 'FAILED' });
    await flush();
    expect(queue.getSnapshot()[0]!.status).toBe('failed');
  });

  it('notifies onItemCompleted once per finished item', async () => {
    const onItemCompleted = vi.fn();
    const queue = makeQueue({ onItemCompleted });
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    h.sseInstances[0]!.emit('complete', { status: 'COMPLETED' });
    await flush();
    expect(onItemCompleted).toHaveBeenCalledTimes(1);
    expect(onItemCompleted.mock.calls[0]![0]).toMatchObject({ status: 'completed', text: 'authoritative text' });
  });
});

describe('concurrency', () => {
  it('holds a slot for the whole lifecycle — upload AND stream', async () => {
    const queue = makeQueue({ concurrency: 2 });
    let n = 0;
    h.uploadImpl = async () => ({ id: `job-${++n}` });

    queue.enqueue([makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d')]);
    await flush();

    // Two are streaming (not merely uploaded) — the 3rd must not have started.
    expect(h.uploadCalls).toHaveLength(2);
    expect(queue.getSnapshot().filter((i) => i.status === 'pending')).toHaveLength(2);

    h.sseInstances[0]!.emit('complete', { status: 'COMPLETED' });
    await flush();
    expect(h.uploadCalls).toHaveLength(3);
  });
});

describe('queue operations', () => {
  it('cancels an in-flight job on the backend too, not just locally', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    queue.cancel(queue.getSnapshot()[0]!.id);
    expect(queue.getSnapshot()[0]!.status).toBe('cancelled');
    expect(h.cancelJobCalls).toEqual(['job-1']);
    expect(h.sseInstances[0]!.disconnected).toBe(true);
  });

  it('retries a failed item from a clean slate', async () => {
    h.probedDuration = 61 * 60;
    const queue = makeQueue();
    const [id] = queue.enqueue([makeFile('a.wav')]);
    await flush();
    expect(queue.getSnapshot()[0]!.status).toBe('failed');

    h.probedDuration = 60;
    queue.retry(id!);
    await flush();

    expect(queue.getSnapshot()[0]).toMatchObject({ status: 'processing', rejectionReason: null, error: null });
    expect(h.uploadCalls).toHaveLength(1);
  });

  it('clear() stops everything in flight and empties the queue', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    queue.clear();
    expect(queue.getSnapshot()).toHaveLength(0);
    expect(h.sseInstances[0]!.disconnected).toBe(true);
  });

  it('notifies subscribers on every state transition', async () => {
    const queue = makeQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.enqueue([makeFile('a.wav')]);
    await flush();
    expect(listener.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops notifying after unsubscribe', async () => {
    const queue = makeQueue();
    const listener = vi.fn();
    queue.subscribe(listener)();
    queue.enqueue([makeFile('a.wav')]);
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispose() tears down every open stream and pending upload', async () => {
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();

    queue.dispose();
    expect(h.sseInstances[0]!.disconnected).toBe(true);
  });

  it('returns a stable snapshot identity while nothing changes', async () => {
    // useSyncExternalStore re-renders forever if getSnapshot() is a new array
    // on every call.
    const queue = makeQueue();
    queue.enqueue([makeFile('a.wav')]);
    await flush();
    expect(queue.getSnapshot()).toBe(queue.getSnapshot());
  });
});
