import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { ConsultationsResource } from '../consultations';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

const CONSULTATION = {
  id: 'c1',
  patientId: 'p1',
  doctorId: 'd1',
  appointmentDate: '2026-01-01',
  status: 'OPEN' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ConsultationsResource#get', () => {
  it('GETs /api/v1/consultations/:id and returns the parsed response', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, CONSULTATION));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    const result = await resource.get('c1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c1');
    expect(result).toEqual(CONSULTATION);
  });

  it('percent-encodes the id', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, CONSULTATION));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.get('c/1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c%2F1');
  });

  it('exposes a .summaries sub-resource wired to the same transport', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, [CONSULTATION]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    expect(resource.summaries).toBeDefined();
    await resource.summaries.list('c1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c1/summary');
  });
});

// -----------------------------------------------------------------------------
// addContext
// -----------------------------------------------------------------------------

const CONTEXT_ITEM = {
  id: 'ci1',
  consultationId: 'c1',
  type: 'CASE_NOTE' as const,
  source: 'USER' as const,
  content: 'Patient reports intermittent chest pain.',
  currentVersionNumber: 1,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function headerOf(call: Parameters<typeof fetch>[1], name: string): string | null {
  return new Headers((call as RequestInit).headers).get(name);
}

describe('ConsultationsResource#addContext', () => {
  it('POSTs the body to /api/v1/consultations/:id/context and returns the parsed item', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(201, CONTEXT_ITEM));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    const result = await resource.addContext('c1', { type: 'CASE_NOTE', content: 'Patient reports intermittent chest pain.' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/context');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      type: 'CASE_NOTE',
      content: 'Patient reports intermittent chest pain.',
    });
    expect(result).toEqual(CONTEXT_ITEM);
  });

  it('percent-encodes the consultation id', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(201, CONTEXT_ITEM));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.addContext('c/1', { type: 'CASE_NOTE', content: 'x' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c%2F1/context');
  });

  it('pins the write with X-Context-Schema-Version when the caller supplies one', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(201, CONTEXT_ITEM));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.addContext(
      'c1',
      { type: 'STRUCTURED', kindKey: 'vitals', payload: { systolic: 128 } },
      { contextSchemaVersionId: '0199-abc' },
    );

    expect(headerOf(fetchImpl.mock.calls[0]?.[1], 'X-Context-Schema-Version')).toBe('0199-abc');
  });

  it('omits X-Context-Schema-Version entirely when no version is supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(201, CONTEXT_ITEM));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.addContext('c1', { type: 'CASE_NOTE', content: 'x' });

    expect(headerOf(fetchImpl.mock.calls[0]?.[1], 'X-Context-Schema-Version')).toBeNull();
  });

  it('rejects a payload with no kindKey locally, without issuing a request', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(201, CONTEXT_ITEM));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await expect(resource.addContext('c1', { type: 'STRUCTURED', payload: { systolic: 128 } })).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry — the route takes no idempotency key, so the POST is non-idempotent', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(503, { message: 'unavailable' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 3, sleep: async () => {} });
    const resource = new ConsultationsResource(transport);

    await expect(resource.addContext('c1', { type: 'CASE_NOTE', content: 'x' })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
