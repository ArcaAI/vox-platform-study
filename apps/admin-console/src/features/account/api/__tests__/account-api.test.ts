import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMyEntitlements,
  getMyPreferences,
  getMyTenant,
  listMyTenantConfigs,
  listMySettings,
  updateMyPreferences,
  updateMySetting,
  updateMyTenantConfigs,
} from '../client';
import { accountKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response?: () => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response ? response() : Response.json({ data: [], count: 0, limit: 25, page: 0 }, { headers: { etag: '"4"' } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accountKeys', () => {
  it('is stable and namespaced under account', () => {
    expect(accountKeys.tenant()).toEqual(accountKeys.tenant());
    expect(accountKeys.tenantConfigs()).not.toEqual(accountKeys.tenant());
    for (const key of [accountKeys.tenant(), accountKeys.entitlements(), accountKeys.settings(), accountKeys.preferences()]) {
      expect(key[0]).toBe('account');
    }
  });
});

describe('account client (self-service)', () => {
  it('reads tenant/me surfaces incl. the config ETag for the bulk PATCH', async () => {
    const calls = installFetchMock();
    await getMyTenant();
    const configs = await listMyTenantConfigs({ page: 0 });
    await getMyEntitlements();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/tenant/me',
      'GET /api/hope/tenant/me/config?page=0',
      'GET /api/hope/entitlements/me',
    ]);
    expect(configs.etag).toBe('"4"');
  });

  it('PATCHes tenant/me/config with If-Match (header folds onto every row)', async () => {
    const calls = installFetchMock();
    await updateMyTenantConfigs([{ id: 'cfg-1', value: 'on', expectedVersion: 4 }], '"4"');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('/api/hope/tenant/me/config');
    expect(calls[0].headers.get('if-match')).toBe('"4"');
    expect(calls[0].body).toEqual([{ id: 'cfg-1', value: 'on', expectedVersion: 4 }]);
  });

  it('round-trips my settings and preferences', async () => {
    const calls = installFetchMock(() => Response.json({ transcriptionMode: 'LOCAL', transcriptionModeLocked: false, updatedAt: 'now' }));
    await listMySettings();
    await updateMySetting('ui', 'theme', { value: 'dark' });
    await getMyPreferences();
    await updateMyPreferences({ workflowMode: 'local', language: 'sv-SE' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/user/me/settings',
      'PATCH /api/hope/user/me/settings/ui/theme',
      'GET /api/hope/user/me/preferences',
      'PATCH /api/hope/user/me/preferences',
    ]);
    expect(calls[3].body).toEqual({ workflowMode: 'local', language: 'sv-SE' });
  });
});
