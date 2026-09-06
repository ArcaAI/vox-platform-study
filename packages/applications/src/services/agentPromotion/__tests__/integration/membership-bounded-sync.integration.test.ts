/**
 * TASK-889 — `runInTenantContext` against a REAL PostgreSQL, with the REAL extended client.
 *
 * ## Runs with the rest of the integration suite
 *
 * Shipped `describe.skip` while the shared test database still carried the pre-wave schema;
 * un-skipped on 2026-09-06 once the owner reset it onto the wave's schema (the fixture tenants
 * needed the required `key` and had a `code` field the model does not carry). It creates two
 * fixture tenants and removes them — and their departments — when it is done.
 *
 * ## What it adds over the unit proof
 *
 * `agentPromotion/__tests__/membership-bounded-sync.task889.test.ts` drives the real
 * `applyTenantScopeExtension` over a STUB client, so it proves the ARGS each step produces: which
 * tenant the extension injected, and which it asserted. What a stub cannot prove is that those
 * args are ones Postgres accepts and answers correctly — that the row written under tenant B is
 * readable as B, invisible as A, and that a step naming a tenant it is not standing in is refused
 * by the extension before the statement is ever issued. That is this file's whole job.
 *
 * Prerequisites (identical to every other integration suite):
 *   1. `pnpm infra:test:up`
 *   2. `pnpm test:db:reset && pnpm test:db:seed`
 *   3. `pnpm test:integration`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getExtendedPrismaClient,
  // eslint-disable-next-line no-restricted-imports -- allow-list: integration test fixture (core.js §B.4); the arrange/assert reads must see BOTH tenants, which is exactly what the code under test may not do.
  getPlatformAdminPrismaClient_Unscoped,
  setTenantContextProvider,
  type CorePrismaClient,
} from '@arcaai/database';
import { runInTenantContext } from '../../tenant-context';

const TENANT_A = '50000000-0000-0000-0000-0000000889a1';
const TENANT_B = '50000000-0000-0000-0000-0000000889b1';
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/**
 * A stand-in for `ClsService` with the ONE behaviour `runInTenantContext` depends on: `run` opens
 * a nested store inheriting the parent's, and unwinds on the way out. The REAL binding between
 * CLS and Prisma is the tenant-context provider registered below — which is what makes this an
 * integration test of the mechanism rather than of a mock.
 */
function makeClsStandIn(initial: Record<string, unknown>) {
  const stack: Record<string, unknown>[] = [{ ...initial }];
  const top = () => stack[stack.length - 1]!;
  return {
    service: {
      get: (key?: string) => (key === undefined ? top() : top()[key]),
      set: (key: string, value: unknown) => {
        top()[key] = value;
      },
      run: async (optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as () => Promise<unknown>;
        stack.push({ ...top() });
        try {
          return await callback();
        } finally {
          stack.pop();
        }
      },
    },
    currentTenantId: () => top().tenantId as string | null | undefined,
  };
}

describe('runInTenantContext against a live database (TASK-889)', () => {
  const cls = makeClsStandIn({ tenantId: TENANT_A, user: { id: SYSTEM_USER_ID, roles: ['TENANT_ADMIN'] } });
  const scoped = getExtendedPrismaClient();
  let unscoped: CorePrismaClient;

  beforeAll(async () => {
    unscoped = getPlatformAdminPrismaClient_Unscoped();
    await unscoped.$connect();
    setTenantContextProvider({ getTenantId: () => cls.currentTenantId(), isSuperAdmin: () => false });
    for (const id of [TENANT_A, TENANT_B]) {
      await unscoped.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: `TASK-889 ${id.slice(-4)}`, key: `t889-${id.slice(-4)}`, createdBy: SYSTEM_USER_ID },
      });
    }
    await unscoped.department.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
  });

  afterAll(async () => {
    setTenantContextProvider(null);
    await unscoped.department.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await unscoped.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await unscoped.$disconnect();
  });

  it('writes into the NAMED tenant and reads it back there, while the caller stays pinned to their own', async () => {
    // `Department` stands in for any tenant-scoped row a sync writes: the claim under test is the
    // EXTENSION's, not any one model's.
    const written = await runInTenantContext(cls.service as never, TENANT_B, () =>
      scoped.department.create({ data: { tenantId: TENANT_B, name: 'Synced into B', createdBy: SYSTEM_USER_ID } }),
    );

    expect(written.tenantId).toBe(TENANT_B);

    const readAsB = await runInTenantContext(cls.service as never, TENANT_B, () => scoped.department.findFirst({ where: { id: written.id } }));
    expect(readAsB?.id).toBe(written.id);

    // The caller's own context is untouched by the step, and cannot see B's row.
    expect(cls.currentTenantId()).toBe(TENANT_A);
    await expect(scoped.department.findFirst({ where: { id: written.id } })).resolves.toBeNull();
  });

  it('refuses a step that names one tenant while writing another — the boundary is enforced, not assumed', async () => {
    await expect(
      runInTenantContext(cls.service as never, TENANT_B, () =>
        scoped.department.create({ data: { tenantId: TENANT_A, name: 'Wrong tenant', createdBy: SYSTEM_USER_ID } }),
      ),
    ).rejects.toThrow(/TenantScope: tenantId mismatch/);

    await expect(unscoped.department.count({ where: { name: 'Wrong tenant' } })).resolves.toBe(0);
  });
});
