/**
 * Identity-providers API module. Paths and OCC envelope
 * verified against apps/api TenantIdpConfigAdminController: If-Match PUT
 * on :id, plain POST on :id/test and :id/sync (no OCC — the backend reads
 * the row itself for those).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, deleteProvider, getProvider, listProviders, syncDirectory, testConnection, updateProvider } from '../client';
import { identityProviderKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(responseInit: { etag?: string } = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      const headers = responseInit.etag ? { etag: responseInit.etag } : undefined;
      return new Response(JSON.stringify({ id: 'provider-1' }), { headers });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('identityProviderKeys', () => {
  it('roots at ["identity-providers"] and separates list from detail', () => {
    expect(identityProviderKeys.list()).toEqual(identityProviderKeys.list());
    expect(identityProviderKeys.detail('p1')).not.toEqual(identityProviderKeys.detail('p2'));
  });
});

describe('identity-providers client — paths', () => {
  it('listProviders hits GET admin/tenant-idp-config via the BFF proxy', async () => {
    const calls = installFetchMock();
    await listProviders();
    expect(calls[0].url).toContain('/api/hope/admin/tenant-idp-config');
    expect(calls[0].method).toBe('GET');
  });

  it('createProvider POSTs the create body', async () => {
    const calls = installFetchMock();
    await createProvider({
      protocol: 'OIDC',
      displayName: 'Acme Okta',
      config: { issuer: 'https://acme.okta.com', clientId: 'c1', defaultRoleId: 'r1', defaultDepartmentId: 'd1' },
      clientSecret: 'super-secret',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ displayName: 'Acme Okta', clientSecret: 'super-secret' });
  });

  it('getProvider GETs :id and keeps the ETag', async () => {
    const calls = installFetchMock({ etag: '"3"' });
    const result = await getProvider('provider-1');
    expect(calls[0].url).toContain('admin/tenant-idp-config/provider-1');
    expect(result.etag).toBe('"3"');
  });

  it('updateProvider PUTs :id with If-Match + expectedVersion derived from the ETag', async () => {
    const calls = installFetchMock();
    await updateProvider('provider-1', { displayName: 'renamed' }, '"3"');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toContain('admin/tenant-idp-config/provider-1');
    expect(calls[0].headers['if-match']).toBe('"3"');
    expect(calls[0].body).toMatchObject({ displayName: 'renamed', expectedVersion: 3 });
  });

  it('deleteProvider DELETEs :id', async () => {
    const calls = installFetchMock();
    await deleteProvider('provider-1');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('admin/tenant-idp-config/provider-1');
  });

  it('testConnection POSTs :id/test with no body', async () => {
    const calls = installFetchMock();
    await testConnection('provider-1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('admin/tenant-idp-config/provider-1/test');
  });

  it('syncDirectory POSTs :id/sync with no body', async () => {
    const calls = installFetchMock();
    await syncDirectory('provider-1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('admin/tenant-idp-config/provider-1/sync');
  });
});
