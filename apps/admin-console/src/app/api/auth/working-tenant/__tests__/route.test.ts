import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieJar } = vi.hoisted(() => ({
  cookieJar: new Map<string, { name: string; value: string; [key: string]: unknown }>(),
}));

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

import { POST } from '../route';
import { SESSION_COOKIE_NAME, getSession, sealSession, type SessionPayload } from '@/server/session';

const operator: SessionPayload = {
  accessToken: 'operator-access',
  refreshToken: 'operator-refresh',
  user: { id: 'admin-1', username: 'super_admin', email: 'a@example.com', roles: ['SUPER_ADMIN'] },
};

function selectRequest(body: Record<string, unknown>): Request {
  return new Request('http://console.local/api/auth/working-tenant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => handler(input.toString(), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(async () => {
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: await sealSession(operator) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/working-tenant', () => {
  it('keeps the name the body carries and does not call the gateway', async () => {
    const spy = stubFetch(() => Response.json({}));
    const response = await POST(selectRequest({ tenantId: 't-1', tenantName: 'ArcaAI' }));
    expect(response.status).toBe(200);
    expect((await getSession())?.workingTenantName).toBe('ArcaAI');
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves and seals the tenant name server-side when the body omits it', async () => {
    const spy = stubFetch(() => Response.json({ id: 't-1', name: 'ArcaAI' }));
    const response = await POST(selectRequest({ tenantId: 't-1' }));
    expect(response.status).toBe(200);
    expect(spy.mock.calls[0][0]).toMatch(/\/api\/v1\/admin\/tenants\/t-1$/);
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe('Bearer operator-access');
    expect((await getSession())?.workingTenantName).toBe('ArcaAI');
    expect((await response.json()).workingTenantName).toBe('ArcaAI');
  });

  it('still selects the tenant (name unset) when the lookup fails', async () => {
    stubFetch(() => new Response('nope', { status: 404 }));
    const response = await POST(selectRequest({ tenantId: 't-1' }));
    expect(response.status).toBe(200);
    const session = await getSession();
    expect(session?.workingTenantId).toBe('t-1');
    expect(session?.workingTenantName).toBeUndefined();
  });
});
