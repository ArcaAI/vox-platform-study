import { describe, expect, it, vi } from 'vitest';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { DEFAULT_ROLES, GLOBAL_ROLES, SYSTEM_ROLES, TENANT_EXTENDABLE_ROLES, seedRole } from '../03-role';

/**
 * Owner decision OD-1 (2026-08-20): `Role` gained a `tenantId`.
 *
 * The rule this file pins: **every seeded role belongs to the SYSTEM tenant.**
 * SYSTEM is the platform-configuration TIER; `50000000-…` ("Global") is a
 * CUSTOMER tenant (the platform-admin playground) and must never own a
 * platform role — a built-in owned by a customer tenant would be one
 * customer's row being served to everyone else.
 *
 * Nothing is cloned per tenant either: `Role` is a SYSTEM-shared READ model, so
 * every tenant resolves the built-ins directly. That is asserted here as the
 * absence of any per-tenant seeding, and enforced at runtime by
 * `SYSTEM_SHARED_READ_MODELS` (see `extensions/__tests__/tenant-scope.test.ts`).
 */
describe('Role seed — SYSTEM tenant ownership (OD-1)', () => {
  it('seeds every built-in role under the SYSTEM tenant, never Global and never a customer tenant', async () => {
    const created: Array<Record<string, unknown>> = [];
    const client = {
      policy: { findMany: vi.fn().mockResolvedValue([]) },
      role: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { ...data };
        }),
      },
      rolePolicy: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    };

    await seedRole(client as never);

    expect(created).toHaveLength(DEFAULT_ROLES.length);
    for (const row of created) {
      expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(row.tenantId).not.toBe(SEED_TENANT_ID);
    }
  });

  it('looks existing roles up with the tenant pinned, so it can never adopt a customer tenant’s custom role', async () => {
    const client = {
      policy: { findMany: vi.fn().mockResolvedValue([]) },
      role: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })),
      },
      rolePolicy: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    };

    await seedRole(client as never);

    // Every by-name (and every parent by-id) lookup carries the SYSTEM tenant.
    for (const call of client.role.findFirst.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    }
  });

  it('seeds NO per-tenant copies — built-ins are resolved cross-tenant, not cloned', () => {
    // A regression guard on the shape of the seed itself: the role arrays carry
    // no tenant of their own, so there is no per-tenant fan-out to drift.
    for (const role of [...SYSTEM_ROLES, ...GLOBAL_ROLES, ...TENANT_EXTENDABLE_ROLES]) {
      expect(role).not.toHaveProperty('tenantId');
    }
  });

  it('keeps DEPARTMENT_HEAD / SENIOR_NURSE as SYSTEM-owned templates despite isSystemRole: false', () => {
    // These two are the reason the ownership check cannot be `isSystemRole`
    // alone: they are platform rows a tenant clones, not rows a tenant owns.
    // `RbacRoleService.assertMutable` is what refuses a tenant admin here.
    for (const role of TENANT_EXTENDABLE_ROLES) {
      expect(role.isSystemRole).toBe(false);
    }
    expect(TENANT_EXTENDABLE_ROLES.map((r) => r.name).sort()).toEqual(['DEPARTMENT_HEAD', 'SENIOR_NURSE']);
  });
});
