import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiKey, deleteApiKey, getApiKey, getApiKeyUsage, getScopes, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey } from '../client';
import { apiKeyKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
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
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response ? response() : Response.json({ id: 'k-1' });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiKeyKeys', () => {
  it('is stable and separates list/detail/usage/scopes', () => {
    expect(apiKeyKeys.list({ page: 0 })).toEqual(apiKeyKeys.list({ page: 0 }));
    expect(apiKeyKeys.detail('k-1')).not.toEqual(apiKeyKeys.usage('k-1'));
    expect(apiKeyKeys.scopes()[0]).toBe('api-keys');
  });
});

describe('api-keys client', () => {
  it('covers CRUD + revoke/rotate/usage/scopes routes', async () => {
    const calls = installFetchMock();
    await getScopes();
    await listApiKeys({ page: 0 });
    await getApiKey('k-1');
    await createApiKey({ keyName: 'ingest', scopes: ['stt:transcribe'] });
    await updateApiKey('k-1', { keyName: 'ingest-2' });
    await revokeApiKey('k-1');
    await rotateApiKey('k-1');
    await getApiKeyUsage('k-1');
    await deleteApiKey('k-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/api-keys/scopes',
      'GET /api/hope/admin/api-keys?page=0',
      'GET /api/hope/admin/api-keys/k-1',
      'POST /api/hope/admin/api-keys',
      'PATCH /api/hope/admin/api-keys/k-1',
      'POST /api/hope/admin/api-keys/k-1/revoke',
      'POST /api/hope/admin/api-keys/k-1/rotate',
      'GET /api/hope/admin/api-keys/k-1/usage',
      'DELETE /api/hope/admin/api-keys/k-1',
    ]);
    expect(calls[3].body).toEqual({ keyName: 'ingest', scopes: ['stt:transcribe'] });
  });

  it('surfaces the one-time rawKey from create and rotate', async () => {
    installFetchMock(() => Response.json({ apiKey: { id: 'k-1', keyPrefix: 'hope_ab' }, rawKey: 'hope_ab_SECRET' }));
    const created = await createApiKey({ keyName: 'x', scopes: ['admin:read'] });
    expect(created.rawKey).toBe('hope_ab_SECRET');
    const rotated = await rotateApiKey('k-1');
    expect(rotated.apiKey.id).toBe('k-1');
  });
});
