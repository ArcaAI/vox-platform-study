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

    await resource.addContext('c1', { type: 'STRUCTURED', kindKey: 'vitals', payload: { systolic: 128 } }, { contextSchemaVersionId: '0199-abc' });

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

// -----------------------------------------------------------------------------
// listContext
// -----------------------------------------------------------------------------

const CONTEXT_ITEM_WITH_KIND = {
  ...CONTEXT_ITEM,
  id: 'ci2',
  kindKey: 'vitals',
  contextSchemaVersionId: 'schema-version-1',
};

describe('ConsultationsResource#listContext', () => {
  it('GETs /api/v1/consultations/:id/context and returns the parsed array', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, [CONTEXT_ITEM, CONTEXT_ITEM_WITH_KIND]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    const result = await resource.listContext('c1');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/context');
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    expect(result).toEqual([CONTEXT_ITEM, CONTEXT_ITEM_WITH_KIND]);
  });

  it('reads kindKey and contextSchemaVersionId back on items that declared them', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, [CONTEXT_ITEM_WITH_KIND]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    const [item] = await resource.listContext('c1');
    expect(item?.kindKey).toBe('vitals');
    expect(item?.contextSchemaVersionId).toBe('schema-version-1');
  });

  it('percent-encodes the consultation id', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, []));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.listContext('c/1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c%2F1/context');
  });

  it('returns an empty array for a consultation with no context items, not an error', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, []));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await expect(resource.listContext('c1')).resolves.toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// documentSections — the DURABLE, template-shaped read of the clinical note
// -----------------------------------------------------------------------------

const SECTION = {
  id: 'ds1',
  consultationId: 'c1',
  documentKey: 'arcaai-bren-soap-revisit',
  sectionKey: 'subjective',
  title: 'Subjective',
  idx: 0,
  state: 'provisional' as const,
  revision: 3,
  version: 4,
  content: 'Cough since monday.',
  annotations: [{ kind: 'entity' as const, start: 0, end: 5, type: 'SYMPTOM', transcriptSegmentId: 'utt-0', transcriptStart: 0, transcriptEnd: 5 }],
  createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:01:00Z',
};

describe('ConsultationsResource#documentSections', () => {
  it('GETs the DISCOVERY route when no documentKey is given', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, [SECTION]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    const sections = await resource.documentSections('c1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c1/documents/sections');
    expect(sections).toEqual([SECTION]);
    // `version` is the `If-Match` operand and `revision` is the stream-ordering token. A client
    // that sends the wrong one gets a 412 it cannot explain, so both survive the round trip.
    expect(sections[0].version).toBe(4);
    expect(sections[0].revision).toBe(3);
    // A2 — the transcript anchor rides through on the section's annotations.
    expect(sections[0].annotations?.[0]).toMatchObject({ transcriptSegmentId: 'utt-0', transcriptStart: 0, transcriptEnd: 5 });
  });

  it('GETs the single-document route when a documentKey is given', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, [SECTION]));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.documentSections('c1', 'arcaai-bren-soap-revisit');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c1/documents/arcaai-bren-soap-revisit/sections');
  });

  it('percent-encodes BOTH path segments', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, []));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.documentSections('c/1', 'soap/note');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c%2F1/documents/soap%2Fnote/sections');
  });

  it('returns an empty array for a consultation whose documents have not been written', async () => {
    // Not a 404. A consultation that has not generated yet is a normal, expected state — the 404
    // on this route means the CONSULTATION is missing (or another tenant's).
    const fetchImpl = fetchMock(async () => jsonResponse(200, []));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await expect(resource.documentSections('c1')).resolves.toEqual([]);
  });

  it('is a GET, so the transport RETRIES it', async () => {
    let calls = 0;
    const fetchImpl = fetchMock(async () => (++calls < 3 ? jsonResponse(503, { message: 'unavailable' }) : jsonResponse(200, [SECTION])));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 3, sleep: async () => {} });
    const resource = new ConsultationsResource(transport);

    await expect(resource.documentSections('c1')).resolves.toEqual([SECTION]);
    expect(calls).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// close (TASK-972 Lane 5)
// -----------------------------------------------------------------------------

describe('ConsultationsResource#close', () => {
  it('POSTs /api/v1/consultations/:id/close and returns the parsed response', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, { ...CONSULTATION, status: 'CLOSED_COMPLETE' as const }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    const result = await resource.close('c1', {}, { ifMatch: '"7"' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/close');
    expect((init as RequestInit).method).toBe('POST');
    expect(result).toEqual({ ...CONSULTATION, status: 'CLOSED_COMPLETE' });
  });

  it('percent-encodes the consultation id', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, CONSULTATION));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.close('c/1', {}, { ifMatch: '"7"' });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c%2F1/close');
  });

  it('sends the required If-Match header', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, CONSULTATION));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.close('c1', {}, { ifMatch: '"7"' });

    expect(headerOf(fetchImpl.mock.calls[0]![1], 'if-match')).toBe('"7"');
  });

  it('sends clinicianUserId in the body when supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, CONSULTATION));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.close('c1', { clinicianUserId: 'clinician-1' }, { ifMatch: '"7"' });

    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ clinicianUserId: 'clinician-1' });
  });

  it('omits clinicianUserId from the body when not supplied', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, CONSULTATION));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const resource = new ConsultationsResource(transport);

    await resource.close('c1', {}, { ifMatch: '"7"' });

    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({});
  });

  it('surfaces a 412 response as VersionConflictError carrying currentVersion', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(412, { message: 'Version conflict', metadata: { currentVersion: 5 } }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const resource = new ConsultationsResource(transport);

    await expect(resource.close('c1', {}, { ifMatch: '"3"' })).rejects.toMatchObject({
      status: 412,
      currentVersion: 5,
    });
  });
});
