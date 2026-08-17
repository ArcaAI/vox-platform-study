import { describe, it, expect } from 'vitest';
import { resolveActiveTenant } from '../resolve-active-tenant';

// Pure decision helper for super-admin "manage as tenant" elevation.
// A super-admin authenticates with an EMPTY
// CLS tenantId; selecting a tenant in the console sends `x-tenant-id`. The
// helper decides whether that header may elevate the active tenant.
describe('resolveActiveTenant', () => {
  const VALID_TENANT = '0190b6e2-7e7a-7c3a-8b1a-2c3d4e5f6a7b';
  const superAdmin = { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] };

  it('elevates to the header tenant for a super-admin with an empty JWT tenant and a valid UUID header', () => {
    expect(resolveActiveTenant(superAdmin, VALID_TENANT)).toEqual({
      type: 'elevate',
      tenantId: VALID_TENANT,
    });
  });

  it('treats a null JWT tenant the same as empty for a super-admin', () => {
    expect(resolveActiveTenant({ ...superAdmin, tenantId: null }, VALID_TENANT)).toEqual({
      type: 'elevate',
      tenantId: VALID_TENANT,
    });
  });

  it('does NOT elevate a super-admin when no header is present', () => {
    expect(resolveActiveTenant(superAdmin, undefined)).toEqual({ type: 'none' });
  });

  it('does NOT elevate a non-super-admin even with a valid header', () => {
    const tenantUser = { id: 'u-1', tenantId: '', roles: ['DEPARTMENT_ADMIN'] };
    expect(resolveActiveTenant(tenantUser, VALID_TENANT)).toEqual({ type: 'none' });
  });

  it('does NOT elevate when there is no user at all', () => {
    expect(resolveActiveTenant(undefined, VALID_TENANT)).toEqual({ type: 'none' });
    expect(resolveActiveTenant(null, VALID_TENANT)).toEqual({ type: 'none' });
  });

  it('does NOT elevate a tenant-bound caller (truthy JWT tenant) — divergence is the interceptor’s job', () => {
    const boundUser = { id: 'u-2', tenantId: 'tenant-A', roles: ['SUPER_ADMIN'] };
    expect(resolveActiveTenant(boundUser, VALID_TENANT)).toEqual({ type: 'none' });
  });

  it('signals invalid when a super-admin passes a malformed (non-UUID) header', () => {
    expect(resolveActiveTenant(superAdmin, 'not-a-uuid')).toEqual({ type: 'invalid' });
    expect(resolveActiveTenant(superAdmin, 'tenant-123')).toEqual({ type: 'invalid' });
  });
});
