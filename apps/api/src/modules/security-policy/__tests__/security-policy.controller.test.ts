import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_FORBIDDEN,
  type ISecurityPolicyService,
  REQUIRED_PERMISSIONS_KEY,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  SKIP_AUTH_KEY,
} from '@arcaai/applications';
import { SecurityPolicyController } from '../security-policy.controller';

/**
 * TASK-786 — the credential-policy routes.
 *
 * The controller only routes, so the assertions that matter are the metadata a
 * boot audit and the authz matrix read off it: both credential CLASSES that
 * could reach a platform-settings route are accounted for (API keys forbidden
 * outright, service accounts scope-gated), and neither route is accidentally
 * `@Public()`. The super-admin gate itself is imperative and downstream — see
 * the AUTH-NOTE on the controller — and is covered by
 * `security-policy.service.test.ts` plus the write service's own suite.
 */
function makeController(service: Partial<ISecurityPolicyService> = {}) {
  return new SecurityPolicyController(service as ISecurityPolicyService);
}

const reflector = new Reflector();

describe('SecurityPolicyController', () => {
  it('delegates the read to the service', () => {
    const policy = { password: {}, secret: {}, bounds: {} } as never;
    const getPolicy = vi.fn(() => policy);
    expect(makeController({ getPolicy }).getPolicy()).toBe(policy);
    expect(getPolicy).toHaveBeenCalledOnce();
  });

  it('passes the partial update through untouched', async () => {
    const updatePolicy = vi.fn(async () => ({ password: {}, secret: {}, bounds: {} }) as never);
    const request = { secretByteLength: 48 };
    await makeController({ updatePolicy }).updatePolicy(request);
    expect(updatePolicy).toHaveBeenCalledWith(request);
  });

  it('forbids API keys on the whole controller (the business plane never manages platform policy)', () => {
    expect(reflector.get(API_KEY_FORBIDDEN, SecurityPolicyController)).toBe(true);
  });

  it('gates the service-account class behind an explicit scope (no scope = deny by default)', () => {
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, SecurityPolicyController)).toEqual(['svc:admin:settings:manage']);
  });

  it('declares an ability on BOTH routes, so the deny-by-default boot audit stays green', () => {
    for (const handler of [SecurityPolicyController.prototype.getPolicy, SecurityPolicyController.prototype.updatePolicy]) {
      const permissions = reflector.get(REQUIRED_PERMISSIONS_KEY, handler);
      expect(permissions).toBeDefined();
      expect(permissions.length).toBeGreaterThan(0);
      expect(reflector.get(SKIP_AUTH_KEY, handler)).toBeFalsy();
    }
  });
});
