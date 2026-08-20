/**
 * EntitlementsAdminController unit tests.
 *
 * The full CASL `@Authorize(['manage','all'])` + `@ForbidApiKey()` +
 * `@RequiredSvcScopes(...)` chain is exercised by the guard pipeline (+ e2e).
 * These specs cover the controller's OWN logic — plain delegation to
 * `IEntitlementsService` / `IEntitlementsLifecycleService` with the exact
 * arguments derived from params/body — plus the decorator-drift regression
 * check: this is a SUPER_ADMIN-only surface (`manage all`, granted only by
 * `system-full-access`), so losing `@ForbidApiKey()` or the svc scope would
 * silently open a money/quota-control surface to a tenant API key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { REQUIRED_PERMISSIONS_KEY, API_KEY_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';

import { EntitlementsAdminController } from '../entitlements-admin.controller';

function makeServices() {
  return {
    entitlements: {
      isEnforcementEnabled: vi.fn().mockReturnValue(true),
      setEnforcementEnabled: vi.fn().mockResolvedValue(true),
      listPlanEntitlements: vi.fn().mockResolvedValue([]),
      getPlanEntitlement: vi.fn().mockResolvedValue({}),
      updatePlanEntitlement: vi.fn().mockResolvedValue({}),
      getCapabilities: vi.fn().mockResolvedValue({}),
      getTenantEntitlement: vi.fn().mockResolvedValue(null),
      upsertTenantEntitlement: vi.fn().mockResolvedValue({}),
      clearTenantEntitlement: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      triggerDowngrade: vi.fn().mockResolvedValue({}),
      expireTrials: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('EntitlementsAdminController — delegation', () => {
  let services: ReturnType<typeof makeServices>;
  let controller: EntitlementsAdminController;

  beforeEach(() => {
    services = makeServices();
    controller = new EntitlementsAdminController(services.entitlements as never, services.lifecycle as never);
  });

  it('reads the kill-switch', () => {
    const result = controller.getEnabled();
    expect(services.entitlements.isEnforcementEnabled).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true });
  });

  it('flips the kill-switch with the exact body value', async () => {
    const result = await controller.setEnabled({ enabled: false } as never);
    expect(services.entitlements.setEnforcementEnabled).toHaveBeenCalledWith(false);
    expect(result).toEqual({ enabled: true });
  });

  it('lists plan defaults', async () => {
    await controller.listPlans();
    expect(services.entitlements.listPlanEntitlements).toHaveBeenCalledWith();
  });

  it('gets a single plan by param', async () => {
    await controller.getPlan('PRO');
    expect(services.entitlements.getPlanEntitlement).toHaveBeenCalledWith('PRO');
  });

  it('updates a plan with param + body', async () => {
    const body = { defaultLimits: { seats: 10 } };
    await controller.updatePlan('PRO', body as never, undefined);
    expect(services.entitlements.updatePlanEntitlement).toHaveBeenCalledWith('PRO', body);
  });

  it('gets a tenant capability snapshot', async () => {
    await controller.getTenantSnapshot('tenant-9');
    expect(services.entitlements.getCapabilities).toHaveBeenCalledWith('tenant-9');
  });

  it('gets a tenant override', async () => {
    await controller.getOverride('tenant-9');
    expect(services.entitlements.getTenantEntitlement).toHaveBeenCalledWith('tenant-9');
  });

  it('upserts a tenant override with param + body', async () => {
    const body = { seats: 20, expectedVersion: 1 };
    await controller.upsertOverride('tenant-9', body as never, undefined);
    expect(services.entitlements.upsertTenantEntitlement).toHaveBeenCalledWith('tenant-9', body);
  });

  it('clears a tenant override and reports cleared', async () => {
    const result = await controller.clearOverride('tenant-9');
    expect(services.entitlements.clearTenantEntitlement).toHaveBeenCalledWith('tenant-9');
    expect(result).toEqual({ cleared: true });
  });

  it('triggers a downgrade with param + body.plan', async () => {
    await controller.triggerDowngrade('tenant-9', { plan: 'STARTER' } as never);
    expect(services.lifecycle.triggerDowngrade).toHaveBeenCalledWith('tenant-9', 'STARTER');
  });

  it('runs the trial-expiry sweep with no arguments', async () => {
    await controller.runTrialExpiry();
    expect(services.lifecycle.expireTrials).toHaveBeenCalledWith();
  });
});

describe('EntitlementsAdminController — authorization metadata', () => {
  const reflector = new Reflector();

  it('carries class-level manage:all authorization', () => {
    const required = reflector.get(REQUIRED_PERMISSIONS_KEY, EntitlementsAdminController);
    expect(required).toEqual([{ action: 'manage', subject: 'all' }]);
  });

  it('forbids API-key credentials at the class level', () => {
    const forbidden = reflector.get(API_KEY_FORBIDDEN, EntitlementsAdminController);
    expect(forbidden).toBe(true);
  });

  it('requires the admin:entitlement:manage svc scope at the class level', () => {
    const scopes = reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, EntitlementsAdminController);
    expect(scopes).toEqual(['svc:admin:entitlement:manage']);
  });
});
