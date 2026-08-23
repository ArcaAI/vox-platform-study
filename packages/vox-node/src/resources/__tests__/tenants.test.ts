import { describe, expect, it, vi } from 'vitest';

import { HopeClient } from '../../client';
import { Transport } from '../../core/transport';
import { TenantsResource } from '../tenants';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

const BUNDLE = {
  schemaId: 's1',
  slug: 'general_medicine',
  name: 'General Medicine',
  versionNumber: 3,
  contextSchemaVersionId: '0199-abc',
  checksum: 'sha256:deadbeef',
  definition: {
    schemaVersion: '1.0',
    kinds: [
      { key: 'vitals', label: 'Vitals', primitive: 'STRUCTURED', phiClass: 'PHI', cardinality: 'ONE', lifecycle: 'DURING', producedBy: ['CLIENT'] },
    ],
  },
  etag: '"sha256:deadbeef"',
};

const UNCONFIGURED = {
  schemaId: null,
  slug: null,
  name: null,
  versionNumber: null,
  contextSchemaVersionId: null,
  checksum: null,
  definition: null,
  etag: 'none',
};

describe('TenantsResource#contextSchema', () => {
  it('GETs the PLURAL /api/v1/tenants/me/context-schema and returns the parsed bundle', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, BUNDLE));
    const resource = new TenantsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));

    const result = await resource.contextSchema();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/tenants/me/context-schema');
    expect(result).toEqual(BUNDLE);
  });

  it('passes departmentId as a query parameter so a department schema can shadow the tenant default', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, BUNDLE));
    const resource = new TenantsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));

    await resource.contextSchema({ departmentId: 'dep 1' });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/tenants/me/context-schema?departmentId=dep+1');
  });

  it('sends no query string when no department is named', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, BUNDLE));
    const resource = new TenantsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));

    await resource.contextSchema();

    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('?');
  });

  it('returns the unconfigured bundle as an ordinary value — 200 with nulls is not an error', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, UNCONFIGURED));
    const resource = new TenantsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));

    const result = await resource.contextSchema();

    expect(result).toEqual(UNCONFIGURED);
    expect(result.definition).toBeNull();
    expect(result.etag).toBe('none');
  });
});

describe('HopeClient.tenants', () => {
  it('is wired to the same transport as the rest of the client', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, BUNDLE));
    const hope = new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'k', fetch: fetchImpl });

    const bundle = await hope.tenants.contextSchema();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/tenants/me/context-schema');
    expect(new Headers((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).get('X-API-Key')).toBe('k');
    expect(bundle.contextSchemaVersionId).toBe('0199-abc');
  });
});
