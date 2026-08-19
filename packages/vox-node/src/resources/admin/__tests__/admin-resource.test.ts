import { describe, expect, it, vi } from 'vitest';

import { NotFoundError, PermissionError, PreconditionRequiredError, VersionConflictError } from '../../../core/errors';
import { Transport } from '../../../core/transport';
import { AdminResource, toIfMatchHeader } from '../admin-resource';
import type { AdminListOptions, AdminRequestOptions, IfMatchPrecondition, PaginatedPage } from '../admin-resource';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

interface Widget {
  id: string;
  version: number;
}

/**
 * Minimal concrete subclass — the shape every GENERATED admin resource takes:
 * a `svc:` scope declaration plus thin delegations to the base.
 */
class WidgetsResource extends AdminResource {
  readonly svcScope = 'svc:admin:widget:manage';

  get(id: string, options: AdminRequestOptions = {}): Promise<Widget> {
    return this.request<Widget>({ path: `admin/widgets/${id}`, ...options });
  }

  list(options?: AdminListOptions): Promise<PaginatedPage<Widget>> {
    return this.listPage<Widget>('admin/widgets', options);
  }

  listAllWidgets(options?: AdminListOptions): AsyncIterable<Widget> {
    return this.listAll<Widget>('admin/widgets', options);
  }

  update(id: string, body: Partial<Widget>, options: { ifMatch: IfMatchPrecondition }): Promise<Widget> {
    return this.requestWithPrecondition<Widget>({ method: 'PATCH', path: `admin/widgets/${id}`, body, ifMatch: options.ifMatch });
  }

  createWidget(body: Partial<Widget>): Promise<Widget> {
    return this.request<Widget>({ method: 'POST', path: 'admin/widgets', body });
  }

  // The three shapes generated code takes for a route widened by TASK-773
  // decision O-3: it also accepts the area's `:read` sibling, which it passes
  // down so the 403 names what THIS route wants rather than the area scope.
  readOnly(id: string): Promise<Widget> {
    return this.request<Widget>({ path: `admin/widgets/${id}`, svcScopes: WIDENED });
  }

  listReadOnly(options?: AdminListOptions): Promise<PaginatedPage<Widget>> {
    return this.listPage<Widget>('admin/widgets', options, WIDENED);
  }

  listAllReadOnly(options?: AdminListOptions): AsyncIterable<Widget> {
    return this.listAll<Widget>('admin/widgets', options, WIDENED);
  }
}

/** What a generated O-3 read route declares: the area scope plus its `:read` sibling. */
const WIDENED = ['svc:admin:widget:manage', 'svc:admin:widget:read'] as const;

function makeResource(fetchImpl: typeof fetch): WidgetsResource {
  return new WidgetsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 }));
}

function page(overrides: Partial<PaginatedPage<Widget>>): PaginatedPage<Widget> {
  return { count: 0, limit: 10, page: 0, data: [], ...overrides };
}

function widgets(from: number, howMany: number): Widget[] {
  return Array.from({ length: howMany }, (_, i) => ({ id: `w${from + i}`, version: 1 }));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('toIfMatchHeader', () => {
  it('renders a version number as an RFC 7232 strong validator', () => {
    expect(toIfMatchHeader(7)).toBe('"7"');
  });

  it("accepts version 0 — the gateway's create-intent FIRST_EDIT_ETAG convention", () => {
    expect(toIfMatchHeader(0)).toBe('"0"');
  });

  it('accepts a previously-read row directly, reading its `version`', () => {
    const row: Widget = { id: 'w1', version: 42 };
    expect(toIfMatchHeader(row)).toBe('"42"');
  });

  it('passes an already-quoted strong validator through unchanged', () => {
    expect(toIfMatchHeader('"42"')).toBe('"42"');
  });

  it('quotes a bare digit string', () => {
    expect(toIfMatchHeader('42')).toBe('"42"');
  });

  it.each(['W/"7"', '*', '"-1"', '"1.5"', '', 'abc'])('rejects %o locally instead of letting the gateway 400', (bad) => {
    expect(() => toIfMatchHeader(bad)).toThrow(TypeError);
  });

  it.each([-1, 1.5, Number.NaN])('rejects the non-version number %o', (bad) => {
    expect(() => toIfMatchHeader(bad)).toThrow(TypeError);
  });
});

describe('AdminResource — scope discoverability', () => {
  it('exposes the subclass svc: scope as a public readonly field', () => {
    expect(makeResource(fetchMock(async () => jsonResponse(200, {}))).svcScope).toBe('svc:admin:widget:manage');
  });

  it('names the required svc: scope in a 403 message, keeping the PermissionError class', async () => {
    const resource = makeResource(fetchMock(async () => jsonResponse(403, { message: 'Forbidden resource' })));

    await expect(resource.get('w1')).rejects.toBeInstanceOf(PermissionError);
    await expect(resource.get('w1')).rejects.toThrow(/svc:admin:widget:manage/);
  });

  it('preserves status/code/requestId when augmenting a 403', async () => {
    const resource = makeResource(
      fetchMock(async () => jsonResponse(403, { message: 'Forbidden resource', code: 'AUTH.FORBIDDEN' }, { 'x-request-id': 'req-9' })),
    );

    const error = (await resource.get('w1').catch((e: unknown) => e)) as PermissionError;
    expect(error.status).toBe(403);
    expect(error.code).toBe('AUTH.FORBIDDEN');
    expect(error.requestId).toBe('req-9');
    expect(error.message).toContain('Forbidden resource');
  });

  it('names EVERY scope a widened read route accepts, so a read-only integrator is not told to ask for :write (O-3)', async () => {
    const resource = makeResource(fetchMock(async () => jsonResponse(403, { message: 'Forbidden resource' })));

    const error = (await resource.readOnly('w1').catch((e: unknown) => e)) as PermissionError;
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.message).toContain('ANY ONE of');
    expect(error.message).toContain('svc:admin:widget:read');
    expect(error.message).toContain('svc:admin:widget:manage');
  });

  it('carries the widened scopes through listPage and the listAll walk as well', async () => {
    const resource = makeResource(fetchMock(async () => jsonResponse(403, { message: 'Forbidden resource' })));

    await expect(resource.listReadOnly()).rejects.toThrow(/svc:admin:widget:read/);
    await expect(collect(resource.listAllReadOnly())).rejects.toThrow(/svc:admin:widget:read/);
  });

  it('still names the single area scope on a route that was not widened', async () => {
    const resource = makeResource(fetchMock(async () => jsonResponse(403, { message: 'Forbidden resource' })));

    const error = (await resource.get('w1').catch((e: unknown) => e)) as PermissionError;
    expect(error.message).toContain('the service-account scope `svc:admin:widget:manage`');
    expect(error.message).not.toContain('ANY ONE of');
  });

  it('leaves a 404 alone — its own 404-over-403 explanation is the right one, and the scope is not the problem', async () => {
    const resource = makeResource(fetchMock(async () => jsonResponse(404, { message: 'Not found' })));

    const error = (await resource.get('w1').catch((e: unknown) => e)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toContain('different tenant');
    expect(error.message).not.toContain('svc:admin:widget:manage');
  });
});

describe('AdminResource#listPage', () => {
  it('returns the gateway PaginatedResponse shape verbatim', async () => {
    const body = page({ count: 3, limit: 10, page: 0, data: widgets(1, 3) });
    const resource = makeResource(fetchMock(async () => jsonResponse(200, body)));

    await expect(resource.list()).resolves.toEqual(body);
  });

  it('always sends explicit page + limit — the gateway ECHOES the raw query values, so omitting them returns page/limit undefined', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, page({})));
    await makeResource(fetchImpl).list();

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://localhost:8868/api/v1/admin/widgets?page=0&limit=10');
  });

  it('forwards the house PaginatedQuery params and any extra per-route filter', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, page({})));
    await makeResource(fetchImpl).list({
      query: { page: 2, limit: 50, search: 'acme', searchFields: 'name', filters: 'name[contains]:a', sort: 'name:asc', tenantId: 't1' },
    });

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      limit: '50',
      search: 'acme',
      searchFields: 'name',
      filters: 'name[contains]:a',
      sort: 'name:asc',
      tenantId: 't1',
    });
  });

  it('rejects a page size the gateway would 400 on (@Min(1))', async () => {
    await expect(makeResource(fetchMock(async () => jsonResponse(200, page({})))).list({ query: { limit: 0 } })).rejects.toThrow(TypeError);
  });
});

describe('AdminResource#listAll', () => {
  it('walks every page transparently, yielding items in order', async () => {
    const pages = [
      page({ count: 25, limit: 10, page: 0, data: widgets(1, 10) }),
      page({ count: 25, limit: 10, page: 1, data: widgets(11, 10) }),
      page({ count: 25, limit: 10, page: 2, data: widgets(21, 5) }),
    ];
    const fetchImpl = fetchMock(async (input) => jsonResponse(200, pages[Number(new URL(String(input)).searchParams.get('page'))]));

    const all = await collect(makeResource(fetchImpl).listAllWidgets());
    expect(all.map((w) => w.id)).toEqual(widgets(1, 25).map((w) => w.id));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops after a page it can already tell is the last one — a partial page is never followed by another fetch', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, page({ count: 3, limit: 10, page: 0, data: widgets(1, 3) })));

    await collect(makeResource(fetchImpl).listAllWidgets());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops on an exact-multiple total without fetching the empty page past the end', async () => {
    const pages = [page({ count: 20, limit: 10, page: 0, data: widgets(1, 10) }), page({ count: 20, limit: 10, page: 1, data: widgets(11, 10) })];
    const fetchImpl = fetchMock(async (input) => jsonResponse(200, pages[Number(new URL(String(input)).searchParams.get('page'))]));

    expect(await collect(makeResource(fetchImpl).listAllWidgets())).toHaveLength(20);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('yields nothing and fetches once for an empty collection', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, page({ count: 0, data: [] })));

    expect(await collect(makeResource(fetchImpl).listAllWidgets())).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honors a caller-supplied starting page and page size', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, page({ count: 100, limit: 50, page: 3, data: widgets(1, 2) })));

    await collect(makeResource(fetchImpl).listAllWidgets({ query: { page: 3, limit: 50 } }));
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect([url.searchParams.get('page'), url.searchParams.get('limit')]).toEqual(['3', '50']);
  });

  it('propagates a mid-walk failure instead of ending the iteration silently', async () => {
    const fetchImpl = fetchMock(async (input) => {
      const requested = Number(new URL(String(input)).searchParams.get('page'));
      if (requested === 1) return jsonResponse(403, { message: 'Forbidden resource' });
      return jsonResponse(200, page({ count: 25, limit: 10, page: 0, data: widgets(1, 10) }));
    });

    const seen: Widget[] = [];
    await expect(
      (async () => {
        for await (const widget of makeResource(fetchImpl).listAllWidgets()) seen.push(widget);
      })(),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(seen).toHaveLength(10);
  });

  it('stops fetching as soon as the consumer breaks out of the loop', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, page({ count: 1000, limit: 10, page: 0, data: widgets(1, 10) })));

    for await (const _widget of makeResource(fetchImpl).listAllWidgets()) break;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('AdminResource#requestWithPrecondition', () => {
  it('sends If-Match built from the row a caller just read — no hand-copied ETag', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, { id: 'w1', version: 8 }, { etag: '"8"' }));
    const resource = makeResource(fetchImpl);

    const current = await resource.get('w1');
    await resource.update('w1', { id: 'w1' }, { ifMatch: current });

    expect((fetchImpl.mock.calls[1]?.[1]?.headers as Headers).get('if-match')).toBe('"8"');
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('PATCH');
  });

  it('accepts a raw ETag string lifted from a response header', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(200, { id: 'w1', version: 8 }));
    await makeResource(fetchImpl).update('w1', {}, { ifMatch: '"8"' });

    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Headers).get('if-match')).toBe('"8"');
  });

  it('maps a 428 to PreconditionRequiredError — what a caller sees when it writes an OCC route through plain `request`', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(428, { message: 'If-Match header is required for this operation.' }));

    await expect(makeResource(fetchImpl).createWidget({})).rejects.toBeInstanceOf(PreconditionRequiredError);
  });

  it('maps a 412 to VersionConflictError carrying the server current version', async () => {
    const fetchImpl = fetchMock(async () =>
      jsonResponse(412, { message: 'Version conflict', code: 'PERSISTENCE.CONCURRENCY_CONFLICT', metadata: { currentVersion: 9 } }),
    );

    const error = (await makeResource(fetchImpl)
      .update('w1', {}, { ifMatch: 8 })
      .catch((e: unknown) => e)) as VersionConflictError;
    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error.currentVersion).toBe(9);
  });

  it('still names the svc: scope on a 403 from an OCC write', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(403, { message: 'Forbidden resource' }));

    await expect(makeResource(fetchImpl).update('w1', {}, { ifMatch: 8 })).rejects.toThrow(/svc:admin:widget:manage/);
  });
});
