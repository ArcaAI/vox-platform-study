import { describe, expect, it, vi } from 'vitest';
import { TENANT_RESTORE_COMPLETED_EVENT } from '../tenant-restore-events';
import { IdpResolverService } from '../../../idp-resolver/idp-resolver.service';
import { OriginRegistryService } from '../../../origin-registry/origin-registry.service';
import { RateLimitRuleCache } from '../../../rate-limit/rate-limit-rule.cache';
import { BlobStorageProviderFactory } from '../../../baseServices/storage/providers/blob-storage.provider.factory';
import { TextAgentResolverService } from '../../../agent/text-agent-resolver.service';
import { AppSettingsService } from '../../../baseServices/_meta/appSettings/appSettings.service';
import { ConsultationConsentService } from '../../../consent/consultation-consent.service';
import { EntitlementsService } from '../../../entitlements/entitlements.service';

/** A service instance without running its (heavy) constructor; tests set only the fields they read. */
const bare = <T>(cls: { prototype: T }, fields: Record<string, unknown>): T => Object.assign(Object.create(cls.prototype as object), fields) as T;
const payload = { tenantId: 'T' };

describe('tenant-restore.completed handlers', () => {
  it('names the event', () => {
    expect(TENANT_RESTORE_COMPLETED_EVENT).toBe('tenant-restore.completed');
  });

  it('IdpResolverService drops every cached OIDC and SAML client', () => {
    const cache = new Map([['p1', {}]]);
    const samlCache = new Map([['p2', {}]]);
    const svc = bare(IdpResolverService, { cache, samlCache });
    (svc as any).onTenantRestoreCompleted(payload);
    expect(cache.size).toBe(0);
    expect(samlCache.size).toBe(0);
  });

  it('OriginRegistryService reloads its index', async () => {
    const svc = bare(OriginRegistryService, { refresh: vi.fn().mockResolvedValue(undefined), cls: { isActive: () => false } });
    await (svc as any).onTenantRestoreCompleted(payload);
    expect((svc as any).refresh).toHaveBeenCalledTimes(1);
  });

  it('RateLimitRuleCache reloads its rules', async () => {
    const svc = bare(RateLimitRuleCache, { refresh: vi.fn().mockResolvedValue(undefined) });
    await (svc as any).onTenantRestoreCompleted(payload);
    expect((svc as any).refresh).toHaveBeenCalledTimes(1);
  });

  it('BlobStorageProviderFactory drops only the tenant entries', () => {
    const tenantProviderCache = new Map<string, unknown>([['T::a', 1], ['T::b', 2], ['U::a', 3]]);
    const svc = bare(BlobStorageProviderFactory, { tenantProviderCache });
    (svc as any).onTenantRestoreCompleted(payload);
    expect([...tenantProviderCache.keys()]).toEqual(['U::a']);
  });

  it('TextAgentResolverService drops only the tenant spec entries', () => {
    const specCache = new Map<string, unknown>([['T::d::a::', 1], ['U::d::a::', 2]]);
    const inFlight = new Map<string, unknown>([['T::d::a::', Promise.resolve()]]);
    const svc = bare(TextAgentResolverService, { specCache, inFlight });
    (svc as any).onTenantRestoreCompleted(payload);
    expect([...specCache.keys()]).toEqual(['U::d::a::']);
    expect(inFlight.size).toBe(0);
  });

  it('AppSettingsService refreshes its cache', async () => {
    const svc = bare(AppSettingsService, { refreshCache: vi.fn().mockResolvedValue(undefined), logger: { error: vi.fn() } });
    await (svc as any).onTenantRestoreCompleted(payload);
    expect((svc as any).refreshCache).toHaveBeenCalledTimes(1);
  });

  it('EntitlementsService drops only the tenant rate-limit policy entry', () => {
    const rateLimitPolicyCache = new Map<string, unknown>([['T', 1], ['U', 2]]);
    const svc = bare(EntitlementsService, { rateLimitPolicyCache });
    (svc as any).onTenantRestoreCompleted(payload);
    expect([...rateLimitPolicyCache.keys()]).toEqual(['U']);
  });

  it('ConsultationConsentService drops only the tenant grant entries', () => {
    const cache = new Map<string, unknown>([['T::p::a', 1], ['U::p::a', 2]]);
    const svc = bare(ConsultationConsentService, { cache });
    (svc as any).onTenantRestoreCompleted(payload);
    expect([...cache.keys()]).toEqual(['U::p::a']);
  });
});
