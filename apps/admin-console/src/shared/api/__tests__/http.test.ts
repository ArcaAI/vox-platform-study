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

  // TASK-983 R5: behind a compressing intermediary (Cloudflare / Traefik in
  // front of the deployed gateway) the proxy WEAKENS the validator it was
  // given — `etag: W/"7"` together with `content-encoding: gzip`. The console
  // used to drop any `W/` token, so every If-Match surface lost its ETag and
  // either disabled its button (governance Approve) or sent no precondition
  // (428). Normalising the weak form back to its strong opaque tag keeps the
  // row version intact; the gateway only ever mints `"<n>"`, so the entity-tag
  // inside the wrapper is byte-identical to what it stamped.
  it('normalises a WEAK validator back to the strong form (compressing proxy)', async () => {
    installFetchMock(() => Response.json({ id: 't-1', _version: 7 }, { headers: { etag: 'W/"7"' } }));

    const result = await request<{ id: string }>('admin/tenants/t-1');

    expect(result.etag).toBe('"7"');
    expect(versionFromEtag(result.etag!)).toBe(7);
  });

  it('returns null when the response carries no ETag at all', async () => {
    installFetchMock(() => Response.json({ id: 't-1' }));

    const result = await request<{ id: string }>('admin/tenants/t-1');

    expect(result.etag).toBeNull();
  });

  it('sends a normalised weak ETag as a STRONG If-Match on the next write', async () => {
    // `@ExpectedVersion()` rejects `If-Match: W/"7"` with 400, so the wire
    // value must be the strong form even when the read was weakened.
    const calls = installFetchMock(() => Response.json({ id: 't-1', _version: 8 }, { headers: { etag: 'W/"8"' } }));

    const read = await request<{ id: string }>('admin/tenants/t-1');
    const result = await request<{ id: string }>('admin/tenants/t-1', { method: 'PATCH', body: { name: 'N' }, etag: read.etag! });

    expect(calls[1].headers.get('if-match')).toBe('"8"');
    expect(result.etag).toBe('"8"');
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

  it('carries the raw parsed error body as `details`, for callers that need fields beyond `message`', async () => {
    // e.g. `POST admin/consultation-context-schemas/:id/publish` returns
    // `{ message, problems: string[] }` on a structural 400 and
    // `{ message, breakingChanges: string[] }` on a refused breaking change —
    // both need to survive past `toGatewayError`'s `message`-only extraction.
    installFetchMock(() =>
      Response.json(
        { statusCode: 400, message: 'The context schema definition is not publishable.', problems: ['kinds[0].primitive is invalid'] },
        { status: 400 },
      ),
    );

    const error = (await request('admin/consultation-context-schemas/s-1/publish', { method: 'POST', body: {} }).catch(
      (caught: unknown) => caught,
    )) as GatewayError;

    expect(error.message).toBe('The context schema definition is not publishable.');
    expect((error.details as { problems?: string[] } | undefined)?.problems).toEqual(['kinds[0].primitive is invalid']);
  });

  it('has undefined `details` when the error body could not be parsed as JSON', async () => {
    installFetchMock(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));

    const error = (await request('admin/tenants').catch((caught: unknown) => caught)) as GatewayError;

    expect(error.details).toBeUndefined();
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
