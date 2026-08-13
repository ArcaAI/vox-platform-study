/**
 * @vitest-environment jsdom
 *
 * useArcaBatchTranscription — the compat-entry batch/file
 * transcription queue.
 *
 * The regression this suite exists for above all others is the SSEClient
 * CONSTRUCTOR: `apps/ui-playground/src/hooks/use-file-transcription.ts` builds
 * `new SSEClient(logger)` — the legacy 1-arg form — which `openWithTicket`
 * explicitly blocks, so that stream never connects and the job silently never
 * reports a transcript. The 3-arg `(scope, apiClient, logger)` form is asserted
 * below and must stay asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  class MockSSEClient {
    static instances: MockSSEClient[] = [];
    ctorArgs: unknown[];
    handlers = new Map<string, (data: string) => void>();
    messageCb?: (data: string) => void;
    openCb?: () => void;
    errorCb?: (event: Event) => void;
    url: string | null = null;
    connected = false;
    disconnectCount = 0;

    constructor(...args: unknown[]) {
      this.ctorArgs = args;
      MockSSEClient.instances.push(this);
    }
    onEvent(name: string, cb: (data: string) => void) {
      this.handlers.set(name, cb);
    }
    onMessage(cb: (data: string) => void) {
      this.messageCb = cb;
    }
    onOpen(cb: () => void) {
      this.openCb = cb;
    }
    onError(cb: (event: Event) => void) {
      this.errorCb = cb;
    }
    connect(url: string) {
      this.url = url;
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
      this.disconnectCount += 1;
    }
    /** Test helper — fire a named SSE event. */
    emit(name: string, data: unknown) {
      this.handlers.get(name)?.(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  const upload = vi.fn();
  const getJob = vi.fn();
  const cancelJob = vi.fn();
  const dispose = vi.fn();

  class MockFileTranscriptionService {
    static instances: MockFileTranscriptionService[] = [];
    constructor(..._args: unknown[]) {
      MockFileTranscriptionService.instances.push(this);
    }
    uploadAndTranscribeWithProgress = upload;
    getJob = getJob;
    cancelJob = cancelJob;
    dispose = dispose;
    buildJobStreamUrl = (jobId: string) => `https://api.test/api/v1/audio/transcription-jobs/${jobId}/stream`;
  }

  return { MockSSEClient, MockFileTranscriptionService, upload, getJob, cancelJob, dispose };
});

vi.mock('../../core/SSEClient', () => ({ SSEClient: mocks.MockSSEClient }));
vi.mock('../../core/FileTranscriptionService', () => ({ FileTranscriptionService: mocks.MockFileTranscriptionService }));
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

import { useArcaBatchTranscription } from '../useArcaBatchTranscription';
import { useAgenticStore } from '../../store/agenticStore';

const apiClient = { getBaseUrl: () => 'https://api.test/api/v1' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };

function installStore(client: unknown = apiClient) {
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: { apiClient: unknown; logger: unknown }) => unknown) =>
    selector({ apiClient: client, logger }),
  );
}

function makeFile(name: string, size = 1024): File {
  const file = new File([new Uint8Array(size)], name, { type: 'audio/wav' });
  return file;
}

/** A never-settling upload, so a test can observe the `uploading` state. */
function pendingUpload(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (err: unknown) => void } {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DEFAULT_OPTIONS = { pipelineId: 'pipe-1', language: 'ml' };

describe('useArcaBatchTranscription', () => {
  beforeEach(() => {
    installStore();
    mocks.MockSSEClient.instances.length = 0;
    mocks.MockFileTranscriptionService.instances.length = 0;
    mocks.upload.mockReset();
    mocks.getJob.mockReset();
    mocks.cancelJob.mockReset();
    mocks.dispose.mockReset();
    mocks.upload.mockResolvedValue({ id: 'job-1', status: 'QUEUED' });
    mocks.getJob.mockResolvedValue({ id: 'job-1', status: 'COMPLETED', resultText: 'authoritative text' });
    mocks.cancelJob.mockResolvedValue(undefined);
  });

  it('uploads each enqueued file with the resolved pipeline + language', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav'), makeFile('two.wav')]);
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    const [file, options] = mocks.upload.mock.calls[0];
    expect((file as File).name).toBe('one.wav');
    expect(options).toMatchObject({ pipelineId: 'pipe-1', language: 'ml' });
    expect(typeof options.onProgress).toBe('function');
    expect(result.current.items.map((i) => i.fileName)).toEqual(['one.wav', 'two.wav']);
  });

  it('per-enqueue options override the hook defaults', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')], { pipelineId: 'pipe-override', language: 'en' });
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls[0][1]).toMatchObject({ pipelineId: 'pipe-override', language: 'en' });
  });

  it('constructs SSEClient with (scope, apiClient, logger) — never the blocked legacy 1-arg form', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });

    await waitFor(() => expect(mocks.MockSSEClient.instances).toHaveLength(1));
    const [scope, client] = mocks.MockSSEClient.instances[0].ctorArgs;
    // PER-JOB scope. The route carries `@StreamScope({ namespace: 'transcription_job',
    // param: 'id' })`, and the JWT guard rejects a ticket whose stored scope is not
    // exactly `transcription_job:<id>` — a free-form scope string is a 401.
    expect(scope).toBe('transcription_job:job-1');
    expect(client).toBe(apiClient);
    expect(mocks.MockSSEClient.instances[0].url).toContain('/audio/transcription-jobs/job-1/stream');
  });

  it('appends chunk segments and completes with the authoritative job text', async () => {
    const onJobCompleted = vi.fn();
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS, onJobCompleted }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(mocks.MockSSEClient.instances).toHaveLength(1));
    const sse = mocks.MockSSEClient.instances[0];

    await waitFor(() => expect(result.current.items[0].status).toBe('processing'));

    await act(async () => {
      sse.emit('chunk', { data: { text: 'hello there', isFinal: true, startTime: 0, endTime: 1.5, speakerId: 'S1' } });
    });
    expect(result.current.items[0].segments).toHaveLength(1);
    expect(result.current.items[0].segments[0]).toMatchObject({ text: 'hello there', isFinal: true, speakerId: 'S1' });

    await act(async () => {
      sse.emit('complete', { data: { status: 'COMPLETED' } });
    });

    await waitFor(() => expect(result.current.items[0].status).toBe('completed'));
    // The job fetch is authoritative — SSE chunks can be partial.
    expect(mocks.getJob).toHaveBeenCalledWith('job-1');
    expect(result.current.items[0].text).toBe('authoritative text');
    expect(sse.connected).toBe(false);
    expect(onJobCompleted).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Batch fallback provenance.
  //
  // When the primary ASR fails, the worker re-runs on the tenant fallback and
  // stamps `usedFallbackPipelineId` into the result metadata. That value does
  // reach the client, but buried at `job.resultMetadata.metadata.…` — untyped
  // and undiscoverable. A transcript produced by a different engine than the
  // one requested is a clinical-provenance fact, not a footnote, so the queue
  // item states it directly.
  // ---------------------------------------------------------------------------
  it('surfaces the fallback pipeline on an item whose job fell back', async () => {
    mocks.getJob.mockResolvedValue({
      id: 'job-1',
      status: 'COMPLETED',
      resultText: 'authoritative text',
      resultMetadata: { metadata: { usedFallbackPipelineId: 'sarvam_transcription' } },
    });
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(mocks.MockSSEClient.instances).toHaveLength(1));
    await act(async () => {
      mocks.MockSSEClient.instances[0].emit('complete', { data: { status: 'COMPLETED' } });
    });

    await waitFor(() => expect(result.current.items[0].status).toBe('completed'));
    expect(result.current.items[0].usedFallbackPipelineId).toBe('sarvam_transcription');
  });

  it('leaves the fallback pipeline null when the requested pipeline produced the transcript', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(mocks.MockSSEClient.instances).toHaveLength(1));
    await act(async () => {
      mocks.MockSSEClient.instances[0].emit('complete', { data: { status: 'COMPLETED' } });
    });

    await waitFor(() => expect(result.current.items[0].status).toBe('completed'));
    expect(result.current.items[0].usedFallbackPipelineId).toBeNull();
  });

  // Batch can say "use the tenant default".
  it('uploads without a pipelineId and lets the gateway resolve the tenant default', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: {} }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    // No pipelineId on the wire — omitted, not sent as an empty string, which
    // the gateway's slug/UUID validation would reject.
    expect('pipelineId' in mocks.upload.mock.calls[0][1]).toBe(false);
    expect(result.current.items[0].status).not.toBe('failed');
  });

  it('marks the item failed when the upload rejects', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('413 payload too large'));
    const onError = vi.fn();
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS, onError }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });

    await waitFor(() => expect(result.current.items[0].status).toBe('failed'));
    expect(result.current.items[0].error).toContain('413 payload too large');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('marks the item failed on a terminal FAILED status event', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(mocks.MockSSEClient.instances).toHaveLength(1));

    await act(async () => {
      mocks.MockSSEClient.instances[0].emit('status', { data: { status: 'FAILED' } });
    });

    await waitFor(() => expect(result.current.items[0].status).toBe('failed'));
    expect(mocks.MockSSEClient.instances[0].connected).toBe(false);
  });

  it('cancel aborts an in-flight upload', async () => {
    const gate = pendingUpload();
    mocks.upload.mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(result.current.items[0].status).toBe('uploading'));

    const signal = mocks.upload.mock.calls[0][1].signal as AbortSignal;
    await act(async () => {
      result.current.cancel(result.current.items[0].id);
      gate.reject(new Error('Request aborted'));
    });

    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(result.current.items[0].status).toBe('cancelled'));
  });

  it('cancel during streaming cancels the job and disconnects', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(result.current.items[0].status).toBe('processing'));

    await act(async () => {
      result.current.cancel(result.current.items[0].id);
    });

    expect(mocks.cancelJob).toHaveBeenCalledWith('job-1');
    expect(mocks.MockSSEClient.instances[0].connected).toBe(false);
    await waitFor(() => expect(result.current.items[0].status).toBe('cancelled'));
  });

  it('honours the concurrency cap over the FULL lifecycle (upload + stream)', async () => {
    const gates = [pendingUpload(), pendingUpload(), pendingUpload()];
    mocks.upload.mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise).mockReturnValueOnce(gates[2].promise);

    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS, concurrency: 2 }));

    await act(async () => {
      result.current.enqueue([makeFile('a.wav'), makeFile('b.wav'), makeFile('c.wav')]);
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    expect(result.current.items[2].status).toBe('pending');

    // Finishing the UPLOAD is not enough — the item moves to `processing` and
    // still holds its slot (and its SSE socket), which is the whole point of
    // capping the lifecycle rather than just the upload.
    await act(async () => {
      gates[0].resolve({ id: 'job-a', status: 'QUEUED' });
      await gates[0].promise;
    });
    await waitFor(() => expect(result.current.items[0].status).toBe('processing'));
    expect(mocks.upload).toHaveBeenCalledTimes(2);

    // Terminal completion frees the slot; the third file starts.
    mocks.getJob.mockResolvedValueOnce({ id: 'job-a', status: 'COMPLETED', resultText: 'a done' });
    await act(async () => {
      mocks.MockSSEClient.instances[0].emit('complete', { data: { status: 'COMPLETED' } });
    });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(3));
  });

  it('retry re-uploads a failed item', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(result.current.items[0].status).toBe('failed'));

    await act(async () => {
      result.current.retry(result.current.items[0].id);
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items[0].error).toBeNull());
  });

  it('remove and clear drop items (and stop their streams)', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(result.current.items[0].status).toBe('processing'));

    await act(async () => {
      result.current.remove(result.current.items[0].id);
    });
    expect(result.current.items).toHaveLength(0);
    expect(mocks.MockSSEClient.instances[0].connected).toBe(false);

    await act(async () => {
      result.current.enqueue([makeFile('two.wav')]);
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      result.current.clear();
    });
    expect(result.current.items).toHaveLength(0);
  });

  it('disconnects every stream on unmount', async () => {
    const { result, unmount } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });
    await waitFor(() => expect(mocks.MockSSEClient.instances).toHaveLength(1));

    unmount();
    expect(mocks.MockSSEClient.instances[0].connected).toBe(false);
  });

  // CONTRACT CHANGE. This used to assert that an upload with
  // no resolvable pipeline failed client-side. That refused a request the
  // backend can serve: omitting the pipeline now means "use the tenant's
  // default", which the gateway resolves (tenant default → configured
  // fallback) and 409s only when the tenant has neither. Deciding that here,
  // with no knowledge of the tenant's configuration, was the SDK overreaching.
  it('uploads with no pipelineId rather than failing the item client-side', async () => {
    const { result } = renderHook(() => useArcaBatchTranscription({}));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect('pipelineId' in mocks.upload.mock.calls[0][1]).toBe(false);
    expect(result.current.items[0].status).not.toBe('failed');
  });

  it('fails the item when the SDK has no apiClient yet', async () => {
    installStore(null);
    const { result } = renderHook(() => useArcaBatchTranscription({ options: DEFAULT_OPTIONS }));

    await act(async () => {
      result.current.enqueue([makeFile('one.wav')]);
    });

    await waitFor(() => expect(result.current.items[0].status).toBe('failed'));
    expect(result.current.items[0].error).toMatch(/not initialized/i);
  });
});
