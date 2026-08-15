import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieJar } = vi.hoisted(() => {
  const jar = new Map<string, { name: string; value: string; [key: string]: unknown }>();
  return { cookieJar: jar };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieJar.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieJar.set(name, { name, value, ...(options ?? {}) });
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
    has: (name: string) => cookieJar.has(name),
  }),
}));

import { handleProxy } from '../hope-proxy';
import { SESSION_COOKIE_NAME, getSession, sealSession, type SessionPayload } from '../session';

const API = 'http://gateway.test:8868';

const baseSession: SessionPayload = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: {
    id: 'user-1',
    username: 'root',
    email: 'root@example.com',
    roles: ['SUPER_ADMIN'],
  },
};

async function seedSession(session: SessionPayload): Promise<void> {
  cookieJar.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: await sealSession(session) });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  init: RequestInit;
}

function installFetchMock(handler: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const requestInit = init ?? {};
      const headers = new Headers(requestInit.headers);
      let body: string | null = null;
      if (requestInit.body instanceof ArrayBuffer) {
        body = new TextDecoder().decode(requestInit.body);
      } else if (typeof requestInit.body === 'string') {
        body = requestInit.body;
      }
      const call: RecordedCall = { url, method: requestInit.method ?? 'GET', headers, body, init: requestInit };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

beforeEach(() => {
  cookieJar.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleProxy', () => {
  it('rejects requests without a session and never calls the gateway', async () => {
    const calls = installFetchMock(() => Response.json({}));
    const response = await handleProxy(new Request('http://console.local/api/hope/admin/tenants'), ['admin', 'tenants']);
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('forwards GET with bearer token, query string, no-store and manual redirects', async () => {
    await seedSession(baseSession);
    const calls = installFetchMock(() => Response.json({ data: [] }));

    const response = await handleProxy(new Request('http://console.local/api/hope/admin/tenants?limit=5&page=2'), ['admin', 'tenants']);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/api/v1/admin/tenants?limit=5&page=2`);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.get('authorization')).toBe('Bearer access-1');
    expect(calls[0].init.cache).toBe('no-store');
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].headers.get('x-tenant-id')).toBeNull();
  });

  // Downloading a blob whose key contains slashes (e.g.
  // `2026/07/10/streams/<id>/processed/complete.wav`). The browser encodes the
  // key as `%2F`; Next's catch-all decodes it into a single segment with real
  // slashes. A plain `path.join('/')` forwards those as separators and the
  // gateway's single-segment `buckets/:name/files/:key` route 404s. The
  // segments must be re-encoded so the `%2F` reaches the gateway intact.
  it('re-encodes slashes inside a decoded file-key segment so :key stays one segment', async () => {
    await seedSession(baseSession);
    const calls = installFetchMock(() => Response.json({ key: 'k', url: 'https://presigned' }));

    await handleProxy(
      new Request(
        'http://console.local/api/hope/storage/buckets/hope-recordings-global/files/2026%2F07%2F10%2Fstreams%2F019f4cb3%2Fprocessed%2Fcomplete.wav',
      ),
      ['storage', 'buckets', 'hope-recordings-global', 'files', '2026/07/10/streams/019f4cb3/processed/complete.wav'],
    );

    expect(calls[0].url).toBe(
      `${API}/api/v1/storage/buckets/hope-recordings-global/files/2026%2F07%2F10%2Fstreams%2F019f4cb3%2Fprocessed%2Fcomplete.wav`,
    );
  });

  it('attaches X-Tenant-Id only for elevated users with a working tenant', async () => {
    await seedSession({ ...baseSession, workingTenantId: '50000000-0000-0000-0000-000000000000' });
    const elevatedCalls = installFetchMock(() => Response.json({}));
    await handleProxy(new Request('http://console.local/api/hope/admin/users'), ['admin', 'users']);
    expect(elevatedCalls[0].headers.get('x-tenant-id')).toBe('50000000-0000-0000-0000-000000000000');

    // A tenant-bound user must never send the header, even if state drifted.
    cookieJar.clear();
    await seedSession({
      ...baseSession,
      user: { ...baseSession.user, roles: ['TENANT_ADMIN'] },
      workingTenantId: '50000000-0000-0000-0000-000000000000',
    });
    const tenantCalls = installFetchMock(() => Response.json({}));
    await handleProxy(new Request('http://console.local/api/hope/admin/users'), ['admin', 'users']);
    expect(tenantCalls[0].headers.get('x-tenant-id')).toBeNull();
  });

  it('uses the impersonation token while impersonation is active', async () => {
    await seedSession({
      ...baseSession,
      impersonation: {
        accessToken: 'impersonation-token',
        originalAccessToken: 'access-1',
        originalRefreshToken: 'refresh-1',
        targetUserId: 'user-2',
      },
    });
    const calls = installFetchMock(() => Response.json({}));
    await handleProxy(new Request('http://console.local/api/hope/consultations'), ['consultations']);
    expect(calls[0].headers.get('authorization')).toBe('Bearer impersonation-token');
  });

  // (latent bug folded in): if the operator had a working
  // tenant selected BEFORE impersonating, and it differs from the target's
  // own (resolved) tenant, the gateway's ContextInterceptor 400s every
  // proxied call because the header no longer matches the act-as JWT's
  // tenantId. The act-as JWT is already tenant-bound to the target — the
  // header must never ride along while impersonating.
  it('never sends the operator stale working-tenant header while impersonating', async () => {
    await seedSession({
      ...baseSession,
      // Operator picked a working tenant before impersonating.
      workingTenantId: '60000000-0000-0000-0000-000000000000',
      impersonation: {
        accessToken: 'impersonation-token',
        originalAccessToken: 'access-1',
        originalRefreshToken: 'refresh-1',
        targetUserId: 'user-2',
        targetTenantId: '50000000-0000-0000-0000-000000000000',
      },
    });
    const calls = installFetchMock(() => Response.json({}));
    await handleProxy(new Request('http://console.local/api/hope/consultations'), ['consultations']);
    expect(calls[0].headers.get('x-tenant-id')).toBeNull();
  });

  it('forwards If-Match/Content-Type/Idempotency-Key and body; returns ETag/Content-Type and status', async () => {
    await seedSession(baseSession);
    const calls = installFetchMock(() =>
      Response.json(
        { id: 'dept-1' },
        { status: 200, headers: { etag: '"8"', 'content-type': 'application/json; charset=utf-8', 'x-internal': 'must-not-leak' } },
      ),
    );

    const request = new Request('http://console.local/api/hope/admin/departments/dept-1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'if-match': '"7"',
        'idempotency-key': 'idem-123',
        'x-forwarded-junk': 'nope',
      },
      body: JSON.stringify({ name: 'Cardiology' }),
    });
    const response = await handleProxy(request, ['admin', 'departments', 'dept-1']);

    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].headers.get('if-match')).toBe('"7"');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].headers.get('idempotency-key')).toBe('idem-123');
    expect(calls[0].headers.get('x-forwarded-junk')).toBeNull();
    expect(calls[0].body).toBe(JSON.stringify({ name: 'Cardiology' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"8"');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-internal')).toBeNull();
    expect(await response.json()).toEqual({ id: 'dept-1' });
  });

  // The gateway audits `user-agent` (e.g. IMPERSONATED_ACTION rows
  // minted per proxied request); without forwarding it records the BFF's
  // undici default ("node") instead of the operator's browser.
  it('forwards the browser User-Agent so gateway audit rows record the real client', async () => {
    await seedSession(baseSession);
    const calls = installFetchMock(() => Response.json({}));

    const request = new Request('http://console.local/api/hope/admin/users', {
      headers: { 'user-agent': 'Mozilla/5.0 (TestBrowser)' },
    });
    await handleProxy(request, ['admin', 'users']);

    expect(calls[0].headers.get('user-agent')).toBe('Mozilla/5.0 (TestBrowser)');
  });

  // The gateway marks the Prisma Studio shell `no-store`;
  // dropping it at the proxy silently voided that posture on the only
  // supported access path.
  it('forwards the gateway Cache-Control so no-store responses stay uncached', async () => {
    await seedSession(baseSession);
    installFetchMock(() => new Response('<!DOCTYPE html>', { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } }));

    const response = await handleProxy(new Request('http://console.local/api/hope/admin/pstudio'), ['admin', 'pstudio']);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('passes gateway error statuses through untouched (e.g. 412 precondition failed)', async () => {
    await seedSession(baseSession);
    installFetchMock(() => Response.json({ message: 'Precondition Failed' }, { status: 412 }));
    const response = await handleProxy(new Request('http://console.local/api/hope/admin/tenants/t-1', { method: 'PATCH', body: '{}' }), [
      'admin',
      'tenants',
      't-1',
    ]);
    expect(response.status).toBe(412);
  });

  it('refreshes once on 401 and retries with the new access token', async () => {
    await seedSession(baseSession);
    const calls = installFetchMock((call) => {
      if (call.url === `${API}/api/v1/auth/refresh`) {
        expect(JSON.parse(call.body ?? '{}')).toEqual({ refreshToken: 'refresh-1' });
        return Response.json({ token: 'access-2', refreshToken: 'refresh-2' });
      }
      if (call.headers.get('authorization') === 'Bearer access-2') {
        return Response.json({ ok: true });
      }
      return Response.json({ message: 'Unauthorized' }, { status: 401 });
    });

    const response = await handleProxy(new Request('http://console.local/api/hope/admin/users'), ['admin', 'users']);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([`${API}/api/v1/admin/users`, `${API}/api/v1/auth/refresh`, `${API}/api/v1/admin/users`]);

    // The rotated tokens must be resealed into the session cookie.
    const session = await getSession();
    expect(session?.accessToken).toBe('access-2');
    expect(session?.refreshToken).toBe('refresh-2');
  });

  it('keeps the session and passes the gateway 401 through when a refreshed token still 401s (step-up re-auth failure)', async () => {
    await seedSession(baseSession);
    installFetchMock((call) => {
      if (call.url === `${API}/api/v1/auth/refresh`) {
        return Response.json({ token: 'access-2', refreshToken: 'refresh-2' });
      }
      // Even with the freshly-refreshed token the gateway rejects — a
      // step-up (wrong re-auth password) failure, NOT an expired session.
      return Response.json({ message: 'Step-up re-authentication failed: incorrect password.' }, { status: 401 });
    });

    const response = await handleProxy(new Request('http://console.local/api/hope/admin/settings/s-1/rotate', { method: 'POST', body: '{}' }), [
      'admin',
      'settings',
      's-1',
      'rotate',
    ]);

    // The gateway's real message reaches the client (not "Session expired")…
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Step-up re-authentication failed: incorrect password.' });
    // …and a mistyped step-up password must NOT log the user out.
    expect(await getSession()).not.toBeNull();
  });

  it('clears the session and returns 401 when the refresh is rejected', async () => {
    await seedSession(baseSession);
    installFetchMock((call) => {
      if (call.url === `${API}/api/v1/auth/refresh`) {
        return Response.json({ message: 'Invalid or expired refresh token' }, { status: 401 });
      }
      return Response.json({ message: 'Unauthorized' }, { status: 401 });
    });

    const response = await handleProxy(new Request('http://console.local/api/hope/admin/users'), ['admin', 'users']);

    expect(response.status).toBe(401);
    expect(await getSession()).toBeNull();
  });

  it('single-flights concurrent refreshes', async () => {
    await seedSession(baseSession);
    let refreshCalls = 0;
    installFetchMock(async (call) => {
      if (call.url === `${API}/api/v1/auth/refresh`) {
        refreshCalls += 1;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
        return Response.json({ token: 'access-2', refreshToken: 'refresh-2' });
      }
      if (call.headers.get('authorization') === 'Bearer access-2') {
        return Response.json({ ok: true });
      }
      return Response.json({ message: 'Unauthorized' }, { status: 401 });
    });

    const [first, second] = await Promise.all([
      handleProxy(new Request('http://console.local/api/hope/admin/users'), ['admin', 'users']),
      handleProxy(new Request('http://console.local/api/hope/admin/tenants'), ['admin', 'tenants']),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshCalls).toBe(1);
  });
});
