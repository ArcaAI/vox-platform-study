/**
 * TDD for `core/service-account-token.ts` — the service-account credential
 * lifecycle.
 *
 * Concurrency and revocation are the reason this file is as long as it is.
 * Both are invisible in a happy-path integration test and are exactly what a
 * real machine workload hits first: a script fanning out 50 concurrent admin
 * reads across the token's expiry boundary (single-flight), and an operator
 * revoking the account mid-run (immediate, not TTL-bound — `ServiceAccountService.revoke`
 * PURGES live tokens rather than waiting for them to age out).
 *
 * Every test drives an injected `fetch` and an injected clock. No timers, no
 * network, no `Date.now()`.
 */

import util from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { SERVICE_ACCOUNT_TOKEN_HEADER, ServiceAccountTokenProvider } from '../service-account-token';
import { Transport } from '../transport';

const CLIENT_ID = 'hope_svc_2f9c1a';
const CLIENT_SECRET = 'svc-secret-should-never-leak-0123456789abcdef';
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      accessToken: 'tok-1',
      tokenType: 'Bearer',
      expiresIn: 900,
      scopes: ['svc:admin:tenant:read'],
      tenantId: SYSTEM_TENANT,
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function unauthorized(body: Record<string, unknown> = { message: 'Unauthorized' }): Response {
  return new Response(JSON.stringify(body), { status: 401, headers: { 'content-type': 'application/json' } });
}

function ok(body: Record<string, unknown> = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A provider wired to a credential-less exchange transport, exactly as `HopeClient` builds it. */
function makeProvider(
  fetchImpl: ReturnType<typeof fetchMock>,
  options: { now?: () => number; refreshSkewMs?: number; workingTenantId?: string } = {},
) {
  const transport = new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl, maxRetries: 0 });
  return new ServiceAccountTokenProvider({
    transport,
    credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, workingTenantId: options.workingTenantId },
    now: options.now,
    refreshSkewMs: options.refreshSkewMs,
  });
}

function requestBody(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[callIndex]?.[1];
  if (!init?.body) throw new Error(`no body on call ${callIndex}`);
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function requestHeaders(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0): Headers {
  const init = fetchImpl.mock.calls[callIndex]?.[1];
  if (!init) throw new Error(`fetch was not called (index ${callIndex})`);
  return new Headers(init.headers);
}

describe('ServiceAccountTokenProvider — exchange and cache', () => {
  it('never touches the network at construction time', () => {
    const fetchImpl = fetchMock(async () => tokenResponse());
    makeProvider(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exchanges lazily, on first use, at POST /api/v1/auth/service-token', async () => {
    const fetchImpl = fetchMock(async () => tokenResponse());
    const provider = makeProvider(fetchImpl);

    await expect(provider.getToken()).resolves.toBe('tok-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/auth/service-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('binds workingTenantId in the EXCHANGE BODY and never sends X-Tenant-Id', async () => {
    const fetchImpl = fetchMock(async () => tokenResponse({ tenantId: 'tenant-a' }));
    const provider = makeProvider(fetchImpl, { workingTenantId: 'tenant-a' });

    await provider.getToken();

    expect(requestBody(fetchImpl).workingTenantId).toBe('tenant-a');
    expect(requestHeaders(fetchImpl).get('x-tenant-id')).toBeNull();
  });

  it('presents no other credential class on the exchange request', async () => {
    const fetchImpl = fetchMock(async () => tokenResponse());
    await makeProvider(fetchImpl).getToken();

    const headers = requestHeaders(fetchImpl);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get(SERVICE_ACCOUNT_TOKEN_HEADER)).toBeNull();
  });

  it('caches the token — later calls do not re-exchange', async () => {
    const fetchImpl = fetchMock(async () => tokenResponse());
    const provider = makeProvider(fetchImpl, { now: () => 0 });

    await provider.getToken();
    await provider.getToken();
    await provider.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes on the skew margin BEFORE expiry, not at expiry', async () => {
    let nowMs = 0;
    let issued = 0;
    const fetchImpl = fetchMock(async () => {
      issued += 1;
      return tokenResponse({ accessToken: `tok-${issued}`, expiresIn: 900 });
    });
    const provider = makeProvider(fetchImpl, { now: () => nowMs, refreshSkewMs: 60_000 });

    await expect(provider.getToken()).resolves.toBe('tok-1');

    // 14 minutes in: 60s of life left, which is exactly the skew margin — the
    // token is still valid on the wire but must already be replaced.
    nowMs = 840_000;
    await expect(provider.getToken()).resolves.toBe('tok-2');

    // Comfortably inside the fresh token's margin: no further exchange.
    nowMs = 840_000 + 100_000;
    await expect(provider.getToken()).resolves.toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never lets the skew margin consume a whole short-lived token', async () => {
    let nowMs = 0;
    let issued = 0;
    const fetchImpl = fetchMock(async () => {
      issued += 1;
      return tokenResponse({ accessToken: `tok-${issued}`, expiresIn: 30 });
    });
    // Skew (60s) exceeds the whole TTL (30s): a naive `expiresAt - skew` is
    // already in the past on arrival, so every call would exchange again.
    const provider = makeProvider(fetchImpl, { now: () => nowMs, refreshSkewMs: 60_000 });

    await expect(provider.getToken()).resolves.toBe('tok-1');
    nowMs = 1_000;
    await expect(provider.getToken()).resolves.toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('collapses N concurrent first-use calls into exactly ONE exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = fetchMock(async () => {
      await gate;
      return tokenResponse();
    });
    const provider = makeProvider(fetchImpl);

    const pending = Promise.all(Array.from({ length: 25 }, () => provider.getToken()));
    release();
    const tokens = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set(['tok-1']));
  });

  it('collapses concurrent REFRESHES (post-expiry) into exactly one exchange', async () => {
    let nowMs = 0;
    let issued = 0;
    let gate = Promise.resolve();
    const fetchImpl = fetchMock(async () => {
      await gate;
      issued += 1;
      return tokenResponse({ accessToken: `tok-${issued}` });
    });
    const provider = makeProvider(fetchImpl, { now: () => nowMs, refreshSkewMs: 60_000 });

    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    nowMs = 900_000;
    const pending = Promise.all(Array.from({ length: 25 }, () => provider.getToken()));
    release();
    const tokens = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new Set(tokens)).toEqual(new Set(['tok-2']));
  });

  it('does not poison itself when an exchange fails — a later call retries', async () => {
    let attempt = 0;
    const fetchImpl = fetchMock(async () => {
      attempt += 1;
      return attempt === 1 ? unauthorized({ message: 'Invalid client credentials' }) : tokenResponse();
    });
    const provider = makeProvider(fetchImpl);

    await expect(provider.getToken()).rejects.toMatchObject({ status: 401 });
    await expect(provider.getToken()).resolves.toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed exchange response rather than caching an empty token', async () => {
    const fetchImpl = fetchMock(async () => ok({ tokenType: 'Bearer' }));
    await expect(makeProvider(fetchImpl).getToken()).rejects.toThrow(/service-token/i);
  });
});

describe('ServiceAccountTokenProvider — authenticatedFetch (revoked mid-flight)', () => {
  /** A `fetch` that answers the exchange route and delegates everything else to `onApiCall`. */
  function gatewayMock(onApiCall: (headers: Headers) => Response) {
    let issued = 0;
    return fetchMock(async (input, init) => {
      if (String(input).endsWith('/auth/service-token')) {
        issued += 1;
        return tokenResponse({ accessToken: `tok-${issued}` });
      }
      return onApiCall(new Headers(init?.headers));
    });
  }

  function serviceAccountTransport(provider: ServiceAccountTokenProvider, fetchImpl: typeof fetch): Transport {
    return new Transport({
      baseUrl: 'http://localhost:8868',
      fetch: provider.authenticatedFetch(fetchImpl),
      getServiceAccountToken: () => provider.getToken(),
      maxRetries: 0,
    });
  }

  it('refreshes ONCE and retries the call ONCE on a 401', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = gatewayMock((headers) => {
      const token = headers.get(SERVICE_ACCOUNT_TOKEN_HEADER);
      seen.push(token);
      return token === 'tok-2' ? ok() : unauthorized();
    });
    const provider = makeProvider(fetchImpl);

    await expect(serviceAccountTransport(provider, fetchImpl).request({ path: 'admin/tenants' })).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['tok-1', 'tok-2']);
  });

  it('propagates a SECOND 401 instead of refreshing again', async () => {
    let apiCalls = 0;
    const fetchImpl = gatewayMock(() => {
      apiCalls += 1;
      return unauthorized();
    });
    const provider = makeProvider(fetchImpl);

    await expect(serviceAccountTransport(provider, fetchImpl).request({ path: 'admin/tenants' })).rejects.toMatchObject({ status: 401 });
    expect(apiCalls).toBe(2);
  });

  it('leaves a 401 that carried no service-account token untouched', async () => {
    let apiCalls = 0;
    const fetchImpl = gatewayMock(() => {
      apiCalls += 1;
      return unauthorized();
    });
    const wrapped = makeProvider(fetchImpl).authenticatedFetch(fetchImpl);

    const response = await wrapped('http://localhost:8868/api/v1/consultations/c1', { headers: new Headers({ 'x-api-key': 'key' }) });

    expect(response.status).toBe(401);
    expect(apiCalls).toBe(1);
  });

  it('returns the ORIGINAL 401 when the recovery exchange itself fails', async () => {
    let exchanges = 0;
    const fetchImpl = fetchMock(async (input) => {
      if (String(input).endsWith('/auth/service-token')) {
        exchanges += 1;
        return exchanges === 1 ? tokenResponse() : unauthorized({ message: 'Invalid client credentials' });
      }
      return unauthorized({ message: 'Unauthorized', code: 'revoked' });
    });
    const provider = makeProvider(fetchImpl);
    const wrapped = provider.authenticatedFetch(fetchImpl);

    const token = await provider.getToken();
    const response = await wrapped('http://localhost:8868/api/v1/admin/tenants', {
      headers: new Headers({ [SERVICE_ACCOUNT_TOKEN_HEADER]: token }),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code?: string }).code).toBe('revoked');
  });

  it('does not stampede: two concurrent 401s trigger a single re-exchange', async () => {
    let exchanges = 0;
    const fetchImpl = fetchMock(async (input, init) => {
      if (String(input).endsWith('/auth/service-token')) {
        exchanges += 1;
        return tokenResponse({ accessToken: `tok-${exchanges}` });
      }
      return new Headers(init?.headers).get(SERVICE_ACCOUNT_TOKEN_HEADER) === 'tok-2' ? ok() : unauthorized();
    });
    const provider = makeProvider(fetchImpl);
    const wrapped = provider.authenticatedFetch(fetchImpl);

    const token = await provider.getToken();
    expect(exchanges).toBe(1);

    const headers = () => new Headers({ [SERVICE_ACCOUNT_TOKEN_HEADER]: token });
    const responses = await Promise.all([
      wrapped('http://localhost:8868/api/v1/admin/tenants', { headers: headers() }),
      wrapped('http://localhost:8868/api/v1/admin/users', { headers: headers() }),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(exchanges).toBe(2);
  });
});

describe('ServiceAccountTokenProvider — redaction', () => {
  it('never exposes the client secret or the access token through toString/toJSON/util.inspect', async () => {
    const fetchImpl = fetchMock(async () => tokenResponse({ accessToken: 'tok-super-secret-value' }));
    const provider = makeProvider(fetchImpl);
    await provider.getToken();

    const rendered = [String(provider), provider.toString(), JSON.stringify({ provider }), util.inspect(provider, { depth: null })];
    for (const text of rendered) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain('tok-super-secret-value');
    }
    // The PUBLIC client id stays visible — it is the one field an operator
    // needs in order to correlate a log line with an account.
    expect(util.inspect(provider)).toContain(CLIENT_ID);
  });
});
