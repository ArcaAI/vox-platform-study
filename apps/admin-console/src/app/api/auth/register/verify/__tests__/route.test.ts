import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';

const API = 'http://gateway.test:8868';

function verifyRequest(body: unknown): Request {
    return new Request('http://console.local/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
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

describe('POST /api/auth/register/verify', () => {
    it('proxies the token to the gateway and returns the provisioned-tenant body', async () => {
        const gatewayBody = { userId: 'u1', tenantId: 't1', tenantKey: 'acme-health' };
        const fetchMock = installFetchMock(() => Response.json(gatewayBody));

        const response = await POST(verifyRequest({ token: 'raw-token' }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(gatewayBody);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${API}/api/v1/auth/register/verify`);
        expect(JSON.parse(String(init.body))).toEqual({ token: 'raw-token' });
    });

    it('rejects a missing token with 400 before calling the gateway', async () => {
        const fetchMock = installFetchMock(() => Response.json({}));

        const response = await POST(verifyRequest({}));

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces an invalid/expired token error verbatim', async () => {
        installFetchMock(() => Response.json({ message: 'Verification link is invalid or has expired' }, { status: 400 }));

        const response = await POST(verifyRequest({ token: 'bogus' }));

        expect(response.status).toBe(400);
        expect((await response.json()).message).toBe('Verification link is invalid or has expired');
    });
});
