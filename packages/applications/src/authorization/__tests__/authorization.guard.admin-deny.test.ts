/**
 * Phase 0 Item 3 (TASK-302 Stream A) — AuthorizationGuard admin-deny pin.
 *
 * Asserts the inverted default: when @CanManage / @Authorize is missing
 * and the route path matches /^\/(api\/v\d+\/)?admin\//, the guard
 * throws ForbiddenException instead of silently allowing the request.
 * Non-admin paths keep the empty-list = allow legacy behaviour.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationGuard, SKIP_AUTH_KEY, REQUIRED_PERMISSIONS_KEY } from '../authorization.guard';

const buildContext = (url: string): ExecutionContext => {
  const handler = () => undefined;
  const cls = class Fake {};
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ url, method: 'POST', params: {} }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
};

describe('AuthorizationGuard — Phase 0 Item 3: deny by default on admin/*', () => {
  let reflector: Reflector;
  let cls: { get: (k: string) => unknown; set: () => void };
  const policyEngine = { buildAbility: vi.fn().mockResolvedValue({ can: () => true }) };

  beforeEach(() => {
    reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
      if (key === SKIP_AUTH_KEY) return false;
      if (key === REQUIRED_PERMISSIONS_KEY) return undefined;
      return undefined;
    });
    cls = { get: () => ({ id: 'u-1', tenantId: 't-1' }), set: () => undefined };
  });

  it('denies on /api/v1/admin/users when permissions are empty', async () => {
    const guard = new AuthorizationGuard(reflector, policyEngine as never, cls as never);
    await expect(guard.canActivate(buildContext('/api/v1/admin/users'))).rejects.toThrow(ForbiddenException);
  });

  it('denies on /admin/rbac/roles (no version prefix) when permissions are empty', async () => {
    const guard = new AuthorizationGuard(reflector, policyEngine as never, cls as never);
    await expect(guard.canActivate(buildContext('/admin/rbac/roles'))).rejects.toThrow(ForbiddenException);
  });

  it('allows on /api/v1/consultations when permissions are empty (non-admin)', async () => {
    const guard = new AuthorizationGuard(reflector, policyEngine as never, cls as never);
    await expect(guard.canActivate(buildContext('/api/v1/consultations'))).resolves.toBe(true);
  });
});
