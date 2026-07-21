/**
 * Composition contract test.
 *
 * Verifies that `createExtendedPrismaClient` (the composed factory in
 * `client.ts`) chains soft-delete and tenant-scope in the correct
 * order: tenant-scope runs FIRST (it's the outermost extension), so by
 * the time the Prisma engine sees the query, `args.where` carries BOTH
 *
 *     { tenantId: <ctx>, resourceStatus: { not: 'DELETED' } }
 *
 * in a single pass. The test captures the chained `$extends` config
 * objects via a spy and replays them through their respective handlers
 * to assert the final mutation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class MockPrismaPg {
    constructor(_opts: unknown) {
      // no-op
    }
  },
}));

// Capture every $extends call across the chain so we can inspect both
// handler configs separately. ReturnThis on the spy keeps the chain
// valid (`prisma.$extends(...).$extends(...)`).
const $extendsCalls: Array<{ name: string; query: any }> = [];

vi.mock('../../generated/core-prisma-client/client.js', () => ({
  PrismaClient: class MockPrismaClient {
    $extends: (config: any) => any;
    constructor(_opts?: unknown) {
      const self = this;
      this.$extends = (config: any) => {
        $extendsCalls.push(config);
        return self as unknown as MockPrismaClient;
      };
    }
  },
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    PrismaClientUnknownRequestError: class extends Error {},
    PrismaClientRustPanicError: class extends Error {},
    PrismaClientInitializationError: class extends Error {},
    PrismaClientValidationError: class extends Error {},
  },
}));

vi.mock('../../env.js', () => ({}));

describe('Soft-delete + tenant-scope composition', () => {
  beforeEach(() => {
    $extendsCalls.length = 0;
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(async () => {
    const { setTenantContextProvider } = await import('../tenant-scope');
    setTenantContextProvider(null);
  });

  it('extends the client twice (soft-delete first, then tenant-scope)', async () => {
    const { createNewExtendedPrismaClient } = await import('../../client');
    createNewExtendedPrismaClient();

    expect($extendsCalls.length).toBe(2);
    expect($extendsCalls[0].name).toMatch(/softDeleteFilter/);
    expect($extendsCalls[1].name).toMatch(/tenantScopeFilter/);
  });

  it('a registered provider drives the tenantScope handler', async () => {
    const { createNewExtendedPrismaClient } = await import('../../client');
    const { setTenantContextProvider } = await import('../tenant-scope');

    setTenantContextProvider({
      getTenantId: () => 'tenant-A',
      isSuperAdmin: () => false,
    });

    createNewExtendedPrismaClient();
    const tenantConfig = $extendsCalls[1];
    const softDeleteConfig = $extendsCalls[0];

    // Simulate Prisma walking the chain (tenant-scope first because it
    // was applied last → outermost wrapper). The tenant handler calls
    // `query(args)`, which is the soft-delete handler in production;
    // we replay that hop manually here.
    const finalEngineArgs: Array<unknown> = [];
    const engineQuery = vi.fn((a: unknown) => {
      finalEngineArgs.push(a);
      return Promise.resolve([]);
    });

    // Build the inner (soft-delete) handler bound to the engine.
    const softDeleteFindMany = softDeleteConfig.query.$allModels.findMany;
    const innerQuery = (args: unknown) =>
      softDeleteFindMany({ model: 'Department', args, query: engineQuery });

    // Build the outer (tenant-scope) handler that calls into the inner.
    const tenantFindMany = tenantConfig.query.$allModels.findMany;
    await tenantFindMany({
      model: 'Department',
      args: { where: { name: 'cardio' } },
      query: innerQuery,
    });

    expect(finalEngineArgs).toHaveLength(1);
    expect(finalEngineArgs[0]).toEqual({
      where: {
        name: 'cardio',
        tenantId: 'tenant-A',
        resourceStatus: { not: 'DELETED' },
      },
    });
  });

  it('tenant-scope pass-through when no provider keeps soft-delete intact', async () => {
    const { createNewExtendedPrismaClient } = await import('../../client');
    const { setTenantContextProvider } = await import('../tenant-scope');

    // No provider → tenant-scope treats every request as platform-admin
    // pass-through; soft-delete still injects resourceStatus.
    setTenantContextProvider(null);

    createNewExtendedPrismaClient();
    const tenantConfig = $extendsCalls[1];
    const softDeleteConfig = $extendsCalls[0];

    const engineArgs: Array<unknown> = [];
    const engineQuery = vi.fn((a: unknown) => {
      engineArgs.push(a);
      return Promise.resolve([]);
    });

    const softFindMany = softDeleteConfig.query.$allModels.findMany;
    const innerQuery = (args: unknown) =>
      softFindMany({ model: 'Department', args, query: engineQuery });

    const tenantFindMany = tenantConfig.query.$allModels.findMany;
    await tenantFindMany({
      model: 'Department',
      args: { where: {} },
      query: innerQuery,
    });

    expect(engineArgs[0]).toEqual({
      where: { resourceStatus: { not: 'DELETED' } },
    });
  });

  it('non-tenant-scoped model (Tenant) skips tenant-scope but still gets soft-delete', async () => {
    const { createNewExtendedPrismaClient } = await import('../../client');
    const { setTenantContextProvider } = await import('../tenant-scope');

    setTenantContextProvider({
      getTenantId: () => 'tenant-A',
      isSuperAdmin: () => false,
    });

    createNewExtendedPrismaClient();
    const tenantConfig = $extendsCalls[1];
    const softDeleteConfig = $extendsCalls[0];

    const engineArgs: Array<unknown> = [];
    const engineQuery = vi.fn((a: unknown) => {
      engineArgs.push(a);
      return Promise.resolve([]);
    });

    const softFindMany = softDeleteConfig.query.$allModels.findMany;
    const innerQuery = (args: unknown) =>
      softFindMany({ model: 'Tenant', args, query: engineQuery });

    const tenantFindMany = tenantConfig.query.$allModels.findMany;
    await tenantFindMany({
      model: 'Tenant',
      args: { where: { name: 'acme' } },
      query: innerQuery,
    });

    expect(engineArgs[0]).toEqual({
      where: { name: 'acme', resourceStatus: { not: 'DELETED' } },
    });
  });
});
