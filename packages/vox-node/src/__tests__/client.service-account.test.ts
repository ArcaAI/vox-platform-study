/**
 * `HopeClient` × the service-account credential class (TASK-773 Phase C).
 *
 * Kept in its own file rather than appended to `src/client.test.ts`: the
 * API-key tests there are the regression proof that this addition is purely
 * ADDITIVE, and they are more useful untouched.
 */

import { describe, expect, it, vi } from 'vitest';

import { HopeClient } from '../client';
import { SERVICE_ACCOUNT_TOKEN_HEADER } from '../core/service-account-token';

const CREDENTIALS = { clientId: 'hope_svc_2f9c1a', clientSecret: 'svc-secret-0123456789abcdef0123456789' };

function fetchMock(impl: typeof fetch) {
  return vi.fn<typeof fetch>(impl);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers the token exchange; every other path returns an empty 200. */
function gatewayMock() {
  return fetchMock(async (input) =>
    String(input).endsWith('/auth/service-token')
      ? json({ accessToken: 'tok-1', tokenType: 'Bearer', expiresIn: 900, scopes: ['svc:admin:tenant:read'], tenantId: 'tenant-a' })
      : json({ id: 'c1' }),
  );
}

describe('HopeClient — service-account construction guards', () => {
  it('refuses apiKey + serviceAccount together (the gateway 400s on two credential classes)', () => {
    expect(
      () => new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'key', serviceAccount: CREDENTIALS }),
    ).toThrow(/exactly one credential/i);
  });

  it('refuses tenantId + serviceAccount, pointing at serviceAccount.workingTenantId instead', () => {
    expect(
      () => new HopeClient({ baseUrl: 'http://localhost:8868', tenantId: 'tenant-a', serviceAccount: CREDENTIALS }),
    ).toThrow(/workingTenantId/);
  });

  it('never touches the network at construction, even with a service account', () => {
    const fetchImpl = gatewayMock();
    new HopeClient({ baseUrl: 'http://localhost:8868', serviceAccount: CREDENTIALS, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HopeClient — service-account request wiring', () => {
  it('exchanges once, then presents X-Service-Account-Token and no other credential header', async () => {
    const fetchImpl = gatewayMock();
    const hope = new HopeClient({
      baseUrl: 'http://localhost:8868',
      serviceAccount: { ...CREDENTIALS, workingTenantId: 'tenant-a' },
      fetch: fetchImpl,
    });

    await hope.consultations.get('c1');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/auth/service-token');

    const headers = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(headers.get(SERVICE_ACCOUNT_TOKEN_HEADER)).toBe('tok-1');
    expect(headers.get('x-api-key')).toBeNull();
    // Bound at exchange, never per request — see the module doc comment.
    expect(headers.get('x-tenant-id')).toBeNull();
  });

  it('reuses the token across calls', async () => {
    const fetchImpl = gatewayMock();
    const hope = new HopeClient({ baseUrl: 'http://localhost:8868', serviceAccount: CREDENTIALS, fetch: fetchImpl });

    await hope.consultations.get('c1');
    await hope.consultations.get('c2');

    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/auth/service-token'))).toHaveLength(1);
  });

  it('sends no service-account header for an apiKey caller (additive, not a behavior change)', async () => {
    const fetchImpl = gatewayMock();
    const hope = new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'key-abc', fetch: fetchImpl });

    await hope.consultations.get('c1');

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-api-key')).toBe('key-abc');
    expect(headers.get(SERVICE_ACCOUNT_TOKEN_HEADER)).toBeNull();
  });
});
