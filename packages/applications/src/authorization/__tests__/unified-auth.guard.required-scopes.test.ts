/**
 * UnifiedAuthGuard + @RequiredScopes — regression.
 *
 * G1 (docs/implementation/TASK-632-HOPE-Node-SDK/README.md): `API_KEY_SCOPE_REGISTRY`
 * and `enforceApiKeyScopes` both existed, but no decorator ever SET
 * `API_KEY_REQUIRED_SCOPES` metadata, so `requiredScopes` was always
 * `undefined` and any valid API key reached every route RBAC permitted.
 *
 * Unlike `unified-auth.guard.test.ts` (which mocks `Reflector` entirely to
 * unit-test the guard's branching in isolation), this file applies the REAL
 * `@RequiredScopes` decorator to a dummy handler and reads it back with a
 * REAL `Reflector`, so it proves the decorator's metadata actually reaches
 * `enforceApiKeyScopes` the way it will in a real controller — not just that
 * the guard behaves correctly when told (via a mock) what the metadata is.
 *
 * `apiKeyService.hasScope` is wired to the REAL `ApiKeyService.prototype.hasScope`
 * (not a re-implemented test double) so the scope-matching semantics
 * asserted below are the production semantics, not an assumption about them.
 * `hasScope` reads no instance state, so calling the prototype method
 * without constructing the full DI graph is safe and behavior-identical.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard } from '../unified-auth.guard';
import { RequiredScopes } from '../decorators';
import { PolicyEngine } from '../policy.engine';
import { ApiKeyService } from '../../services/apiKey/apikey.service';

class DummyTextCompatController {
  @RequiredScopes('consultation:report:write')
  summarySync() {}
}

const createMockContext = () => {
  const request = { headers: {}, method: 'POST', url: '/api/smr/api/v1/summary/sync', ip: '127.0.0.1', params: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => DummyTextCompatController.prototype.summarySync,
    getClass: () => DummyTextCompatController,
  } as unknown as ExecutionContext;
};

const buildApiKey = (scopes: string[] | null) => ({
  id: 'key-1',
  keyName: 'sdk-key',
  tenantId: 'tenant-1',
  userId: 'user-1',
  scopes,
  rateLimit: 0,
  allowedIps: [],
});

describe('UnifiedAuthGuard + @RequiredScopes', () => {
  let guard: UnifiedAuthGuard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apiKeyService: any;
  let policyEngine: PolicyEngine;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clsService: any;

  beforeEach(() => {
    apiKeyService = {
      extractApiKeyFromRequest: () => 'raw-key-123',
      authenticateByRawKey: async () => buildApiKey(null),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hasScope: (key: any, scope: string) => ApiKeyService.prototype.hasScope(key, scope),
    };
    policyEngine = {} as PolicyEngine;
    clsService = { get: () => undefined, set: () => undefined };
    guard = new UnifiedAuthGuard(new Reflector(), apiKeyService, policyEngine, clsService, undefined, undefined);
  });

  it('403s an API key that lacks the required scope', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['consultation:report:read']);

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(createMockContext())).rejects.toThrow(/consultation:report:write/);
  });

  it('403s a key with no scopes at all (deny by default)', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(null);

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
  });

  it('passes an API key that holds the exact required scope', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['consultation:report:write']);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
  });

  it('passes an API key holding the bare "*" superadmin wildcard scope', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['*']);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
  });

  // `API_KEY_SCOPE_REGISTRY` lists "consultation:*" as a valid, assignable "full
  // consultation access" scope, so the console issues keys carrying it. Until
  // , `ApiKeyService.hasScope` only treated a BARE parent ("consultation",
  // no ":*") as a prefix grant — `requiredScope.startsWith(`${scope}:`)` never matches
  // when `scope` itself contains a literal "*" — so such a key gained nothing.
  //
  // That was inert while NO route declared `@RequiredScopes`. Turning enforcement on
  // in this same ticket would have converted it into a live 403 for every key the UI
  // described as granting full access, so `hasScope` now handles the `:*` form and
  // this asserts the end-to-end grant through the guard.
  it('passes an API key holding the "consultation:*" category wildcard', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['consultation:*']);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
  });

  it('rejects a category wildcard from a DIFFERENT category', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['stt:*']);

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
  });
});
