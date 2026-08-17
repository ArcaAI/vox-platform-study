import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertTenantInScope, resolveScopedTenantId, resolveScopedTenantIdOptional } from '../tenant-scope';

// One shared home for the tenant-resolution logic that was
// copy-pasted across tenant / harness-admin / pipeline-policy-admin /
// tenant-tts-config-admin controllers. Super-admin acts cross-tenant via a
// query tenant (or the working tenant elevated into CLS); a tenant-bound caller
// is pinned to its own tenant and a foreign query is rejected.

const GLOBAL = { roles: ['SUPER_ADMIN'] as string[], tenantId: '' };
const TENANT_A = { roles: ['TENANT_ADMIN'] as string[], tenantId: 'tenant-a' };

describe('resolveScopedTenantId', () => {
  it('super-admin: returns the query tenant', () => {
    expect(resolveScopedTenantId(GLOBAL, '', 'tenant-x')).toBe('tenant-x');
  });

  it('super-admin: falls back to the CLS working tenant when no query', () => {
    expect(resolveScopedTenantId(GLOBAL, 'working-tenant', undefined)).toBe('working-tenant');
  });

  it('super-admin: 400 when neither query nor working tenant is present', () => {
    expect(() => resolveScopedTenantId(GLOBAL, undefined, undefined)).toThrow(BadRequestException);
  });

  it('tenant-bound: returns own tenant, ignoring an absent query', () => {
    expect(resolveScopedTenantId(TENANT_A, 'tenant-a', undefined)).toBe('tenant-a');
  });

  it('tenant-bound: a matching query is accepted', () => {
    expect(resolveScopedTenantId(TENANT_A, 'tenant-a', 'tenant-a')).toBe('tenant-a');
  });

  it('tenant-bound: a FOREIGN query is rejected 403', () => {
    expect(() => resolveScopedTenantId(TENANT_A, 'tenant-a', 'tenant-b')).toThrow(ForbiddenException);
  });

  it('tenant-bound: 400 when no tenant context at all', () => {
    expect(() => resolveScopedTenantId({ roles: ['TENANT_ADMIN'] }, undefined, undefined)).toThrow(BadRequestException);
  });
});

describe('resolveScopedTenantIdOptional (list filter)', () => {
  it('super-admin: undefined query = all tenants (undefined)', () => {
    expect(resolveScopedTenantIdOptional(GLOBAL, '', undefined)).toBeUndefined();
  });

  it('super-admin: a query narrows to that tenant', () => {
    expect(resolveScopedTenantIdOptional(GLOBAL, '', 'tenant-x')).toBe('tenant-x');
  });

  it('tenant-bound: pinned to own tenant', () => {
    expect(resolveScopedTenantIdOptional(TENANT_A, 'tenant-a', undefined)).toBe('tenant-a');
  });

  it('tenant-bound: foreign query rejected 403', () => {
    expect(() => resolveScopedTenantIdOptional(TENANT_A, 'tenant-a', 'tenant-b')).toThrow(ForbiddenException);
  });
});

describe('assertTenantInScope', () => {
  it('super-admin: always in scope (no throw)', () => {
    expect(() => assertTenantInScope(GLOBAL, 'any-tenant')).not.toThrow();
  });

  it('tenant-bound: own tenant passes', () => {
    expect(() => assertTenantInScope(TENANT_A, 'tenant-a')).not.toThrow();
  });

  it('tenant-bound: foreign target → 403 by default', () => {
    expect(() => assertTenantInScope(TENANT_A, 'tenant-b')).toThrow(ForbiddenException);
  });

  it('onForeign="notfound": foreign target → 404 (no-existence-leak posture)', () => {
    expect(() => assertTenantInScope(TENANT_A, 'tenant-b', 'notfound')).toThrow(NotFoundException);
  });

  it('no tenant context: 403 (or 404 when requested)', () => {
    expect(() => assertTenantInScope({ roles: ['TENANT_ADMIN'] }, 'tenant-a')).toThrow(ForbiddenException);
    expect(() => assertTenantInScope({ roles: ['TENANT_ADMIN'] }, 'tenant-a', 'notfound')).toThrow(NotFoundException);
  });
});
