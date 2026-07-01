import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlatformMetricsController } from '../platform-metrics.controller';

/**
 * TASK-386 (#16 / E1·E2·E3) — controller delegation unit test.
 *
 * The auth matrix (super-admin → 200, tenant-admin / doctor → 403 via the
 * `@CanManage('PlatformMetrics')` gate) is enforced by the global
 * `UnifiedAuthGuard` and is asserted end-to-end in
 * `apps/api/tests/e2e/task-386-platform-metrics.spec.ts` (PM1). Here we pin the
 * controller→service wiring and the `?tenantId=` → null mapping.
 */
describe('PlatformMetricsController (E1/E2/E3)', () => {
  let controller: PlatformMetricsController;
  const svc = {
    getPlatformMetrics: vi.fn(),
    getOpenSockets: vi.fn(),
    getConsumptionRollup: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new PlatformMetricsController(svc as never);
  });

  it('E1 — getMetrics delegates to getPlatformMetrics', async () => {
    const payload = { requestsPerMinute: 1 } as never;
    svc.getPlatformMetrics.mockResolvedValue(payload);

    await expect(controller.getMetrics()).resolves.toBe(payload);
    expect(svc.getPlatformMetrics).toHaveBeenCalledOnce();
  });

  it('E2 — getSockets delegates to getOpenSockets', async () => {
    const payload = { open: 3 } as never;
    svc.getOpenSockets.mockResolvedValue(payload);

    await expect(controller.getSockets()).resolves.toBe(payload);
    expect(svc.getOpenSockets).toHaveBeenCalledOnce();
  });

  it('E3 — getConsumption passes a non-empty tenantId through', async () => {
    svc.getConsumptionRollup.mockResolvedValue({} as never);

    await controller.getConsumption('tenant-9');

    expect(svc.getConsumptionRollup).toHaveBeenCalledWith('tenant-9');
  });

  it('E3 — getConsumption maps an absent/empty tenantId to null (platform-wide)', async () => {
    svc.getConsumptionRollup.mockResolvedValue({} as never);

    await controller.getConsumption(undefined);
    await controller.getConsumption('');

    expect(svc.getConsumptionRollup).toHaveBeenNthCalledWith(1, null);
    expect(svc.getConsumptionRollup).toHaveBeenNthCalledWith(2, null);
  });
});
