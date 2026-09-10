/**
 * TASK-870 item 12 — directory-sync availability is a PER-TENANT feature gate,
 * not a platform-wide env switch.
 *
 * Before this change both providers froze a platform-wide env var in their
 * constructor — `String(configService.get('TENANT_IDP_GOOGLE_DIRECTORY_ENABLED')
 * ?? '').toLowerCase() === 'true'` — and `fetchUsers` threw when it was off. Two
 * things were wrong with that, and the second is the one that mattered:
 *
 *   1. A constructor freeze needs a redeploy to change
 *      (`09-infrastructure-devops.md` §Configuration Tiers, corollary L1).
 *   2. The SCOPE was wrong. Directory sync is inherently per-tenant work —
 *      `enqueueSync(tenantId, providerId)` runs against credentials the TENANT
 *      provisions itself (its own Google service account with delegated directory
 *      scopes, or its own Azure AD app registration). So a tenant that had done
 *      all of that still could not sync until the platform flipped a global env
 *      var, and flipping it enabled the capability for EVERY tenant at once.
 *      That is the §"Tenant-first resolution" rule, not a tier label.
 *
 * Owner decision (2026-09-10): only a PLATFORM ADMIN manages which features are
 * enabled for each tenant. `FEATURE_AVAILABILITY_SETTINGS` already encodes exactly
 * that as two fields answering different questions — `globalOnly: true` (who may
 * write) x `maxScope: 'tenant'` (where the row lives) — so these two keys join
 * that family and take its defaults rather than carrying a bespoke guard.
 *
 * The gate is checked in BOTH places that hold a tenantId, for the reason
 * `assertEqualTenants` is also in both: `enqueueSync` is the front door and owes
 * the caller a real 400 instead of a job that fails later, and the processor is
 * where the work actually happens — a capability a platform admin has disabled
 * must not keep running because a job was already queued.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { IdpProtocol, IdpStatus, TenantIdentityProviderFactory } from '@arcaai/domains';
import { DirectorySyncService } from '../directory-sync.service';
import { DirectorySyncProcessor } from '../directory-sync.processor';
import {
  TENANT_IDP_GOOGLE_DIRECTORY_ENABLED_KEY,
  TENANT_IDP_MS_GRAPH_ENABLED_KEY,
} from '../../settings-registry/descriptors/feature-availability.descriptors';

const TENANT = 'tenant-abc';

function makeProvider(directoryProvider = 'ms-graph', overrides: Record<string, unknown> = {}) {
  return TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.OIDC,
    displayName: 'Acme Okta',
    providerStatus: IdpStatus.ENABLED,
    config: { issuer: 'https://acme.okta.com', clientId: 'client-abc', defaultRoleId: 'role-default', defaultDepartmentId: 'dept-default', directoryProvider },
    encryptedSecretRef: 'vault:v1:c2VjcmV0',
    directoryCredentialsRef: 'vault:v1:ZGlyZWN0b3J5',
    ...overrides,
  });
}

/** A facade that answers `stored` for the keys it carries, else the code default (false). */
function facade(stored: Record<string, boolean> = {}) {
  return {
    resolveEffective: vi.fn(async (key: string) =>
      key in stored ? { key, tier: 'global-kv', value: stored[key], sourceScope: 'global-kv' } : { key, tier: 'global-kv', value: false, sourceScope: 'code-default' },
    ),
  };
}

function makeService(stored: Record<string, boolean> = {}) {
  const providerRepository = { findById: vi.fn() };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  const effectiveSettings = facade(stored);
  const svc = new DirectorySyncService(providerRepository as never, queue as never, effectiveSettings as never);
  return { svc, providerRepository, queue, effectiveSettings };
}

function makeProcessor(stored: Record<string, boolean> = {}) {
  const providerRepository = { findById: vi.fn() };
  const msGraphProvider = { key: 'ms-graph', fetchUsers: vi.fn().mockResolvedValue({ users: [] }) };
  const googleProvider = { key: 'google-directory', fetchUsers: vi.fn().mockResolvedValue({ users: [] }) };
  const effectiveSettings = facade(stored);
  const processor = new DirectorySyncProcessor(
    providerRepository as never,
    { findByProviderAndSubject: vi.fn().mockResolvedValue(null) } as never,
    msGraphProvider as never,
    googleProvider as never,
    { resolveOrProvisionUser: vi.fn().mockResolvedValue({ id: 'u1' }) } as never,
    { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() } as never,
    { decrypt: vi.fn(async () => Buffer.from(JSON.stringify({ azureTenantId: 't', clientId: 'c', clientSecret: 's' }))) } as never,
    { baseClient: { userRoleAssignment: { findMany: vi.fn().mockResolvedValue([]) } } } as never,
    { isEnforcementEnabled: vi.fn(() => false), assertQuantityQuota: vi.fn() } as never,
    effectiveSettings as never,
  );
  return { processor, providerRepository, msGraphProvider, googleProvider, effectiveSettings };
}

const job = (data: Record<string, unknown>) => ({ id: 'bull-1', data, updateProgress: vi.fn() }) as never;

describe('directory sync — per-tenant availability gate (TASK-870 item 12)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('declares both keys in the feature-availability family, platform-written and per-tenant', async () => {
    const { FEATURE_AVAILABILITY_SETTINGS } = await import('../../settings-registry/descriptors/feature-availability.descriptors');
    for (const key of [TENANT_IDP_GOOGLE_DIRECTORY_ENABLED_KEY, TENANT_IDP_MS_GRAPH_ENABLED_KEY]) {
      const d = FEATURE_AVAILABILITY_SETTINGS.find((x) => x.key === key);
      expect(d, `${key} must be a feature-availability descriptor`).toBeDefined();
      // The owner rule, as two fields: who may write x where the row lives.
      expect(d!.globalOnly, 'platform-admin write only').toBe(true);
      expect(d!.maxScope, 'a row per tenant, so availability is per tenant').toBe('tenant');
      // A kill-switch MUST default OFF — auto-derived from `default: false`.
      expect(d!.default).toBe(false);
      expect(d!.killSwitch).toBe(true);
    }
  });

  it('keeps the legacy env names as declared overrides, not as the answer', async () => {
    const { FEATURE_AVAILABILITY_SETTINGS } = await import('../../settings-registry/descriptors/feature-availability.descriptors');
    const byKey = (k: string) => FEATURE_AVAILABILITY_SETTINGS.find((x) => x.key === k)!;
    expect(byKey(TENANT_IDP_GOOGLE_DIRECTORY_ENABLED_KEY).envOverride).toEqual(['TENANT_IDP_GOOGLE_DIRECTORY_ENABLED']);
    expect(byKey(TENANT_IDP_MS_GRAPH_ENABLED_KEY).envOverride).toEqual(['TENANT_IDP_MS_GRAPH_ENABLED']);
  });

  it('enqueueSync REFUSES when the capability is off for this tenant', async () => {
    const { svc, providerRepository, queue } = makeService();
    providerRepository.findById.mockResolvedValue(makeProvider('ms-graph'));

    await expect(svc.enqueueSync(TENANT, 'provider-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add, 'no job may be queued for a disabled capability').not.toHaveBeenCalled();
  });

  it('enqueueSync ACCEPTS once a platform admin enables it for this tenant', async () => {
    const { svc, providerRepository, queue } = makeService({ [TENANT_IDP_MS_GRAPH_ENABLED_KEY]: true });
    providerRepository.findById.mockResolvedValue(makeProvider('ms-graph'));

    await expect(svc.enqueueSync(TENANT, 'provider-1')).resolves.toMatchObject({ jobId: expect.any(String) });
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('gates each directory provider INDEPENDENTLY — enabling Graph does not enable Google', async () => {
    const { svc, providerRepository } = makeService({ [TENANT_IDP_MS_GRAPH_ENABLED_KEY]: true });
    providerRepository.findById.mockResolvedValue(makeProvider('google-directory'));

    await expect(svc.enqueueSync(TENANT, 'provider-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves the gate for the REQUEST tenant, never a hardcoded one', async () => {
    const { svc, providerRepository, effectiveSettings } = makeService({ [TENANT_IDP_MS_GRAPH_ENABLED_KEY]: true });
    providerRepository.findById.mockResolvedValue(makeProvider('ms-graph'));

    await svc.enqueueSync(TENANT, 'provider-1');

    expect(effectiveSettings.resolveEffective).toHaveBeenCalledWith(TENANT_IDP_MS_GRAPH_ENABLED_KEY, { tenantId: TENANT });
  });

  it('the PROCESSOR re-checks, so a queued job cannot outlive the gate being turned off', async () => {
    const { processor, providerRepository, msGraphProvider } = makeProcessor();
    providerRepository.findById.mockResolvedValue(makeProvider('ms-graph'));

    await expect(processor.process(job({ tenantId: TENANT, providerId: 'p1' }))).rejects.toThrow(/not enabled for this tenant/i);
    expect(msGraphProvider.fetchUsers, 'a disabled capability must do no work').not.toHaveBeenCalled();
  });

  it('the processor proceeds when the tenant IS enabled', async () => {
    const { processor, providerRepository, msGraphProvider } = makeProcessor({ [TENANT_IDP_MS_GRAPH_ENABLED_KEY]: true });
    providerRepository.findById.mockResolvedValue(makeProvider('ms-graph'));

    await processor.process(job({ tenantId: TENANT, providerId: 'p1' }));

    expect(msGraphProvider.fetchUsers).toHaveBeenCalled();
  });

  it('FAILS CLOSED when the settings facade is unwired — a capability is never assumed on', async () => {
    // The opposite of the live-doc tuning knobs, deliberately: an unresolvable
    // TUNING value degrades to its default, but an unresolvable CAPABILITY must
    // not grant itself. `default: false` is the safe end, and it is also what an
    // absent facade yields.
    const providerRepository = { findById: vi.fn().mockResolvedValue(makeProvider('ms-graph')) };
    const queue = { add: vi.fn() };
    const svc = new DirectorySyncService(providerRepository as never, queue as never, undefined as never);

    await expect(svc.enqueueSync(TENANT, 'provider-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
