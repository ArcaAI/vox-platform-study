// TASK-558 lane I — the tenant-override clamp (§9.3 M2).
//
// The rule under test: a tenant override may only make a setting MORE
// restrictive than the platform value, and may never exceed the tenant's plan
// entitlement. Entitlements BOUND what a tenant may set; they never supply a
// value.

import { describe, expect, it } from 'vitest';
import { clampTenantSetting, TENANT_OVERRIDE_CLAMPS } from '../tenant-clamp';

describe('clampTenantSetting — platform bound (monotone-stricter)', () => {
  it('lets a tenant LOWER a request limit below the platform value', () => {
    const result = clampTenantSetting('rateLimit.maxRequests', 40, { platform: 100 });
    expect(result).toEqual({ value: 40, clamped: false });
  });

  it('clamps a tenant that tries to RAISE a request limit above the platform value', () => {
    const result = clampTenantSetting('rateLimit.maxRequests', 5000, { platform: 100 });
    expect(result).toEqual({ value: 100, clamped: true, bound: 'platform' });
  });

  it('treats a LONGER rate-limit window as stricter, so a tenant may lengthen but not shorten it', () => {
    expect(clampTenantSetting('rateLimit.windowMs', 120_000, { platform: 60_000 })).toEqual({ value: 120_000, clamped: false });
    expect(clampTenantSetting('rateLimit.windowMs', 1, { platform: 60_000 })).toEqual({ value: 60_000, clamped: true, bound: 'platform' });
  });

  it('refuses to let a tenant switch rate limiting OFF while the platform has it ON', () => {
    expect(clampTenantSetting('rateLimit.enabled', false, { platform: true })).toEqual({ value: true, clamped: true, bound: 'platform' });
  });

  it('lets a tenant switch rate limiting ON while the platform has it OFF (stricter is always allowed)', () => {
    expect(clampTenantSetting('rateLimit.enabled', true, { platform: false })).toEqual({ value: true, clamped: false });
  });

  it('lets a tenant SHORTEN an API-key lifetime and refuses to let it lengthen one', () => {
    expect(clampTenantSetting('apiKey.maxLifetimeDays', 30, { platform: 90 })).toEqual({ value: 30, clamped: false });
    expect(clampTenantSetting('apiKey.maxLifetimeDays', 365, { platform: 90 })).toEqual({ value: 90, clamped: true, bound: 'platform' });
  });

  it('applies no bound when the platform value is UNSET (unbounded is weaker than anything a tenant can set)', () => {
    expect(clampTenantSetting('apiKey.maxLifetimeDays', 365, { platform: undefined })).toEqual({ value: 365, clamped: false });
    expect(clampTenantSetting('apiKey.maxLifetimeDays', 365, { platform: null })).toEqual({ value: 365, clamped: false });
  });

  it('clamps a refresh-token TTL a tenant tries to lengthen', () => {
    expect(clampTenantSetting('refreshToken.ttlSeconds', 3600, { platform: 604800 })).toEqual({ value: 3600, clamped: false });
    expect(clampTenantSetting('refreshToken.ttlSeconds', 31_536_000, { platform: 604800 })).toEqual({
      value: 604800,
      clamped: true,
      bound: 'platform',
    });
  });
});

describe('clampTenantSetting — entitlement ceiling (§9.3 M2)', () => {
  it('clamps a tenant to its PLAN limit even when the platform value is higher', () => {
    // Platform allows 100/min; the tenant's plan only entitles it to 30.
    const result = clampTenantSetting('rateLimit.maxRequests', 80, { platform: 100, entitlement: 30 });
    expect(result).toEqual({ value: 30, clamped: true, bound: 'entitlement' });
  });

  it('reports the TIGHTER of the two bounds when both would clamp', () => {
    expect(clampTenantSetting('rateLimit.maxRequests', 5000, { platform: 100, entitlement: 30 })).toEqual({
      value: 30,
      clamped: true,
      bound: 'entitlement',
    });
    expect(clampTenantSetting('rateLimit.maxRequests', 5000, { platform: 20, entitlement: 30 })).toEqual({
      value: 20,
      clamped: true,
      bound: 'platform',
    });
  });

  it('does not clamp a tenant that stays within its plan', () => {
    expect(clampTenantSetting('rateLimit.maxRequests', 25, { platform: 100, entitlement: 30 })).toEqual({ value: 25, clamped: false });
  });

  it('treats a null entitlement as UNLIMITED (ungated / null-plan tenants, Q3)', () => {
    expect(clampTenantSetting('rateLimit.maxRequests', 80, { platform: 100, entitlement: null })).toEqual({ value: 80, clamped: false });
  });
});

describe('clampTenantSetting — keys with no declared clamp', () => {
  it('passes a key with no clamp direction straight through', () => {
    // A platform-only key never reaches the tenant lane, so it has no entry.
    expect(clampTenantSetting('logLevel', 'debug', { platform: 'info' })).toEqual({ value: 'debug', clamped: false });
    expect(TENANT_OVERRIDE_CLAMPS['logLevel']).toBeUndefined();
  });

  it('declares a clamp for EVERY tenant-overridable knob this lane migrated', () => {
    expect(Object.keys(TENANT_OVERRIDE_CLAMPS).sort()).toEqual(
      ['apiKey.maxLifetimeDays', 'rateLimit.enabled', 'rateLimit.maxRequests', 'rateLimit.windowMs', 'refreshToken.ttlSeconds'].sort(),
    );
  });
});
