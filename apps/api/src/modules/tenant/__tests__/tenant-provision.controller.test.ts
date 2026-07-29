import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantProvisionController } from '../tenant-provision.controller';

function createMockTenantOnboardingService() {
  return { provisionTenantWithAdmin: vi.fn() };
}

function createMockCls(
  user: { id?: string; tenantId?: string | null; roles?: string[] } | null = { id: 'admin-1', tenantId: null, roles: ['GLOBAL_ADMIN'] },
) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      if (key === 'tenantId') return user?.tenantId ?? undefined;
      return undefined;
    }),
  };
}

describe('TenantProvisionController', () => {
  let controller: TenantProvisionController;
  let tenantOnboardingService: ReturnType<typeof createMockTenantOnboardingService>;

  beforeEach(() => {
    tenantOnboardingService = createMockTenantOnboardingService();
    controller = new TenantProvisionController(tenantOnboardingService as never, createMockCls() as never);
    tenantOnboardingService.provisionTenantWithAdmin.mockResolvedValue({
      tenant: { id: 'new-tenant-id', key: 'acme-health', name: 'Acme Health', tags: [], version: 1 },
      adminUserId: 'existing-admin-id',
      tenantKey: 'acme-health',
    });
  });

  it('maps mode=existing into an existing TenantAdminSpec and stamps the caller as actor', async () => {
    await controller.provision({
      tenantName: 'Acme Health',
      admin: { mode: 'existing', userId: 'existing-admin-id' },
    } as never);

    expect(tenantOnboardingService.provisionTenantWithAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantName: 'Acme Health',
        admin: { kind: 'existing', userId: 'existing-admin-id' },
        actor: { userId: 'admin-1', tenantId: '' },
      }),
    );
  });

  it('maps mode=new-local into a new-local TenantAdminSpec', async () => {
    await controller.provision({
      tenantName: 'Acme Health',
      admin: { mode: 'new-local', email: 'admin@acme.test', username: 'admin', password: 'S3cret!Pass' },
    } as never);

    expect(tenantOnboardingService.provisionTenantWithAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        admin: { kind: 'new-local', email: 'admin@acme.test', username: 'admin', password: 'S3cret!Pass' },
      }),
    );
  });

  it('passes tenantKey/plan through untouched', async () => {
    await controller.provision({
      tenantName: 'Acme Health',
      tenantKey: 'acme-explicit',
      plan: 'ENTERPRISE',
      admin: { mode: 'existing', userId: 'existing-admin-id' },
    } as never);

    expect(tenantOnboardingService.provisionTenantWithAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'acme-explicit', plan: 'ENTERPRISE' }),
    );
  });

  it('maps the service result to a TenantProvisionResponse', async () => {
    const result = await controller.provision({
      tenantName: 'Acme Health',
      admin: { mode: 'existing', userId: 'existing-admin-id' },
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        adminUserId: 'existing-admin-id',
        tenantKey: 'acme-health',
        tenant: expect.objectContaining({ id: 'new-tenant-id', key: 'acme-health' }),
      }),
    );
  });
});
