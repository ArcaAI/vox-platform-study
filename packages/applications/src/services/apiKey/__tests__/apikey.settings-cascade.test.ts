/**
 * `API_KEY_MAX_LIFETIME_DAYS` / `API_KEY_ALLOW_QUERY_PARAM`
 * move from `process.env` to the `global-kv` cascade.
 *
 * `apiKey.maxLifetimeDays` is `maxScope: 'tenant'`: the ceiling on how long a
 * key may live is exactly the kind of credential policy one customer tightens
 * without the whole platform following. `apiKey.allowQueryParam` is
 * PLATFORM-ONLY — its reader runs while the request is still anonymous, so
 * there is no tenant to resolve it at.
 *
 * The env vars remain the documented BOOTSTRAP FALLBACK: with no settings
 * resolver wired (a fresh database, a legacy fixture) behaviour is byte-for-byte
 * what it was before this lane.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyService } from '../apikey.service';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function tenantSettings(platform: Record<string, unknown> = {}, tenant: Record<string, Record<string, unknown>> = {}) {
  return new TenantSettingsService({
    getValueFromCache: (key: string) => (key in platform ? platform[key] : null),
    getTenantValueFromCache: (tenantId: string, key: string) => {
      const rows = tenant[tenantId];
      return rows && key in rows ? rows[key] : null;
    },
  } as any);
}

function makeService(settings?: TenantSettingsService) {
  const apiKeyRepository = {
    create: vi.fn(async (e: any) => e),
    count: vi.fn(async () => 0),
    findAll: vi.fn(async () => []),
  };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['GLOBAL_ADMIN'] } : k === 'tenantId' ? TENANT_A : undefined)) };
  return new ApiKeyService(
    apiKeyRepository as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: vi.fn() } as any,
    cls as any,
    undefined,
    undefined,
    settings as any,
  );
}

const createRequest = (expiresAt?: string) => ({
  keyName: 'k',
  keyType: 'SDK',
  tenantId: TENANT_A,
  ...(expiresAt ? { expiresAt } : {}),
});

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.API_KEY_MAX_LIFETIME_DAYS;
  delete process.env.API_KEY_ALLOW_QUERY_PARAM;
});

describe('apiKey.maxLifetimeDays — resolved for the KEY’S tenant', () => {
  it('rejects an expiry beyond the tenant’s ceiling', async () => {
    const svc = makeService(tenantSettings({ 'apiKey.maxLifetimeDays': 365 }, { [TENANT_A]: { 'apiKey.maxLifetimeDays': 7 } }));
    await expect(svc.create(createRequest(inDays(30)) as any)).rejects.toThrow(/maximum allowed lifetime of 7 days/);
  });

  it('accepts the same expiry for a tenant with no override (the platform ceiling applies)', async () => {
    const svc = makeService(tenantSettings({ 'apiKey.maxLifetimeDays': 365 }));
    await expect(svc.create(createRequest(inDays(30)) as any)).resolves.toBeDefined();
  });

  it('defaults an unbounded request to the resolved ceiling', async () => {
    const svc = makeService(tenantSettings({ 'apiKey.maxLifetimeDays': 365 }, { [TENANT_A]: { 'apiKey.maxLifetimeDays': 7 } }));
    const result = await svc.create(createRequest() as any);
    const expiresAt = new Date(result.apiKey.expiresAt as any).getTime();
    // ~7 days out, not 365.
    expect(expiresAt).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it('treats an unresolved ceiling as UNLIMITED (unchanged behaviour on a fresh database)', async () => {
    const svc = makeService(tenantSettings());
    const result = await svc.create(createRequest() as any);
    expect(result.apiKey.expiresAt ?? null).toBeNull();
  });

  it('falls back to the env var when no settings resolver is wired (bootstrap fallback)', async () => {
    process.env.API_KEY_MAX_LIFETIME_DAYS = '3';
    const svc = makeService();
    await expect(svc.create(createRequest(inDays(30)) as any)).rejects.toThrow(/maximum allowed lifetime of 3 days/);
  });
});

describe('apiKey.allowQueryParam — platform-only', () => {
  const request = { headers: {}, query: { apiKey: 'hope_sk_x' }, url: '/x' };

  it('rejects a query-parameter key when the platform row says false', () => {
    const svc = makeService(tenantSettings({ 'apiKey.allowQueryParam': false }));
    expect(svc.extractApiKeyFromRequest(request)).toBeNull();
  });

  it('accepts one when the platform row says true', () => {
    const svc = makeService(tenantSettings({ 'apiKey.allowQueryParam': true }));
    expect(svc.extractApiKeyFromRequest(request)).toBe('hope_sk_x');
  });

  it('defaults to OFF when nothing is stored (the descriptor default)', () => {
    const svc = makeService(tenantSettings());
    expect(svc.extractApiKeyFromRequest(request)).toBeNull();
  });

  it('falls back to the env var when no settings resolver is wired', () => {
    process.env.API_KEY_ALLOW_QUERY_PARAM = 'true';
    const svc = makeService();
    expect(svc.extractApiKeyFromRequest(request)).toBe('hope_sk_x');
  });
});
