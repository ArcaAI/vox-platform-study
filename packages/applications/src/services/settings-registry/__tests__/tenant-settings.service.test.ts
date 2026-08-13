// The `global-kv` cascade: tenant → SYSTEM → descriptor default.
//
// This is the read half of "allocate env vars to the database for multi-tenant
// support". It pins the four properties the cascade exists to deliver:
//   1. a tenant override BEATS the platform row;
//   2. the entitlement CEILING clamps a tenant trying to exceed its plan
//      (entitlements bound what a tenant MAY set, they never supply);
//   3. an absent row falls back to the descriptor default;
//   4. NO cache serves one tenant's value to another.
// Plus: the resolved value always says WHICH tier supplied it.

import { describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { TenantSettingsService } from '../tenant-settings.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

/** A stand-in for the two-lane AppSettings cache. */
function fakeAppSettings(platform: Record<string, unknown> = {}, tenant: Record<string, Record<string, unknown>> = {}) {
  return {
    getValueFromCache: vi.fn((key: string) => (key in platform ? platform[key] : null)),
    getTenantValueFromCache: vi.fn((tenantId: string, key: string) => {
      const rows = tenant[tenantId];
      return rows && key in rows ? rows[key] : null;
    }),
    getValueWithDefault: vi.fn(),
    getFromCache: vi.fn(),
    hasSetting: vi.fn(),
    getAllKeys: vi.fn(),
    getCacheStats: vi.fn(),
    cacheAppSettings: vi.fn(),
    updateCacheAppSettings: vi.fn(),
    refreshCache: vi.fn(),
    stopCacheRefresh: vi.fn(),
    validateSettingValue: vi.fn(),
  };
}

const build = (platform?: Record<string, unknown>, tenant?: Record<string, Record<string, unknown>>) =>
  new TenantSettingsService(fakeAppSettings(platform, tenant) as never);

describe('TenantSettingsService — cascade', () => {
  it('falls back to the DESCRIPTOR DEFAULT when no row exists at any scope', () => {
    const service = build();
    // `rateLimit.windowMs` declares default 60000 in platform-knobs.descriptors.
    expect(service.resolve('rateLimit.windowMs', TENANT_A)).toEqual({
      key: 'rateLimit.windowMs',
      value: 60000,
      source: 'code-default',
    });
  });

  it('uses the SYSTEM/platform row when the tenant has no override', () => {
    const service = build({ 'rateLimit.maxRequests': 250 });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A)).toEqual({
      key: 'rateLimit.maxRequests',
      value: 250,
      source: 'system',
    });
  });

  it('a TENANT override beats the SYSTEM row', () => {
    const service = build({ 'rateLimit.maxRequests': 250 }, { [TENANT_A]: { 'rateLimit.maxRequests': 40 } });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A)).toEqual({
      key: 'rateLimit.maxRequests',
      value: 40,
      source: 'tenant',
    });
  });

  it('never serves one tenant the other tenant’s override', () => {
    const service = build({ 'rateLimit.maxRequests': 250 }, { [TENANT_A]: { 'rateLimit.maxRequests': 40 } });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A).value).toBe(40);
    expect(service.resolve('rateLimit.maxRequests', TENANT_B)).toEqual({
      key: 'rateLimit.maxRequests',
      value: 250,
      source: 'system',
    });
  });

  it('ignores the tenant lane entirely for a platform-only (maxScope: system) key', () => {
    // `logLevel` is `maxScope: 'system'`: even a row planted under a tenant may
    // not govern, because the scope clamp forbids a tenant ever setting it.
    const service = build({ logLevel: 'warn' }, { [TENANT_A]: { logLevel: 'debug' } });
    expect(service.resolve('logLevel', TENANT_A)).toEqual({ key: 'logLevel', value: 'warn', source: 'system' });
  });

  it('resolves the platform lane when no tenant is in context', () => {
    const service = build({ 'rateLimit.maxRequests': 250 }, { [TENANT_A]: { 'rateLimit.maxRequests': 40 } });
    expect(service.resolve('rateLimit.maxRequests', null).value).toBe(250);
    expect(service.resolvePlatform('rateLimit.maxRequests').value).toBe(250);
  });
});

describe('TenantSettingsService — entitlement ceiling', () => {
  it('clamps a tenant that tries to exceed its PLAN limit and reports the bound', () => {
    const service = build({ 'rateLimit.maxRequests': 250 }, { [TENANT_A]: { 'rateLimit.maxRequests': 200 } });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A, { entitlement: 30 })).toEqual({
      key: 'rateLimit.maxRequests',
      value: 30,
      source: 'tenant',
      clampedBy: 'entitlement',
    });
  });

  it('clamps a tenant that tries to exceed the PLATFORM value', () => {
    const service = build({ 'rateLimit.maxRequests': 100 }, { [TENANT_A]: { 'rateLimit.maxRequests': 9000 } });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A)).toEqual({
      key: 'rateLimit.maxRequests',
      value: 100,
      source: 'tenant',
      clampedBy: 'platform',
    });
  });

  it('refuses to let a tenant disable rate limiting the platform has ON', () => {
    const service = build({ 'rateLimit.enabled': true }, { [TENANT_A]: { 'rateLimit.enabled': false } });
    expect(service.resolve('rateLimit.enabled', TENANT_A)).toEqual({
      key: 'rateLimit.enabled',
      value: true,
      source: 'tenant',
      clampedBy: 'platform',
    });
  });

  it('leaves a within-plan tenant value untouched', () => {
    const service = build({ 'rateLimit.maxRequests': 250 }, { [TENANT_A]: { 'rateLimit.maxRequests': 20 } });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A, { entitlement: 30 })).toEqual({
      key: 'rateLimit.maxRequests',
      value: 20,
      source: 'tenant',
    });
  });

  it('does not apply the entitlement ceiling to the PLATFORM value (a ceiling bounds a tenant WRITE, not the platform default)', () => {
    const service = build({ 'rateLimit.maxRequests': 250 });
    expect(service.resolve('rateLimit.maxRequests', TENANT_A, { entitlement: 30 })).toEqual({
      key: 'rateLimit.maxRequests',
      value: 250,
      source: 'system',
    });
  });
});

describe('TenantSettingsService — declared failure mode', () => {
  it('throws for an unknown key', () => {
    expect(() => build().resolve('no.such.key', TENANT_A)).toThrow(ArgumentInvalidException);
  });

  it('never resolves a secret through this surface', () => {
    // `storage.platformDefault.credentials` is sensitivity `secret`.
    expect(() => build().resolve('storage.platformDefault.credentials', TENANT_A)).toThrow(/secret/i);
  });
});
