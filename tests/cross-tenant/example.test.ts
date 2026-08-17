/**
 * Cross-tenant fixture shape check.
 *
 * This file is the pinning test for `createCrossTenantFixture()`.
 * It asserts the synthetic-object shape that downstream tests rely on
 * (tenant A / tenant B / two non-elevated users / one super admin /
 * a CLS-context shaper) and pins the deterministic UUIDs so that any
 * test which hard-codes a fixture id stays stable across refactors.
 *
 * It deliberately stays in the monorepo-root `tests/cross-tenant/`
 * directory so the fixture is reachable from any package via a
 * relative path (per the Phase E.1 spec).
 */
import { describe, expect, it } from 'vitest';

import { createCrossTenantFixture } from './fixtures';

describe('createCrossTenantFixture (Phase E.1)', () => {
  it('returns deterministic tenant A and tenant B with distinct ids', () => {
    const fx = createCrossTenantFixture();

    expect(fx.tenantA.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(fx.tenantA.name).toBeTypeOf('string');
    expect(fx.tenantA.name.length).toBeGreaterThan(0);

    expect(fx.tenantB.id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(fx.tenantB.name).toBeTypeOf('string');
    expect(fx.tenantB.name.length).toBeGreaterThan(0);

    expect(fx.tenantA.id).not.toBe(fx.tenantB.id);
  });

  it('returns non-elevated user A bound to tenant A', () => {
    const fx = createCrossTenantFixture();

    expect(fx.userA.tenantId).toBe(fx.tenantA.id);
    expect(fx.userA.roles).toEqual(expect.any(Array));
    expect(fx.userA.roles).not.toContain('SUPER_ADMIN');
    expect(fx.userA.id).toBeTypeOf('string');
    expect(fx.userA.id.length).toBeGreaterThan(0);
  });

  it('returns non-elevated user B bound to tenant B', () => {
    const fx = createCrossTenantFixture();

    expect(fx.userB.tenantId).toBe(fx.tenantB.id);
    expect(fx.userB.roles).toEqual(expect.any(Array));
    expect(fx.userB.roles).not.toContain('SUPER_ADMIN');
    expect(fx.userB.id).toBeTypeOf('string');
    expect(fx.userB.id.length).toBeGreaterThan(0);
    expect(fx.userB.id).not.toBe(fx.userA.id);
  });

  it('returns a super-admin user whose roles array contains SUPER_ADMIN', () => {
    const fx = createCrossTenantFixture();

    expect(fx.superAdmin.roles).toContain('SUPER_ADMIN');
    expect(fx.superAdmin.tenantId).toBeTypeOf('string');
    expect(fx.superAdmin.id).toBeTypeOf('string');
    expect(fx.superAdmin.id).not.toBe(fx.userA.id);
    expect(fx.superAdmin.id).not.toBe(fx.userB.id);
  });

  it('clsContext(user) returns the IActiveUserContext payload shape', () => {
    const fx = createCrossTenantFixture();

    const ctx = fx.clsContext(fx.userA);

    expect(ctx.tenantId).toBe(fx.userA.tenantId);
    expect(ctx.user).toMatchObject({
      id: fx.userA.id,
      tenantId: fx.userA.tenantId,
      roles: fx.userA.roles,
      permissions: [],
    });
  });

  it('clsContext(superAdmin) flips the elevated bit through roles', () => {
    const fx = createCrossTenantFixture();

    const ctx = fx.clsContext(fx.superAdmin);

    expect(ctx.user.roles).toContain('SUPER_ADMIN');
    expect(ctx.user.permissions).toEqual([]);
  });
});
