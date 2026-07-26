/**
 * TASK-558 lane I — `REFRESH_TOKEN_TTL_SECONDS` moves from `process.env` to the
 * `global-kv` cascade at `maxScope: 'tenant'`.
 *
 * Two defects this closes at once:
 *   • the TTL was read ONCE in the constructor, so changing it needed a restart
 *     (§9.2 L1 — anything that must change without a restart is not an env var);
 *   • it was one number for the whole platform, so a customer that wants a
 *     4-hour session could not have one.
 *
 * A tenant may only SHORTEN it (`tenant-clamp.ts`: lower-is-stricter), so this
 * scope cannot be used to extend a session past what the platform allows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshTokenService } from '../refresh-token.service';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const DEFAULT_TTL = 7 * 24 * 60 * 60;

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
  const cache = { setex: vi.fn(async () => undefined), eval: vi.fn(), del: vi.fn(), keys: vi.fn(async () => []) };
  const svc = new RefreshTokenService(cache as any, settings as any);
  return { svc, cache };
}

/** The TTL the service actually applied, read off the Redis SETEX it issued. */
const appliedTtl = (cache: { setex: ReturnType<typeof vi.fn> }) => cache.setex.mock.calls[0]![1] as number;

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.REFRESH_TOKEN_TTL_SECONDS;
});

describe('refreshToken.ttlSeconds — resolved per tenant, per issue', () => {
  it('applies the tenant’s own TTL', async () => {
    const { svc, cache } = makeService(
      tenantSettings({ 'refreshToken.ttlSeconds': DEFAULT_TTL }, { [TENANT_A]: { 'refreshToken.ttlSeconds': 3600 } }),
    );
    await svc.issue({ userId: 'u1', tenantId: TENANT_A, jti: 'j1' });
    expect(appliedTtl(cache)).toBe(3600);
  });

  it('leaves another tenant on the platform TTL', async () => {
    const { svc, cache } = makeService(
      tenantSettings({ 'refreshToken.ttlSeconds': DEFAULT_TTL }, { [TENANT_A]: { 'refreshToken.ttlSeconds': 3600 } }),
    );
    await svc.issue({ userId: 'u1', tenantId: TENANT_B, jti: 'j1' });
    expect(appliedTtl(cache)).toBe(DEFAULT_TTL);
  });

  it('refuses to let a tenant LENGTHEN its session past the platform value', async () => {
    const { svc, cache } = makeService(
      tenantSettings({ 'refreshToken.ttlSeconds': 3600 }, { [TENANT_A]: { 'refreshToken.ttlSeconds': 31_536_000 } }),
    );
    await svc.issue({ userId: 'u1', tenantId: TENANT_A, jti: 'j1' });
    expect(appliedTtl(cache)).toBe(3600);
  });

  it('re-resolves on EVERY issue, so a change needs no restart', async () => {
    const platform: Record<string, unknown> = { 'refreshToken.ttlSeconds': DEFAULT_TTL };
    const settings = new TenantSettingsService({
      getValueFromCache: (key: string) => (key in platform ? platform[key] : null),
      getTenantValueFromCache: () => null,
    } as any);
    const { svc, cache } = makeService(settings);

    await svc.issue({ userId: 'u1', tenantId: TENANT_A, jti: 'j1' });
    expect(appliedTtl(cache)).toBe(DEFAULT_TTL);

    // An admin writes a new platform value; the cache refresh publishes it.
    platform['refreshToken.ttlSeconds'] = 900;
    cache.setex.mockClear();
    await svc.issue({ userId: 'u1', tenantId: TENANT_A, jti: 'j2' });
    expect(appliedTtl(cache)).toBe(900);
  });

  it('rejects a non-positive resolved value and keeps the 7-day default', async () => {
    const { svc, cache } = makeService(tenantSettings({ 'refreshToken.ttlSeconds': 0 }));
    await svc.issue({ userId: 'u1', tenantId: TENANT_A, jti: 'j1' });
    expect(appliedTtl(cache)).toBe(DEFAULT_TTL);
  });

  it('falls back to the env var when no settings resolver is wired (bootstrap fallback)', async () => {
    process.env.REFRESH_TOKEN_TTL_SECONDS = '120';
    const { svc, cache } = makeService();
    await svc.issue({ userId: 'u1', tenantId: TENANT_A, jti: 'j1' });
    expect(appliedTtl(cache)).toBe(120);
  });
});
