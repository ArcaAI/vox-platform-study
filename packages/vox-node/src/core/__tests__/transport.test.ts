import { describe, expect, it, vi } from 'vitest';

import { APITimeoutError, HopeAPIError } from '../errors';
import { Transport } from '../transport';

function okResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Typed `vi.fn` matching the global `fetch` signature, so `.mock.calls` is typed without casts. */
function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function callInit(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0): RequestInit {
  const init = fetchImpl.mock.calls[callIndex]?.[1];
  if (!init) throw new Error(`fetchImpl was not called (index ${callIndex})`);
  return init;
}

describe('Transport — request headers', () => {
  it('sets X-API-Key from config', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', apiKey: 'key-123', fetch: fetchImpl });
    await transport.request({ path: 'consultations' });

    const headers = callInit(fetchImpl).headers as Headers;
    expect(headers.get('x-api-key')).toBe('key-123');
  });

  it('sets Authorization: Bearer <token> from a sync getToken()', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({
      baseUrl: 'http://localhost:8868',
      getToken: () => 'jwt-token-abc',
      fetch: fetchImpl,
    });
    await transport.request({ path: 'consultations' });

    const headers = callInit(fetchImpl).headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer jwt-token-abc');
  });

  it('supports an async getToken()', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({
      baseUrl: 'http://localhost:8868',
      getToken: async () => 'async-token',
      fetch: fetchImpl,
    });
    await transport.request({ path: 'consultations' });

    const headers = callInit(fetchImpl).headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer async-token');
  });

  it('sets X-Tenant-Id only when configured', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const withTenant = new Transport({ baseUrl: 'http://localhost:8868', tenantId: 'tenant-1', fetch: fetchImpl });
    await withTenant.request({ path: 'consultations' });
    expect((callInit(fetchImpl).headers as Headers).get('x-tenant-id')).toBe('tenant-1');

    fetchImpl.mockClear();
    const withoutTenant = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    await withoutTenant.request({ path: 'consultations' });
    expect((callInit(fetchImpl).headers as Headers).get('x-tenant-id')).toBeNull();
  });

  it('sets Content-Type: application/json only when a body is present', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });

    await transport.request({ path: 'consultations' });
    expect((callInit(fetchImpl).headers as Headers).get('content-type')).toBeNull();

    fetchImpl.mockClear();
    await transport.request({ method: 'POST', path: 'consultations', body: { foo: 'bar' } });
    const postInit = callInit(fetchImpl);
    expect((postInit.headers as Headers).get('content-type')).toBe('application/json');
    expect(postInit.body).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('sets a User-Agent identifying the SDK and its version', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    await transport.request({ path: 'consultations' });
    const headers = callInit(fetchImpl).headers as Headers;
    expect(headers.get('user-agent')).toMatch(/arcaai\/vox-node\/\d+\.\d+\.\d+/);
  });

  it('lets caller-supplied headers override the defaults', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', apiKey: 'key-123', fetch: fetchImpl });
    await transport.request({ path: 'consultations', headers: { Accept: 'text/event-stream', 'X-API-Key': 'override-key' } });
    const headers = callInit(fetchImpl).headers as Headers;
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('x-api-key')).toBe('override-key');
  });

  it('never touches the real network — the injected fetch is the only I/O', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ok: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    await transport.request({ path: 'consultations/abc/summary' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/abc/summary');
  });
});

describe('Transport — request body handling', () => {
  it('resolves with the parsed JSON body on success', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ hello: 'world' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const result = await transport.request<{ hello: string }>({ path: 'consultations' });
    expect(result).toEqual({ hello: 'world' });
  });

  it('resolves to undefined for an empty body (e.g. 204)', async () => {
    const fetchImpl = fetchMock(async () => new Response(null, { status: 204 }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    const result = await transport.request({ method: 'DELETE', path: 'consultations/abc' });
    expect(result).toBeUndefined();
  });
});

describe('Transport — errors', () => {
  it('throws the typed HopeAPIError and captures x-request-id from the response header', async () => {
    const fetchImpl = fetchMock(async () =>
      errorResponse(404, { message: 'Resource not found' }, { 'x-request-id': 'req-999' }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });

    await expect(transport.request({ path: 'consultations/missing' })).rejects.toMatchObject({
      status: 404,
      requestId: 'req-999',
    });
  });

  it('rejects with APITimeoutError when the request exceeds timeoutMs', async () => {
    const fetchImpl = fetchMock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, timeoutMs: 20, maxRetries: 0 });

    await expect(transport.request({ path: 'consultations' })).rejects.toBeInstanceOf(APITimeoutError);
  });

  it('propagates a caller-supplied AbortSignal', async () => {
    const controller = new AbortController();
    // Mirrors real fetch semantics: reject immediately if the composed
    // signal is already aborted by the time fetch is invoked, otherwise
    // wait for the abort event. Real fetch implementations make the same
    // synchronous "already aborted?" check before doing any I/O.
    const fetchImpl = fetchMock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });

    const pending = transport.request({ path: 'consultations', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeTruthy();
  });
});

describe('Transport — retry integration', () => {
  it('retries a 503 with the injected sleep/random and eventually succeeds', async () => {
    let calls = 0;
    const fetchImpl = fetchMock(async () => {
      calls += 1;
      if (calls < 2) return errorResponse(503, { message: 'unavailable' });
      return okResponse({ ok: true });
    });
    const sleep = vi.fn(async () => {});
    const transport = new Transport({
      baseUrl: 'http://localhost:8868',
      fetch: fetchImpl,
      maxRetries: 2,
      random: () => 0.1,
      sleep,
    });

    const result = await transport.request({ path: 'consultations' });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a POST without an idempotency key, even on a 503', async () => {
    const fetchImpl = fetchMock(async () => errorResponse(503, { message: 'unavailable' }));
    const sleep = vi.fn(async () => {});
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 2, sleep });

    await expect(
      transport.request({ method: 'POST', path: 'consultations/abc/summary', body: {} }),
    ).rejects.toBeInstanceOf(HopeAPIError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('Transport — stream()', () => {
  it('returns the raw Response for a 2xx without consuming the body', async () => {
    const fetchImpl = fetchMock(async () => okResponse({ ignored: true }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
    const response = await transport.stream({ path: 'api/smr/api/v1/summary/sync', method: 'POST', body: {} });
    expect(response.bodyUsed).toBe(false);
    expect(response.status).toBe(200);
  });

  it('throws the typed error for a non-2xx response, same mapping as request()', async () => {
    const fetchImpl = fetchMock(async () => errorResponse(401, { message: 'Unauthorized' }));
    const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
    await expect(
      transport.stream({ path: 'api/smr/api/v1/summary/sync', method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
