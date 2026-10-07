/**
 * TASK-1050 W2b — `admin/guardrail/policy` (the tenant on/off route). The controller holds no logic:
 * the field-level split gate lives in `GuardrailTenantPolicyService`. What this file pins is the
 * decorator surface the boot audits and the authz matrix read: human-only (API key and service account
 * refused), `read` on GET, `manage` + If-Match on PUT, the header winning over a body version.
 */
import { API_KEY_FORBIDDEN, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_FORBIDDEN } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators/requiresIfMatch.decorator';
import { GuardrailTenantPolicyController } from '../guardrail-tenant-policy.controller';

describe('GuardrailTenantPolicyController', () => {
  const service = { getOwn: vi.fn().mockResolvedValue({ tenantId: 't', version: 0 }), putOwn: vi.fn().mockResolvedValue({ tenantId: 't', version: 1 }) };
  let controller: GuardrailTenantPolicyController;
  const reflector = new Reflector();

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new GuardrailTenantPolicyController(service as never);
  });

  it('delegates GET to the service', async () => {
    await controller.get();
    expect(service.getOwn).toHaveBeenCalledOnce();
  });

  it('lets If-Match WIN over a body expectedVersion, and falls back to the body without one', async () => {
    await controller.put({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 9 }, 3);
    expect(service.putOwn).toHaveBeenLastCalledWith({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 3 });
    await controller.put({ checks: {}, expectedVersion: 9 }, undefined);
    expect(service.putOwn).toHaveBeenLastCalledWith({ checks: {}, expectedVersion: 9 });
  });

  it('is human-only: API keys and service accounts are refused at the class', () => {
    expect(reflector.get(API_KEY_FORBIDDEN, GuardrailTenantPolicyController)).toBe(true);
    expect(reflector.get(SERVICE_ACCOUNT_FORBIDDEN, GuardrailTenantPolicyController)).toBe(true);
  });

  it('GET needs read:TenantGuardrailPolicy, PUT manage:TenantGuardrailPolicy plus If-Match', () => {
    const prototype = GuardrailTenantPolicyController.prototype;
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [prototype.get, GuardrailTenantPolicyController])).toEqual([
      { action: 'read', subject: 'TenantGuardrailPolicy' },
    ]);
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [prototype.put, GuardrailTenantPolicyController])).toEqual([
      { action: 'manage', subject: 'TenantGuardrailPolicy' },
    ]);
    expect(reflector.get(REQUIRES_IF_MATCH_KEY, prototype.put)).toBe(true);
    expect(reflector.get(REQUIRES_IF_MATCH_KEY, prototype.get)).toBeUndefined();
  });
});
