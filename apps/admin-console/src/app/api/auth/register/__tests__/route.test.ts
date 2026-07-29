import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { POST } from '../route';

const API = 'http://gateway.test:8868';

function registerRequest(body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request('http://console.local/api/auth/register', { method: 'POST', headers, body: JSON.stringify(body) });
}

function installFetchMock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/register', () => {
  it('proxies the request to the gateway and returns its generic accepted body', async () => {
    const fetchMock = installFetchMock(() => Response.json({ success: true }, { status: 202 }));

    const response = await POST(registerRequest({ email: 'doc@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/v1/auth/register`);
    expect(JSON.parse(String(init.body))).toEqual({ email: 'doc@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' });
  });

  it('rejects an invalid JSON body with 400 before ever calling the gateway', async () => {
    const fetchMock = installFetchMock(() => Response.json({ success: true }));

    const response = await POST(new Request('http://console.local/api/auth/register', { method: 'POST', body: 'not-json' }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing required field with 400 before calling the gateway', async () => {
    const fetchMock = installFetchMock(() => Response.json({ success: true }));

    const response = await POST(registerRequest({ email: 'doc@example.com' }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the gateway (feature flag off) verbatim', async () => {
    installFetchMock(() => Response.json({ message: 'Not found' }, { status: 404 }));

    const response = await POST(registerRequest({ email: 'doc@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' }));

    expect(response.status).toBe(404);
  });
});
