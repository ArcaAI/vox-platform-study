import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';

const API = 'http://gateway.test:8868';
const GENERIC_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

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

function forgotPasswordRequest(body: Record<string, unknown> | string): Request {
  return new Request('http://console.local/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/forgot-password', () => {
  it('forwards the email to the gateway and passes through the generic response', async () => {
    const calls = installFetchMock(() => Response.json({ success: true, message: GENERIC_MESSAGE }, { status: 202 }));

    const response = await POST(forgotPasswordRequest({ email: 'doctor@example.com' }));
    const data = (await response.json()) as { message: string };

    expect(response.status).toBe(200);
    expect(data.message).toBe(GENERIC_MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/api/v1/auth/forgot-password`);
    expect(JSON.parse(String(calls[0].body))).toEqual({ email: 'doctor@example.com' });
  });

  it('returns the same generic message whether or not the account exists (anti-enumeration passthrough)', async () => {
    installFetchMock(() => Response.json({ success: true, message: GENERIC_MESSAGE }, { status: 202 }));

    const response = await POST(forgotPasswordRequest({ email: 'unknown@example.com' }));
    const data = (await response.json()) as { message: string };

    expect(response.status).toBe(200);
    expect(data.message).toBe(GENERIC_MESSAGE);
  });

  it('rejects a request with no email before calling the gateway', async () => {
    const calls = installFetchMock(() => Response.json({ success: true, message: GENERIC_MESSAGE }, { status: 202 }));

    const response = await POST(forgotPasswordRequest({}));

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid JSON body', async () => {
    const response = await POST(forgotPasswordRequest('not json'));
    expect(response.status).toBe(400);
  });

  it('surfaces a gateway error status and message', async () => {
    installFetchMock(() => Response.json({ message: 'Too many requests' }, { status: 429 }));

    const response = await POST(forgotPasswordRequest({ email: 'doctor@example.com' }));
    const data = (await response.json()) as { message: string };

    expect(response.status).toBe(429);
    expect(data.message).toBe('Too many requests');
  });
});
