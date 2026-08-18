/**
 * UnifiedAuthGuard + @ForbidApiKey() (TASK-708 Task 3 bucket (c)).
 *
 * `@ForbidApiKey()` is an UNCONDITIONAL deny for any API-key-authenticated
 * caller, independent of scopes — including a key holding the bare `'*'`
 * wildcard, which `@RequiredScopes` alone can never deny (§`API_KEY_FORBIDDEN`'s
 * doc comment on why a reserved-scope trick is unsafe against wildcard
 * grants). Mirrors `unified-auth.guard.required-scopes.test.ts`'s pattern:
 * a real decorator on a dummy handler, read back by a real `Reflector`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard } from '../unified-auth.guard';
import { ForbidApiKey, Authorize, RequiredScopes } from '../decorators';
import { PolicyEngine } from '../policy.engine';

class DummyImpersonationController {
  @Authorize(['manage', 'all'])
  @ForbidApiKey()
  impersonate() {}

  @Authorize(['read', 'User'])
  ordinaryRoute() {}

  /** Same controller, but an explicitly declared API-key surface (TASK-742). */
  @RequiredScopes('user:profile:read')
  scopedSibling() {}
}

const createMockContext = (handler: () => void) => {
  const request = { headers: {}, method: 'POST', url: '/api/v1/admin/users/u-1/impersonate', ip: '127.0.0.1', params: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => DummyImpersonationController,
  } as unknown as ExecutionContext;
};

const buildApiKey = (scopes: string[] | null) => ({
  id: 'key-1',
  keyName: 'test-key',
  tenantId: 'tenant-1',
  userId: 'user-1',
  scopes,
  rateLimit: 0,
  allowedIps: [],
});

describe('UnifiedAuthGuard + @ForbidApiKey()', () => {
  let guard: UnifiedAuthGuard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apiKeyService: any;
  let policyEngine: PolicyEngine;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clsService: any;

  beforeEach(() => {
    apiKeyService = {
      extractApiKeyFromRequest: () => 'raw-key-123',
      authenticateByRawKey: async () => buildApiKey(['*']),
      hasScope: () => true,
    };
    policyEngine = {} as PolicyEngine;
    clsService = { get: () => undefined, set: () => undefined };
    guard = new UnifiedAuthGuard(new Reflector(), apiKeyService, policyEngine, clsService, undefined, undefined);
  });

  it('403s an API key holding the bare "*" wildcard on a @ForbidApiKey() route', async () => {
    await expect(guard.canActivate(createMockContext(DummyImpersonationController.prototype.impersonate))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(createMockContext(DummyImpersonationController.prototype.impersonate))).rejects.toThrow(
      /does not accept API-key authentication/,
    );
  });

  it('403s even a key with every scope explicitly listed (not just the wildcard)', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['admin:*', 'consultation:*', 'stt:*']);

    await expect(guard.canActivate(createMockContext(DummyImpersonationController.prototype.impersonate))).rejects.toThrow(ForbiddenException);
  });

  /**
   * TASK-742 — this assertion CHANGED, and the product changed with it.
   *
   * `ordinaryRoute` carries `@Authorize(['read','User'])` and NO
   * `@RequiredScopes(...)`. It used to resolve `true` for any authenticated key,
   * which is exactly the fail-open defect: `@Authorize` was inert on the
   * API-key path, so the route had no authorization check at all. Under
   * deny-by-default it is refused — not by `@ForbidApiKey()` (which this file
   * is about) but by the absence of an API-key declaration.
   *
   * The property this test still guards is that the two denials are DISTINCT
   * mechanisms: `@ForbidApiKey()` denies even a scoped route, whereas this route
   * denies only because nothing was declared — grant it a scope and it opens
   * again, as `scopedSibling` proves. That distinction is what would be lost if
   * someone deleted `@ForbidApiKey()` believing deny-by-default subsumes it.
   */
  it('denies a route WITHOUT @ForbidApiKey() that also declares no scopes (deny-by-default, a different mechanism)', async () => {
    await expect(guard.canActivate(createMockContext(DummyImpersonationController.prototype.ordinaryRoute))).rejects.toThrow(ForbiddenException);
  });

  it('but a route that DECLARES a scope is reachable — proving the denial above is not @ForbidApiKey()', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['user:profile:read']);
    await expect(guard.canActivate(createMockContext(DummyImpersonationController.prototype.scopedSibling))).resolves.toBe(true);
  });
});
