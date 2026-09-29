import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, { name: string; value: string; [key: string]: unknown }>() }));

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
import { SESSION_COOKIE_NAME, sealSession, type SessionPayload } from '../session';

const session: SessionPayload = {
  accessToken: 'access-1',
  refreshToken: 'refresh-corr',
  user: { id: 'user-1', username: 'root', email: 'root@example.com', roles: ['SUPER_ADMIN'] },
};

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function installFetch(): { headers: () => Headers } {
  let seen = new Headers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Response.json({ data: [] });
    }),
  );
  return { headers: () => seen };
}

beforeEach(async () => {
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: await sealSession(session) });
});
afterEach(() => vi.unstubAllGlobals());

describe('handleProxy correlation headers', () => {
  it('D7: forwards x-request-id, traceparent and tracestate and returns x-request-id', async () => {
    const gateway = installFetch();
    const response = await handleProxy(
      new Request('http://console.local/api/hope/admin/tenants', { headers: { 'x-request-id': 'req-123', traceparent: TRACEPARENT, tracestate: 'a=b' } }),
      ['admin', 'tenants'],
    );
    expect(gateway.headers().get('x-request-id')).toBe('req-123');
    expect(gateway.headers().get('traceparent')).toBe(TRACEPARENT);
    expect(gateway.headers().get('tracestate')).toBe('a=b');
    expect(response.headers.get('x-request-id')).toBe('req-123');
  });

  it('D7: originates a request id when the browser sent none, and the same id goes both ways', async () => {
    const gateway = installFetch();
    const response = await handleProxy(new Request('http://console.local/api/hope/admin/tenants'), ['admin', 'tenants']);
    const sent = gateway.headers().get('x-request-id');
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-request-id')).toBe(sent);
    expect(gateway.headers().get('traceparent')).toBeNull();
  });

  it('D7: replaces a malformed inbound id instead of forwarding it', async () => {
    const gateway = installFetch();
    await handleProxy(new Request('http://console.local/api/hope/admin/tenants', { headers: { 'x-request-id': 'x'.repeat(65) } }), ['admin', 'tenants']);
    expect(gateway.headers().get('x-request-id')).not.toBe('x'.repeat(65));
    expect(gateway.headers().get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('D7: the session-lost 401 also carries x-request-id', async () => {
    cookieJar.clear();
    const response = await handleProxy(new Request('http://console.local/api/hope/admin/tenants'), ['admin', 'tenants']);
    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
