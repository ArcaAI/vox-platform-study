import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { isTerminalJobStatus, JobsResource } from '../jobs';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A ReadableStream that never emits anything and never closes on its own — simulates a dropped connection until `close()` is called. */
function hangingSseResponse(): { response: Response; close: () => void } {
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  return { response: new Response(stream, { status: 200 }), close: () => controllerRef.close() };
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const RUNNING_STATUS = {
  jobId: 'job-1',
  type: 'SUMMARY' as const,
  status: 'RUNNING' as const,
  progress: 40,
  createdAt: '2026-01-01T00:00:00Z',
  tenantId: 't1',
  userId: 'u1',
};

const COMPLETED_STATUS = { ...RUNNING_STATUS, status: 'COMPLETED' as const, progress: 100 };
const FAILED_WITH_ERROR_FIELD = { ...RUNNING_STATUS, status: 'FAILED' as const, error: 'LLM provider unavailable' };

describe('isTerminalJobStatus', () => {
  it('is true for every terminal status literal from both vocabularies', () => {
    expect(isTerminalJobStatus('COMPLETED')).toBe(true);
    expect(isTerminalJobStatus('FAILED')).toBe(true);
    expect(isTerminalJobStatus('CANCELLED')).toBe(true);
    expect(isTerminalJobStatus('completed')).toBe(true);
    expect(isTerminalJobStatus('failed')).toBe(true);
  });

  it('is false for every non-terminal status literal from both vocabularies', () => {
    expect(isTerminalJobStatus('PENDING')).toBe(false);
    expect(isTerminalJobStatus('RUNNING')).toBe(false);
    expect(isTerminalJobStatus('pending')).toBe(false);
    expect(isTerminalJobStatus('processing')).toBe(false);
  });
});

describe('JobsResource#get', () => {
  it('GETs /api/v1/consultations/jobs/:jobId', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, RUNNING_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport);

    const result = await jobs.get('job-1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/jobs/job-1');
    expect(result).toEqual(RUNNING_STATUS);
  });

  it('surfaces a 404 as NotFoundError', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(404, { message: 'Job missing not found' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const jobs = new JobsResource(transport);

    await expect(jobs.get('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('JobsResource#cancel', () => {
  it('PATCHes /api/v1/consultations/jobs/:jobId/cancel', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, { ok: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport);

    const result = await jobs.cancel('job-1');
    const [url, init] = [fetchImpl.mock.calls[0]?.[0] as string, fetchImpl.mock.calls[0]?.[1] as RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/jobs/job-1/cancel');
    expect(init.method).toBe('PATCH');
    expect(result).toEqual({ ok: true });
  });
});

describe('JobsResource#stream', () => {
  it('yields each parsed JobStatusResponse frame', async () => {
    const frames = [`data: ${JSON.stringify(RUNNING_STATUS)}\n\n`, `data: ${JSON.stringify(COMPLETED_STATUS)}\n\n`];
    const fetchImpl = fetchMock(async () => sseResponse(frames));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport);

    const events = await collect(jobs.stream('job-1'));
    expect(events).toEqual([RUNNING_STATUS, COMPLETED_STATUS]);
  });

  it('yields the not-found frame shape as-is', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([`data: ${JSON.stringify({ error: 'Job not found', jobId: 'missing' })}\n\n`]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport);

    const events = await collect(jobs.stream('missing'));
    expect(events).toEqual([{ error: 'Job not found', jobId: 'missing' }]);
  });

  it('requests the stream path with an Accept: text/event-stream header', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([`data: ${JSON.stringify(COMPLETED_STATUS)}\n\n`]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport);

    await collect(jobs.stream('job-1'));
    const [url, init] = [fetchImpl.mock.calls[0]?.[0] as string, fetchImpl.mock.calls[0]?.[1] as RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/jobs/job-1/stream');
    expect((init.headers as Headers).get('accept')).toBe('text/event-stream');
  });
});

describe('JobsResource#waitFor', () => {
  it('resolves via the SSE stream once a terminal status frame arrives', async () => {
    const frames = [`data: ${JSON.stringify(RUNNING_STATUS)}\n\n`, `data: ${JSON.stringify(COMPLETED_STATUS)}\n\n`];
    const fetchImpl = fetchMock(async () => sseResponse(frames));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const sleep = vi.fn(async () => {});
    const jobs = new JobsResource(transport, sleep);

    const result = await jobs.waitFor('job-1');
    expect(result).toEqual(COMPLETED_STATUS);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a FAILED status carrying its own `error` field is still recognized as terminal (not confused with the not-found frame shape)', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([`data: ${JSON.stringify(FAILED_WITH_ERROR_FIELD)}\n\n`]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport, vi.fn(async () => {}));

    const result = await jobs.waitFor('job-1');
    expect(result).toEqual(FAILED_WITH_ERROR_FIELD);
  });

  it('falls back to polling when the SSE stream ends without a terminal frame', async () => {
    const fetchImpl = fetchMock(async (input) => {
      const url = String(input);
      if (url.includes('/stream')) {
        // Connection drops immediately — stream completes with no frames at all.
        return sseResponse([]);
      }
      return jsonResponse(200, COMPLETED_STATUS);
    });
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const sleep = vi.fn(async () => {});
    const jobs = new JobsResource(transport, sleep);

    const result = await jobs.waitFor('job-1', { pollIntervalMs: 50 });
    expect(result).toEqual(COMPLETED_STATUS);
  });

  it('falls back to polling and eventually resolves once the polled status is terminal', async () => {
    let pollCalls = 0;
    const fetchImpl = fetchMock(async (input) => {
      const url = String(input);
      if (url.includes('/stream')) return sseResponse([]);
      pollCalls += 1;
      return jsonResponse(200, pollCalls < 2 ? RUNNING_STATUS : COMPLETED_STATUS);
    });
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const sleep = vi.fn(async () => {});
    const jobs = new JobsResource(transport, sleep);

    const result = await jobs.waitFor('job-1', { pollIntervalMs: 10 });
    expect(result).toEqual(COMPLETED_STATUS);
    expect(pollCalls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('treats a not-found stream frame as non-terminal and lets the poll fallback surface NotFoundError', async () => {
    const fetchImpl = fetchMock(async (input) => {
      const url = String(input);
      if (url.includes('/stream')) return sseResponse([`data: ${JSON.stringify({ error: 'Job not found', jobId: 'missing' })}\n\n`]);
      return jsonResponse(404, { message: 'Job missing not found' });
    });
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const jobs = new JobsResource(transport, vi.fn(async () => {}));

    await expect(jobs.waitFor('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects immediately when called with an already-aborted signal', async () => {
    const fetchImpl = fetchMock(async () => sseResponse([]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const jobs = new JobsResource(transport, vi.fn(async () => {}));
    const controller = new AbortController();
    controller.abort();

    await expect(jobs.waitFor('job-1', { signal: controller.signal })).rejects.toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates an abort that fires mid-stream instead of falling back to polling', async () => {
    const { response } = hangingSseResponse();
    const fetchImpl = fetchMock(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          // Only resolve if never aborted — but the test aborts, so this path isn't reached.
          void resolve;
          void response;
        }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const jobs = new JobsResource(transport, vi.fn(async () => {}));
    const controller = new AbortController();

    const pending = jobs.waitFor('job-1', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeTruthy();
    // Only the stream attempt happened — no poll fallback (abort propagated instead).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
