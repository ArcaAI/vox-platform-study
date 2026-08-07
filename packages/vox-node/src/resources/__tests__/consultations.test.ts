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
