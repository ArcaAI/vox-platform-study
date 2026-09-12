import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../client';
import { getMyEntitlements, getMyPreferences, getMyTenant, listMySettings, updateMyPreferences, updateMySetting } from '../client';
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
    for (const key of [accountKeys.tenant(), accountKeys.entitlements(), accountKeys.settings(), accountKeys.preferences()]) {
      expect(key[0]).toBe('account');
    }
  });
});

describe('account client (self-service)', () => {
  it('reads the tenants/me identity and entitlement surfaces', async () => {
    const calls = installFetchMock();
    await getMyTenant();
    await getMyEntitlements();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/tenants/me', 'GET /api/hope/tenants/me/entitlements']);
  });

  it('no longer carries a tenants/me/config client (TASK-956 — /settings and /settings-registry own those rows)', () => {
    expect('listMyTenantConfigs' in client).toBe(false);
    expect('updateMyTenantConfigs' in client).toBe(false);
    expect('tenantConfigs' in accountKeys).toBe(false);
  });

  it('round-trips my settings and preferences', async () => {
    const calls = installFetchMock(() => Response.json({ transcriptionMode: 'LOCAL', transcriptionModeLocked: false, updatedAt: 'now' }));
    await listMySettings();
    await updateMySetting('ui', 'theme', { value: 'dark' });
    await getMyPreferences();
    await updateMyPreferences({ workflowMode: 'local', language: 'sv-SE' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/users/me/settings',
      'PATCH /api/hope/users/me/settings/ui/theme',
      'GET /api/hope/users/me/preferences',
      'PATCH /api/hope/users/me/preferences',
    ]);
    expect(calls[3].body).toEqual({ workflowMode: 'local', language: 'sv-SE' });
  });
});
