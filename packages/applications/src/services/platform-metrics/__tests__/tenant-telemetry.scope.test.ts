/**
 * Admin telemetry tenant-scope resolution.
 *
 * super-admin may target `?tenantId=` (or omit for all-tenants); a tenant-admin
 * is pinned to their CLS tenant and any supplied tenantId is ignored; a non-super
 * caller with no CLS tenant is Forbidden.
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { resolveAdminTenantScope } from '../../../common';

const SUPER = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = { roles: ['TENANT_ADMIN'] };

describe('resolveAdminTenantScope (#21)', () => {
  it('super-admin may target a specific tenant via ?tenantId=', () => {
    expect(resolveAdminTenantScope({ user: SUPER, clsTenantId: null, requestedTenantId: 'tenant-2' })).toBe('tenant-2');
  });

  it('super-admin with no requested tenant rolls up all tenants (null)', () => {
    expect(resolveAdminTenantScope({ user: SUPER, clsTenantId: null })).toBeNull();
  });

  it('tenant-admin is pinned to CLS tenant; a supplied tenantId is ignored', () => {
    expect(resolveAdminTenantScope({ user: TENANT_ADMIN, clsTenantId: 'tenant-1', requestedTenantId: 'tenant-2' })).toBe('tenant-1');
  });

  it('non-super caller with no CLS tenant is Forbidden', () => {
    expect(() => resolveAdminTenantScope({ user: TENANT_ADMIN, clsTenantId: null })).toThrow(ForbiddenException);
  });
});
