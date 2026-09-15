import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { ConsultationSummariesResource } from '../consultation-summaries';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function callArgs(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0): [string, RequestInit] {
  const call = fetchImpl.mock.calls[callIndex];
  if (!call) throw new Error(`fetchImpl was not called (index ${callIndex})`);
  return [call[0] as string, call[1] as RequestInit];
}

const SUMMARY = {
  id: 'sum-1',
  consultationId: 'c1',
  type: 'summary' as const,
  content: 'the summary',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ConsultationSummariesResource#generate', () => {
  it('POSTs /api/v1/consultations/:id/summary', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.generate('c1', { transcription: 'hello' });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary');
    expect(init.method).toBe('POST');
    expect(result).toEqual(SUMMARY);
  });

  it('does not auto-generate an idempotencyKey when omitted (sync route ignores it)', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generate('c1', {});

    const [, init] = callArgs(fetchImpl);
    const body = JSON.parse(init.body as string);
    expect(body.idempotencyKey).toBeUndefined();
  });

  it('lets an explicit idempotencyKey option land in the body', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generate('c1', {}, { idempotencyKey: 'key-123' });

    const [, init] = callArgs(fetchImpl);
    const body = JSON.parse(init.body as string);
    expect(body.idempotencyKey).toBe('key-123');
  });

  it('percent-encodes the consultation id in the path', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generate('c/1', {});

    const [url] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c%2F1/summary');
  });
});

describe('ConsultationSummariesResource#generatePreSummary', () => {
  it('POSTs /api/v1/consultations/:id/summary/pre-summary', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, { ...SUMMARY, type: 'pre_summary' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generatePreSummary('c1', { caseNoteIds: ['n1'] });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary/pre-summary');
    expect(init.method).toBe('POST');
  });
});

describe('ConsultationSummariesResource#generateAsync', () => {
  const asyncResponse = { jobId: 'job-1', status: 'pending' as const, consultationId: 'c1', createdAt: '2026-01-01T00:00:00Z' };

  it('POSTs /api/v1/consultations/:id/summary/async and returns the AsyncJobResponse', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, asyncResponse));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.generateAsync('c1', {});

    const [url] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary/async');
    expect(result).toEqual(asyncResponse);
  });

  it('auto-generates a UUIDv7 idempotencyKey in the body when the caller omits one', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, asyncResponse));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generateAsync('c1', {});

    const [, init] = callArgs(fetchImpl);
    const body = JSON.parse(init.body as string);
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('respects a caller-supplied idempotencyKey instead of generating one', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, asyncResponse));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generateAsync('c1', { idempotencyKey: 'caller-key' });

    const [, init] = callArgs(fetchImpl);
    const body = JSON.parse(init.body as string);
    expect(body.idempotencyKey).toBe('caller-key');
  });

  it('retries once on a 503 because the auto-generated key makes the POST idempotent', async () => {
    let calls = 0;
    const fetchImpl = fetchMock(async () => {
      calls += 1;
      if (calls < 2) return jsonResponse(503, { message: 'unavailable' });
      return jsonResponse(200, asyncResponse);
    });
    const sleep = vi.fn(async () => {});
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 2, random: () => 0.1, sleep });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.generateAsync('c1', {});
    expect(result).toEqual(asyncResponse);
    expect(calls).toBe(2);
  });
});

describe('ConsultationSummariesResource#generatePreSummaryAsync', () => {
  it('POSTs /api/v1/consultations/:id/summary/pre-summary/async with an auto-generated idempotencyKey', async () => {
    const asyncResponse = { jobId: 'job-2', status: 'pending' as const, consultationId: 'c1', createdAt: '2026-01-01T00:00:00Z' };
    const fetchImpl = fetchMock(async () => jsonResponse(200, asyncResponse));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.generatePreSummaryAsync('c1', {});

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary/pre-summary/async');
    const body = JSON.parse(init.body as string);
    expect(typeof body.idempotencyKey).toBe('string');
  });
});

describe('ConsultationSummariesResource#list/latest/latestPreSummary', () => {
  it('list GETs /api/v1/consultations/:id/summary', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, [SUMMARY]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.list('c1');
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result).toEqual([SUMMARY]);
  });

  it('latest GETs /api/v1/consultations/:id/summary/latest', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.latest('c1');
    expect(callArgs(fetchImpl)[0]).toBe('http://localhost:8868/api/v1/consultations/c1/summary/latest');
    expect(result).toEqual(SUMMARY);
  });

  it('latestPreSummary GETs /api/v1/consultations/:id/summary/pre-summary/latest', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, null));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.latestPreSummary('c1');
    expect(callArgs(fetchImpl)[0]).toBe('http://localhost:8868/api/v1/consultations/c1/summary/pre-summary/latest');
    expect(result).toBeNull();
  });
});

describe('ConsultationSummariesResource#update', () => {
  it('PATCHes /api/v1/consultations/:id/summary/:summaryId', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.update('c1', 'sum-1', { content: 'edited' });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary/sum-1');
    expect(init.method).toBe('PATCH');
    expect(result).toEqual(SUMMARY);
  });

  it('sends an If-Match header when ifMatch is supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.update('c1', 'sum-1', { content: 'edited' }, { ifMatch: '"3"' });

    const [, init] = callArgs(fetchImpl);
    const headers = init.headers as Headers;
    expect(headers.get('if-match')).toBe('"3"');
  });

  it('omits the If-Match header when ifMatch is not supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.update('c1', 'sum-1', { content: 'edited' });

    const [, init] = callArgs(fetchImpl);
    const headers = init.headers as Headers;
    expect(headers.get('if-match')).toBeNull();
  });

  it('surfaces a 412 response as VersionConflictError carrying currentVersion', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(412, { message: 'Version conflict', metadata: { currentVersion: 5 } }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const resource = new ConsultationSummariesResource(transport);

    await expect(resource.update('c1', 'sum-1', { content: 'edited' }, { ifMatch: '"3"' })).rejects.toMatchObject({
      status: 412,
      currentVersion: 5,
    });
  });
});

describe('ConsultationSummariesResource — synchronous generation timeouts (TASK-946)', () => {
  // A four-note BREN pre-summary took 46–68 s on the dev box while the transport's 60 s default
  // gave up first (§5.1 of the ticket): the SYNCHRONOUS generation routes are long by nature, so
  // they carry their own floor — overridable per call, and never above an integrator's explicit
  // client-level `timeoutMs`.
  function spiedResource(config: { timeoutMs?: number } = {}) {
    const fetchImpl = fetchMock(async () => jsonResponse(200, SUMMARY));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, ...config });
    const request = vi.spyOn(transport, 'request');
    return { resource: new ConsultationSummariesResource(transport), request };
  }

  it('generatePreSummary defaults to the 180 s generation floor when the client sets no timeout', async () => {
    const { resource, request } = spiedResource();
    await resource.generatePreSummary('c1', {});
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 180_000 }));
  });

  it('generate (sync summary) carries the same generation floor', async () => {
    const { resource, request } = spiedResource();
    await resource.generate('c1', { transcription: 'hello' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 180_000 }));
  });

  it('an explicit client-level timeoutMs wins over the generation floor', async () => {
    const { resource, request } = spiedResource({ timeoutMs: 45_000 });
    await resource.generatePreSummary('c1', {});
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 }));
  });

  it('a per-call timeoutMs wins over both', async () => {
    const { resource, request } = spiedResource({ timeoutMs: 45_000 });
    await resource.generatePreSummary('c1', {}, { timeoutMs: 300_000 });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
  });

  it('the async routes and reads keep the transport default (no floor)', async () => {
    const { resource, request } = spiedResource();
    await resource.generatePreSummaryAsync('c1', {});
    await resource.latestPreSummary('c1');
    for (const call of request.mock.calls) expect(call[0]).not.toHaveProperty('timeoutMs');
  });
});

// -----------------------------------------------------------------------------
// approve (TASK-972 Lane 5)
// -----------------------------------------------------------------------------

const APPROVAL = {
  contextItemId: 'ci1',
  approvalStatus: 'APPROVED',
  approvedBy: 'clinician-1',
  approvedAt: '2026-01-01T00:00:00Z',
};

describe('ConsultationSummariesResource#approve', () => {
  it('POSTs /api/v1/consultations/:id/summary/:contextItemId/approve', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, APPROVAL));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    const result = await resource.approve('c1', 'ci1', {}, { ifMatch: '"7"' });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/summary/ci1/approve');
    expect(init.method).toBe('POST');
    expect(result).toEqual(APPROVAL);
  });

  it('percent-encodes both the consultation id and the context item id', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, APPROVAL));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.approve('c/1', 'ci/1', {}, { ifMatch: '"7"' });

    const [url] = callArgs(fetchImpl);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c%2F1/summary/ci%2F1/approve');
  });

  it('sends the required If-Match header', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, APPROVAL));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.approve('c1', 'ci1', {}, { ifMatch: '"7"' });

    const [, init] = callArgs(fetchImpl);
    const headers = init.headers as Headers;
    expect(headers.get('if-match')).toBe('"7"');
  });

  it('sends overrideSafetyFlag and clinicianUserId in the body when supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, APPROVAL));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.approve('c1', 'ci1', { overrideSafetyFlag: true, clinicianUserId: 'clinician-1' }, { ifMatch: '"7"' });

    const [, init] = callArgs(fetchImpl);
    expect(JSON.parse(init.body as string)).toEqual({ overrideSafetyFlag: true, clinicianUserId: 'clinician-1' });
  });

  it('omits clinicianUserId from the body when not supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, APPROVAL));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationSummariesResource(transport);

    await resource.approve('c1', 'ci1', {}, { ifMatch: '"7"' });

    const [, init] = callArgs(fetchImpl);
    expect(JSON.parse(init.body as string).clinicianUserId).toBeUndefined();
  });

  it('surfaces a 412 response as VersionConflictError carrying currentVersion', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(412, { message: 'Version conflict', metadata: { currentVersion: 5 } }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const resource = new ConsultationSummariesResource(transport);

    await expect(resource.approve('c1', 'ci1', {}, { ifMatch: '"3"' })).rejects.toMatchObject({
      status: 412,
      currentVersion: 5,
    });
  });
});
