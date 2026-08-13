/**
 * Cross-tenant contract for the platform-default cascade.
 *
 * R1 widens what the injection resolver READS: it now performs a second,
 * explicitly SYSTEM-pinned query in addition to the caller's own. That is
 * exactly the kind of widening that has historically leaked one tenant's rows
 * to another, and `AiProviderConnection` is a SECRET-BEARING table, so the
 * invariant is asserted here against the REAL resolver rather than trusted to a
 * comment in the service.
 *
 * The contracts locked:
 *   1. Only two tenantIds may ever appear in a read: the caller's and SYSTEM.
 *   2. Tenant A's credential is never served to tenant B — B gets the platform
 *      default, and A's key material appears nowhere in B's result.
 *   3. The funding label follows the ROW's owning tenant, so B's
 *      platform-served call cannot be invoiced as if B had brought its own key.
 *
 * Deliberately a unit-level probe with a fake repository (it runs under
 * `pnpm test:unit`): the point is the resolver's own read shape, and a fake
 * repository lets the test observe every `where.tenantId` the resolver asks
 * for — which a live database cannot.
 *
 * Like `fixtures.ts`, this file stays free of `@arcaai/domains`: the root
 * `tests/` project resolves only what the root `node_modules` and the
 * `@arcaai/applications` alias in `vitest.config.ts` provide. Hence the literal
 * SYSTEM tenant id (mirroring `SYSTEM_TENANT_ID` in
 * `packages/domains/src/constants`) and plain row objects rather than the
 * entity factory — the resolver reads fields, not entity behaviour.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionService } from '@arcaai/applications';
import { createCrossTenantFixture } from './fixtures';

/** Literal mirror of `SYSTEM_TENANT_ID` (`@arcaai/domains`) — see the header. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const fx = createCrossTenantFixture();

function row(tenantId: string, provider: string, key: string) {
  return {
    tenantId,
    service: 'llm',
    provider,
    enabled: true,
    encryptedApiKey: Buffer.from(key, 'utf8'),
    keyVersion: 1,
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    extraJson: null,
  };
}

/** Every tenant in the world, so a leak has something to leak. */
const WORLD: Record<string, unknown[]> = {
  [fx.tenantA.id]: [row(fx.tenantA.id, 'azure', 'cipher-of-TENANT-A')],
  [fx.tenantB.id]: [],
  [SYSTEM_TENANT_ID]: [row(SYSTEM_TENANT_ID, 'azure', 'cipher-of-PLATFORM')],
};

function makeService(callerTenantId: string) {
  const reads: string[] = [];
  const repo = {
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) => {
      reads.push(tenantId);
      return ((WORLD[tenantId] ?? []) as any[]).filter((r) => r.service === service);
    }),
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) => {
      reads.push(tenantId);
      return ((WORLD[tenantId] ?? []) as any[]).find((r) => r.service === service && r.provider === provider) ?? null;
    }),
  };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u', roles: [] } : k === 'tenantId' ? callerTenantId : undefined)),
  };
  const secrets = {
    // The "plaintext" is derived from the ciphertext so a leaked credential is
    // identifiable in the output by the tenant it belongs to.
    decrypt: vi.fn(async (cipher: unknown) => Buffer.from(String(cipher).replace('cipher-of-', 'key-of-'), 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => true) };
  const svc = new AiProviderConnectionService(repo as any, { baseClient: {} } as any, { emit: vi.fn() } as any, cls as any, secrets as any, entitlements as any);
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, reads };
}

beforeEach(() => vi.clearAllMocks());

describe('the platform-default cascade never widens across tenants', () => {
  it('reads only [caller, SYSTEM] — tenant B never queries tenant A', async () => {
    const { svc, reads } = makeService(fx.tenantB.id);
    await svc.resolveTenantCloudOverrides('llm', fx.tenantB.id);

    expect(new Set(reads)).toEqual(new Set([fx.tenantB.id, SYSTEM_TENANT_ID]));
    expect(reads).not.toContain(fx.tenantA.id);
  });

  it('serves tenant B the PLATFORM credential and never tenant A’s', async () => {
    const { svc } = makeService(fx.tenantB.id);
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', fx.tenantB.id);

    expect(overrides.azure.api_key).toBe('key-of-PLATFORM');
    expect(JSON.stringify(overrides)).not.toContain('TENANT-A');
  });

  it('labels B’s platform-served call `platform`, so it cannot be invoiced as B’s own BYOK', async () => {
    const { svc } = makeService(fx.tenantB.id);
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', fx.tenantB.id);
    expect(overrides.azure.funding).toBe('platform');
  });

  it('tenant A keeps its own credential, labelled `tenant`', async () => {
    const { svc } = makeService(fx.tenantA.id);
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', fx.tenantA.id);
    expect(overrides.azure).toMatchObject({ api_key: 'key-of-TENANT-A', funding: 'tenant' });
  });

  it('a GLOBAL ADMIN resolving for tenant A under working tenant B still reads only [A, SYSTEM]', async () => {
    // The cross-tenant lane hands the resolver the UNSCOPED base client, on
    // which the explicit `tenantId` predicate is the ONLY tenant boundary. The
    // SYSTEM read must stay pinned rather than becoming an unfiltered read of
    // a secret-bearing table.
    const reads: string[] = [];
    const repo = {
      findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) => {
        expect(tenantId).toBeTypeOf('string');
        reads.push(tenantId);
        return ((WORLD[tenantId] ?? []) as any[]).filter((r) => r.service === service);
      }),
      findByTenantServiceProvider: vi.fn(async () => null),
    };
    const cls = {
      get: vi.fn((k: string) =>
        k === 'user' ? { id: fx.superAdmin.id, roles: fx.superAdmin.roles } : k === 'tenantId' ? fx.tenantB.id : undefined,
      ),
    };
    const svc = new AiProviderConnectionService(
      repo as any,
      { baseClient: { $lane: 'unscoped' } } as any,
      { emit: vi.fn() } as any,
      cls as any,
      { decrypt: vi.fn(async () => Buffer.from('k')), supportsTransit: () => true } as any,
      { isFeatureEnabled: vi.fn(async () => true) } as any,
    );
    vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.resolveTenantCloudOverrides('llm', fx.tenantA.id);
    expect(reads).toEqual([fx.tenantA.id, SYSTEM_TENANT_ID]);
  });
});
