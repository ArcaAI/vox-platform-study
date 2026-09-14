import { describe, expect, it, vi } from 'vitest';

import { DnaIngestJobTimeoutError } from '../../core/errors';
import { Transport } from '../../core/transport';
import type { DnaIngestJobStatus } from '../../types/dna-writing-style';
import { DnaWritingStyleResource } from '../dna-writing-style';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function callArgs(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0): [string, RequestInit] {
  const call = fetchImpl.mock.calls[callIndex];
  if (!call) throw new Error(`fetchImpl was not called (index ${callIndex})`);
  return [call[0] as string, call[1] as RequestInit];
}

const PENDING_RESPONSE = {
  jobId: 'job-1',
  status: 'PENDING' as const,
  clinicianUserId: 'doctor-1',
  acceptedItems: 2,
  window: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
};

const QUEUED_STATUS: DnaIngestJobStatus = { jobId: 'job-1', status: 'queued' };
const PROCESSING_STATUS: DnaIngestJobStatus = { jobId: 'job-1', status: 'processing', progress: 40 };
const COMPLETED_STATUS: DnaIngestJobStatus = { jobId: 'job-1', status: 'completed', progress: 100, result: { styleText: 'x' } };
const FAILED_STATUS: DnaIngestJobStatus = { jobId: 'job-1', status: 'failed', error: 'DNA_ANALYST_AGENT_UNAVAILABLE' };

describe('DnaWritingStyleResource#ingest', () => {
  it('POSTs the request body verbatim to dna-writing-styles/ingest, under the api/v1 prefix', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(202, PENDING_RESPONSE));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', apiKey: 'key', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport);

    const request = {
      clinicianUserId: 'doctor-1',
      items: [
        { text: 'note one', writtenAt: '2026-01-01T00:00:00Z', kind: 'CASE_NOTE' as const },
        { text: 'note two', writtenAt: '2026-01-02T00:00:00Z' },
      ],
    };

    const result = await resource.ingest(request);

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/dna-writing-styles/ingest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(result).toEqual(PENDING_RESPONSE);
  });

  it('sends the caller idempotencyKey as an Idempotency-Key header', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(202, PENDING_RESPONSE));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport);

    await resource.ingest({ items: [{ text: 'note', writtenAt: '2026-01-01T00:00:00Z' }] }, { idempotencyKey: 'order-42' });

    const [, init] = callArgs(fetchImpl);
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('order-42');
  });

  it('mints an Idempotency-Key when idempotent: true and no explicit key is given', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(202, PENDING_RESPONSE));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport);

    await resource.ingest({ items: [{ text: 'note', writtenAt: '2026-01-01T00:00:00Z' }] }, { idempotent: true });

    const [, init] = callArgs(fetchImpl);
    const key = new Headers(init.headers).get('Idempotency-Key');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('sends no Idempotency-Key header when neither idempotencyKey nor idempotent is given', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(202, PENDING_RESPONSE));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport);

    await resource.ingest({ items: [{ text: 'note', writtenAt: '2026-01-01T00:00:00Z' }] });

    const [, init] = callArgs(fetchImpl);
    expect(new Headers(init.headers).has('Idempotency-Key')).toBe(false);
  });
});

describe('DnaWritingStyleResource#getIngestJob', () => {
  it('GETs dna-writing-styles/ingest/jobs/{jobId}, percent-encoding the id', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, COMPLETED_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport);

    const result = await resource.getIngestJob('job/weird id');

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/dna-writing-styles/ingest/jobs/job%2Fweird%20id');
    expect(init.method === undefined || init.method === 'GET').toBe(true);
    expect(result).toEqual(COMPLETED_STATUS);
  });
});

describe('DnaWritingStyleResource#waitForIngestJob', () => {
  it('resolves once polling reports a completed status', async () => {
    let calls = 0;
    const fetchImpl = fetchMock(async () => {
      calls += 1;
      return jsonResponse(200, calls < 2 ? PROCESSING_STATUS : COMPLETED_STATUS);
    });
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const sleep = vi.fn(async () => {});
    const resource = new DnaWritingStyleResource(transport, sleep);

    const result = await resource.waitForIngestJob('job-1', { pollIntervalMs: 10 });

    expect(result).toEqual(COMPLETED_STATUS);
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('resolves (does not throw) once polling reports a failed status', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, FAILED_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport, vi.fn(async () => {}));

    const result = await resource.waitForIngestJob('job-1');

    expect(result).toEqual(FAILED_STATUS);
  });

  it('never calls the (nonexistent) stream route — only polls the job-status GET', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, COMPLETED_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport, vi.fn(async () => {}));

    await resource.waitForIngestJob('job-1');

    const [url] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/dna-writing-styles/ingest/jobs/job-1');
    expect(url).not.toContain('/stream');
  });

  it('treats "queued" as non-terminal and keeps polling', async () => {
    let calls = 0;
    const fetchImpl = fetchMock(async () => {
      calls += 1;
      return jsonResponse(200, calls < 2 ? QUEUED_STATUS : COMPLETED_STATUS);
    });
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport, vi.fn(async () => {}));

    const result = await resource.waitForIngestJob('job-1');
    expect(result).toEqual(COMPLETED_STATUS);
    expect(calls).toBe(2);
  });

  it('throws DnaIngestJobTimeoutError once timeoutMs elapses without a terminal status', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, PROCESSING_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    // A real (tiny) sleep — the loop must observe wall-clock time passing the deadline.
    const resource = new DnaWritingStyleResource(transport);

    await expect(resource.waitForIngestJob('job-1', { pollIntervalMs: 5, timeoutMs: 15 })).rejects.toBeInstanceOf(DnaIngestJobTimeoutError);
  });

  it('rejects immediately when called with an already-aborted signal, without calling fetch', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, PROCESSING_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new DnaWritingStyleResource(transport, vi.fn(async () => {}));
    const controller = new AbortController();
    controller.abort();

    await expect(resource.waitForIngestJob('job-1', { signal: controller.signal })).rejects.toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates an abort that fires between polls instead of continuing to poll', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, PROCESSING_STATUS));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const controller = new AbortController();
    // The injected sleep aborts instead of actually waiting, simulating an abort that arrives while parked between polls.
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const resource = new DnaWritingStyleResource(transport, sleep);

    await expect(resource.waitForIngestJob('job-1', { signal: controller.signal, timeoutMs: 60_000 })).rejects.toBeTruthy();
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
