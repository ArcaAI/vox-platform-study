import { describe, expect, it, vi } from 'vitest';
import { CodegenError } from '../errors';
import { fetchConsultationSchemaBundle } from '../fetch-schema';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('fetchConsultationSchemaBundle', () => {
  it('sends Authorization + X-Tenant-Id and hits the tenant/me/context-schema endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ schemaId: null, slug: null, name: null, versionNumber: null, contextSchemaVersionId: null, checksum: null, definition: null, etag: 'none' }));

    await fetchConsultationSchemaBundle({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      token: 'jwt-token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/tenant/me/context-schema');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token');
    expect((init.headers as Record<string, string>)['X-Tenant-Id']).toBe('tenant-1');
  });

  it('normalizes a baseUrl that already includes /api/v1', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ definition: null, etag: 'none' }));

    await fetchConsultationSchemaBundle({
      baseUrl: 'http://localhost:8868/api/v1/',
      tenantId: 'tenant-1',
      token: 'jwt-token',
      fetchImpl,
    });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8868/api/v1/tenant/me/context-schema');
  });

  it('appends departmentId as a query parameter when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ definition: null, etag: 'none' }));

    await fetchConsultationSchemaBundle({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      token: 'jwt-token',
      departmentId: 'dept-1',
      fetchImpl,
    });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8868/api/v1/tenant/me/context-schema?departmentId=dept-1');
  });

  it('parses a fully populated bundle', async () => {
    const body = {
      schemaId: 'schema-1',
      slug: 'default',
      name: 'Default',
      versionNumber: 2,
      contextSchemaVersionId: 'version-2',
      checksum: 'sum',
      definition: { schemaVersion: '1.0', kinds: [] },
      etag: '"2"',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));

    const bundle = await fetchConsultationSchemaBundle({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      token: 'jwt-token',
      fetchImpl,
    });

    expect(bundle).toEqual(body);
  });

  it('throws CodegenError on a non-2xx response, without swallowing it as "unconfigured" (unlike the SDK)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('unauthorized', { ok: false, status: 401, statusText: 'Unauthorized' }));

    await expect(
      fetchConsultationSchemaBundle({ baseUrl: 'http://localhost:8868', tenantId: 'tenant-1', token: 'bad-token', fetchImpl }),
    ).rejects.toThrow(CodegenError);
  });

  it('throws CodegenError when the network call itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      fetchConsultationSchemaBundle({ baseUrl: 'http://localhost:8868', tenantId: 'tenant-1', token: 'jwt-token', fetchImpl }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws CodegenError on a non-object response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('not-an-object'));

    await expect(
      fetchConsultationSchemaBundle({ baseUrl: 'http://localhost:8868', tenantId: 'tenant-1', token: 'jwt-token', fetchImpl }),
    ).rejects.toThrow(CodegenError);
  });
});
