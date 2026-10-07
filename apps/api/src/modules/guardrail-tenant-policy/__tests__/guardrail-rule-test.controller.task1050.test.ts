/**
 * TASK-1050 round 2 — `POST admin/guardrail/screen`. No logic in the controller: what is pinned is the
 * decorator surface the boot audits, the authz matrix and the throttle read.
 */
import { API_KEY_FORBIDDEN, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_FORBIDDEN } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { GuardrailRuleTestController } from '../guardrail-rule-test.controller';

describe('GuardrailRuleTestController', () => {
  const reflector = new Reflector();
  const handler = GuardrailRuleTestController.prototype.screen;

  it('delegates the body to the service unchanged', async () => {
    const service = { screen: vi.fn().mockResolvedValue({ decision: 'allow' }) };
    const body = { direction: 'inbound' as const, text: 'hello' };
    await expect(new GuardrailRuleTestController(service as never).screen(body)).resolves.toEqual({ decision: 'allow' });
    expect(service.screen).toHaveBeenCalledWith(body);
  });

  it('needs read:TenantGuardrailPolicy and is human-only', () => {
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, GuardrailRuleTestController])).toEqual([
      { action: 'read', subject: 'TenantGuardrailPolicy' },
    ]);
    expect(reflector.get(API_KEY_FORBIDDEN, GuardrailRuleTestController)).toBe(true);
    expect(reflector.get(SERVICE_ACCOUNT_FORBIDDEN, GuardrailRuleTestController)).toBe(true);
  });

  it('rides the heavy (AI processing) throttle tier, like the agent test bench', () => {
    expect(reflector.get('THROTTLER:LIMITheavy', handler)).toBe(20);
    expect(reflector.get('THROTTLER:TTLheavy', handler)).toBe(60000);
  });

  it('is mounted at admin/guardrail + POST screen', () => {
    expect(reflector.get('path', GuardrailRuleTestController)).toBe('admin/guardrail');
    expect(reflector.get('path', handler)).toBe('screen');
  });
});
