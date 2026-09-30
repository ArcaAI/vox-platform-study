/**
 * `GET admin/ai-models/access` — what the caller may do on the model registry.
 *
 * OD-1: only a platform admin (SUPER_ADMIN with NO working tenant) manages; the
 * `modelRegistry.tenantManagement.enabled` toggle is REPORTED but grants nothing.
 * The toggle fails closed: a resolution error reports `false`.
 */
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelRegistryAccessService } from '../model-registry-access.service';
import { MODEL_REGISTRY_TENANT_MANAGEMENT_ENABLED_KEY } from '../../../settings-registry/descriptors/feature-availability.descriptors';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function cls(opts: { roles: string[]; tenantId: string | null }) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'u-1', roles: opts.roles };
      if (key === 'tenantId') return opts.tenantId;
      return null;
    }),
  };
}

function settings(value: boolean | Error) {
  return {
    resolveEffective: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return { key: MODEL_REGISTRY_TENANT_MANAGEMENT_ENABLED_KEY, value, sourceScope: 'tenant' };
    }),
  };
}

function build(opts: { roles: string[]; tenantId: string | null; toggle: boolean | Error }) {
  const effective = settings(opts.toggle);
  const svc = new ModelRegistryAccessService(cls(opts) as never, effective as never);
  return { svc, effective };
}

describe('ModelRegistryAccessService.getAccess', () => {
  it('super admin with no working tenant → canManage true (toggle resolved at the platform tier)', async () => {
    const { svc, effective } = build({ roles: ['SUPER_ADMIN'], tenantId: null, toggle: false });
    await expect(svc.getAccess()).resolves.toEqual({ canManage: true, tenantManagementEnabled: false });
    expect(effective.resolveEffective).toHaveBeenCalledWith(MODEL_REGISTRY_TENANT_MANAGEMENT_ENABLED_KEY, { tenantId: SYSTEM_TENANT_ID });
  });

  it('super admin WITH a working tenant → canManage false', async () => {
    const { svc } = build({ roles: ['SUPER_ADMIN'], tenantId: TENANT_A, toggle: false });
    await expect(svc.getAccess()).resolves.toEqual({ canManage: false, tenantManagementEnabled: false });
  });

  it('tenant admin, toggle OFF → canManage false, tenantManagementEnabled false', async () => {
    const { svc, effective } = build({ roles: ['TENANT_ADMIN'], tenantId: TENANT_A, toggle: false });
    await expect(svc.getAccess()).resolves.toEqual({ canManage: false, tenantManagementEnabled: false });
    expect(effective.resolveEffective).toHaveBeenCalledWith(MODEL_REGISTRY_TENANT_MANAGEMENT_ENABLED_KEY, { tenantId: TENANT_A });
  });

  it('tenant admin, toggle ON → still canManage false (OD-1: the toggle grants nothing yet), reported true', async () => {
    const { svc } = build({ roles: ['TENANT_ADMIN'], tenantId: TENANT_A, toggle: true });
    await expect(svc.getAccess()).resolves.toEqual({ canManage: false, tenantManagementEnabled: true });
  });

  it('toggle resolution throws → tenantManagementEnabled false (fail closed)', async () => {
    const { svc } = build({ roles: ['TENANT_ADMIN'], tenantId: TENANT_A, toggle: new Error('control plane down') });
    await expect(svc.getAccess()).resolves.toEqual({ canManage: false, tenantManagementEnabled: false });
  });

  it('no settings facade wired → tenantManagementEnabled false', async () => {
    const svc = new ModelRegistryAccessService(cls({ roles: ['SUPER_ADMIN'], tenantId: null }) as never, undefined);
    await expect(svc.getAccess()).resolves.toEqual({ canManage: true, tenantManagementEnabled: false });
  });
});
