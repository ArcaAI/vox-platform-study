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

import { POST } from '../route';

const API = 'http://gateway.test:8868';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TestBrowser/1.0';

const gatewayLoginBody = {
  user: {
    id: 'user-1',
    username: 'root',
    email: 'root@example.com',
    roles: ['GLOBAL_ADMIN'],
    permissions: [],
  },
  token: 'access-1',
  refreshToken: 'refresh-1',
};

interface RecordedCall {
  url: string;
  headers: Headers;
  body: string | null;
}

function installFetchMock(handler: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call: RecordedCall = {
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function loginRequest(headers: Record<string, string>): Request {
  return new Request('http://console.local/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'root', password: 'secret' }),
  });
}

beforeEach(() => {
  cookieJar.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/login', () => {
  // Without forwarding, Node's fetch sends `user-agent: node` and
  // the gateway's LOGIN audit row records the BFF's identity instead of the
  // operator's browser.
  it('forwards the browser User-Agent to the gateway so the LOGIN audit row records the real client', async () => {
    const calls = installFetchMock(() => Response.json(gatewayLoginBody));

    const response = await POST(loginRequest({ 'content-type': 'application/json', 'user-agent': BROWSER_UA }));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/api/v1/auth/login`);
    expect(calls[0].headers.get('user-agent')).toBe(BROWSER_UA);
  });

  it('does not invent a User-Agent when the incoming request has none', async () => {
    const calls = installFetchMock(() => Response.json(gatewayLoginBody));

    const response = await POST(loginRequest({ 'content-type': 'application/json' }));

    expect(response.status).toBe(200);
    expect(calls[0].headers.get('user-agent')).toBeNull();
  });
});
