import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, buildQuery, hopeUrl, request, versionFromEtag } from '../http';

interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function installFetchMock(handler: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const requestInit = init ?? {};
      const call: RecordedCall = { url, init: requestInit, headers: new Headers(requestInit.headers) };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildQuery', () => {
  it('serializes defined params and skips undefined/null', () => {
    expect(buildQuery({ page: 0, limit: 25, search: 'north', status: undefined, tenantId: null })).toBe('?page=0&limit=25&search=north');
  });

  it('returns an empty string when nothing remains', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });

  it('URL-encodes values and supports booleans', () => {
    expect(buildQuery({ q: 'a b&c', enabled: false })).toBe('?q=a+b%26c&enabled=false');
  });
});

describe('hopeUrl', () => {
  it('prefixes the BFF proxy mount and appends the query', () => {
    expect(hopeUrl('admin/tenants', { page: 1 })).toBe('/api/hope/admin/tenants?page=1');
    expect(hopeUrl('admin/tenants/t-1')).toBe('/api/hope/admin/tenants/t-1');
  });

  it('encodes path segments produced with segment()', () => {
    expect(hopeUrl(`admin/queues/${encodeURIComponent('audit log')}/jobs`)).toBe('/api/hope/admin/queues/audit%20log/jobs');
  });
});

describe('request with FormData', () => {
  it('passes FormData through untouched so the browser sets the multipart boundary', async () => {
    const calls = installFetchMock(() => Response.json({ key: 'a.wav' }));
    const form = new FormData();
    form.set('file', new Blob(['x']), 'a.wav');
    await request('admin/tenants/storage/buckets/b-1/objects', { method: 'POST', body: form, params: { key: 'a.wav' } });
    expect(calls[0].headers.get('content-type')).toBeNull();
    expect(calls[0].init.body).toBeInstanceOf(FormData);
  });
});

describe('versionFromEtag', () => {
  it('parses the quoted strong validator into the numeric row version', () => {
    // Versioned PATCH routes validate a REQUIRED body `expectedVersion`
    // besides the If-Match header (header wins server-side) — clients
    // must derive the number from the captured ETag.
    expect(versionFromEtag('"7"')).toBe(7);
    expect(versionFromEtag('12')).toBe(12);
  });

  it('throws on a malformed ETag so the client bug is loud', () => {
    expect(() => versionFromEtag('W/"abc"')).toThrow(/ETag/);
    expect(() => versionFromEtag('')).toThrow(/ETag/);
  });
});

describe('request', () => {
  it('GETs the proxied path and returns the parsed JSON envelope', async () => {
    const calls = installFetchMock(() => Response.json({ data: [{ id: 't-1' }], count: 1, limit: 25, page: 0 }));

    const result = await request<{ data: { id: string }[]; count: number }>('admin/tenants', { params: { page: 0, limit: 25 } });

    expect(calls[0].url).toBe('/api/hope/admin/tenants?page=0&limit=25');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(result.data.data).toEqual([{ id: 't-1' }]);
    expect(result.data.count).toBe(1);
  });

  it('captures the ETag response header for versioned reads', async () => {
    installFetchMock(() => Response.json({ id: 't-1', _version: 7 }, { headers: { etag: '"7"' } }));

    const result = await request<{ id: string }>('admin/tenants/t-1');

    expect(result.etag).toBe('"7"');
  });

  it('sends JSON bodies and the If-Match header on mutations', async () => {
    const calls = installFetchMock(() => Response.json({ id: 't-1', _version: 8 }, { headers: { etag: '"8"' } }));

    const result = await request<{ id: string }>('admin/tenants/t-1', {
      method: 'PATCH',
      body: { name: 'Northwind' },
      etag: '"7"',
    });

    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].headers.get('if-match')).toBe('"7"');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'Northwind' });
    expect(result.etag).toBe('"8"');
  });

  it('returns undefined data for empty (204) responses', async () => {
    installFetchMock(() => new Response(null, { status: 204 }));

    const result = await request<void>('admin/tenants/t-1', { method: 'DELETE' });

    expect(result.data).toBeUndefined();
  });

  it('throws a GatewayError carrying the gateway message and status', async () => {
    installFetchMock(() => Response.json({ statusCode: 401, message: 'Unauthorized' }, { status: 401 }));

    const error = await request('admin/users').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(401);
    expect((error as GatewayError).message).toBe('Unauthorized');
    expect((error as GatewayError).isUnauthorized).toBe(true);
  });

  it('joins array validation messages', async () => {
    installFetchMock(() => Response.json({ statusCode: 400, message: ['name is required', 'slug is invalid'] }, { status: 400 }));

    const error = (await request('admin/ai-models', { method: 'POST', body: {} }).catch((caught: unknown) => caught)) as GatewayError;

    expect(error.message).toBe('name is required; slug is invalid');
  });

  it('falls back to the HTTP status text for non-JSON error bodies', async () => {
    installFetchMock(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));

    const error = (await request('admin/tenants').catch((caught: unknown) => caught)) as GatewayError;

    expect(error.status).toBe(502);
    expect(error.message).toBe('Request failed with status 502');
  });

  it('maps the tenancy and concurrency statuses to semantic flags', async () => {
    const byStatus = async (status: number): Promise<GatewayError> => {
      installFetchMock(() => Response.json({ statusCode: status, message: 'x' }, { status }));
      return (await request('admin/tenants/t-1').catch((caught: unknown) => caught)) as GatewayError;
    };

    // 404-over-403: a cross-tenant read is reported as "not yours", never 403.
    expect((await byStatus(404)).isNotFound).toBe(true);
    // 412: the row moved under the edit (ETag drift) — reload and reapply.
    expect((await byStatus(412)).isVersionConflict).toBe(true);
    // 428: the PATCH forgot If-Match — a client bug, not a user error.
    expect((await byStatus(428)).isMissingPrecondition).toBe(true);
    expect((await byStatus(404)).isVersionConflict).toBe(false);
  });
});
