import { REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_FORBIDDEN } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_FORBIDDEN } from '@arcaai/applications';
import { GuardrailAvailabilityController } from '../guardrail-availability.controller';

describe('GuardrailAvailabilityController', () => {
  const service = {
    catalogue: vi.fn().mockReturnValue([]),
    list: vi.fn().mockResolvedValue([]),
    getForTenant: vi.fn().mockResolvedValue({ tenantId: 't', version: 0 }),
    putForTenant: vi.fn().mockResolvedValue({ tenantId: 't', version: 1 }),
  };
  let controller: GuardrailAvailabilityController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new GuardrailAvailabilityController(service as never);
  });

  it('delegates every route to the service — the controller holds no logic', async () => {
    await controller.list();
    await controller.getForTenant('tenant-a');
    controller.catalogue();
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.getForTenant).toHaveBeenCalledWith('tenant-a');
    expect(service.catalogue).toHaveBeenCalledOnce();
  });

  it('lets the If-Match header WIN over a body expectedVersion (rule 05)', async () => {
    await controller.putForTenant('tenant-a', { policies: {}, expectedVersion: 9 } as never, 3);
    expect(service.putForTenant).toHaveBeenCalledWith('tenant-a', { policies: {}, expectedVersion: 3 });
  });

  it('falls back to the body version when no If-Match reached the handler', async () => {
    await controller.putForTenant('tenant-a', { policies: {}, expectedVersion: 9 } as never, undefined);
    expect(service.putForTenant).toHaveBeenCalledWith('tenant-a', { policies: {}, expectedVersion: 9 });
  });

  it('is API-key FORBIDDEN — the admin plane is JWT-only (policy A2)', () => {
    expect(new Reflector().get(API_KEY_FORBIDDEN, GuardrailAvailabilityController)).toBe(true);
  });

  it('carries a class-level ability so the deny-by-default boot audit stays green', () => {
    // AUTH-NOTE: this decorator deliberately UNDERSTATES the gate. A tenant
    // admin holds `manage:Tenant` for its own tenant and passes here; the
    // service's `assertSuperAdmin` is what refuses it (403). Asserting the
    // decorator's presence — not its sufficiency — is the point.
    const declared = new Reflector().get(REQUIRED_PERMISSIONS_KEY, GuardrailAvailabilityController);
    expect(declared).toEqual([{ action: 'manage', subject: 'Tenant' }]);
  });
});

// TASK-886 follow-up — the boot audit (`service-account-surface-audit.ts`) refuses to start
// when an admin route says nothing about service-account access; this surface forbids it.
describe('GuardrailAvailabilityController — machine classes', () => {
  it('forbids service accounts explicitly at the class level', () => {
    expect(new Reflector().get(SERVICE_ACCOUNT_FORBIDDEN, GuardrailAvailabilityController)).toBe(true);
  });
});
