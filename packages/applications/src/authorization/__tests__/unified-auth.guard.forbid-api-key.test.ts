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
import { ForbidApiKey, Authorize } from '../decorators';
import { PolicyEngine } from '../policy.engine';

class DummyImpersonationController {
  @Authorize(['manage', 'all'])
  @ForbidApiKey()
  impersonate() {}

  @Authorize(['read', 'User'])
  ordinaryRoute() {}
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

  it('leaves a route WITHOUT @ForbidApiKey() unaffected', async () => {
    await expect(guard.canActivate(createMockContext(DummyImpersonationController.prototype.ordinaryRoute))).resolves.toBe(true);
  });
});
