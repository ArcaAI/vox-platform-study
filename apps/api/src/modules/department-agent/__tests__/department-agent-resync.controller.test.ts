/**
 * DepartmentAgentResyncController unit tests.
 *
 * Verifies the GLOBAL_ADMIN gate (`@CanManage('Tenant')` — the same privilege
 * posture as tenant provisioning, NOT the tenant-admin `manage:DepartmentAgent`
 * of the main controller) and that the route delegates to the right service:
 * a `tenantId` reconciles one tenant, no body sweeps every tenant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { DepartmentAgentResyncController } from '../department-agent-resync.controller';

describe('DepartmentAgentResyncController — authorization metadata', () => {
  it('gates resync on manage:Tenant (GLOBAL_ADMIN — writes into arbitrary tenants)', () => {
    const meta = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      (DepartmentAgentResyncController.prototype as never as Record<string, unknown>).resync as object,
    );
    expect(meta).toEqual([{ action: 'manage', subject: 'Tenant' }]);
  });
});

describe('DepartmentAgentResyncController — delegation', () => {
  const resyncService = { resyncTenant: vi.fn() };
  const cronService = { resyncAllTenants: vi.fn() };
  let controller: DepartmentAgentResyncController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new DepartmentAgentResyncController(resyncService as never, cronService as never);
  });

  it('reconciles a single tenant when tenantId is supplied', async () => {
    resyncService.resyncTenant.mockResolvedValue({ added: 1, fastForwarded: 0, skipped: 2 });

    const result = await controller.resync({ tenantId: 'tenant-9' } as never);

    expect(resyncService.resyncTenant).toHaveBeenCalledWith('tenant-9');
    expect(cronService.resyncAllTenants).not.toHaveBeenCalled();
    expect(result).toEqual({ added: 1, fastForwarded: 0, skipped: 2 });
  });

  it('sweeps every tenant when no tenantId is supplied', async () => {
    cronService.resyncAllTenants.mockResolvedValue({ added: 5, fastForwarded: 3, skipped: 10 });

    const result = await controller.resync({} as never);

    expect(cronService.resyncAllTenants).toHaveBeenCalledTimes(1);
    expect(resyncService.resyncTenant).not.toHaveBeenCalled();
    expect(result).toEqual({ added: 5, fastForwarded: 3, skipped: 10 });
  });
});
