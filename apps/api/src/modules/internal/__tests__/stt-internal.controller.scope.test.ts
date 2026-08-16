/**
 * SttInternalController — API-key scope gap closure.
 *
 * Before this change the class carried only a bare `@Authorize()` (any
 * authenticated principal) and no `@RequiredScopes`, so
 * `UnifiedAuthGuard.enforceApiKeyScopes` saw no `API_KEY_REQUIRED_SCOPES`
 * metadata and skipped the scope check entirely — per the class's own
 * (now-updated) AUTH-NOTE, ANY active API key, including an ordinary
 * tenant's own SDK key, reached every `/api/v1/internal/stt/*` route.
 *
 * This proves the class-level `@RequiredScopes('internal:stt:worker')` gate
 * closes that: a tenant-shaped SDK key (the STT/consultation self-service
 * scopes every seeded SDK key carries — see
 * `packages/database/src/prisma/db_main/seed/02-apikey.ts`) is now 403'd,
 * while the platform SERVICE_ACCOUNT credential (scopes: `['*']`, the STT
 * worker's actual credential — see
 * `packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`
 * on `API_GATEWAY_KEY` and `seed/02-apikey.ts`'s `SERVICE_ACCOUNT` row) is
 * unaffected.
 *
 * Follows the same real-decorator + real-Reflector pattern as
 * `packages/applications/src/authorization/__tests__/unified-auth.guard.required-scopes.test.ts`,
 * but exercises the REAL `SttInternalController` class rather than a dummy
 * stand-in, so it proves the metadata that ships on the actual controller —
 * not just that the guard behaves correctly when told (via a dummy) what the
 * metadata is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard, PolicyEngine } from '@arcaai/applications';
import { SttInternalController } from '../stt-internal.controller';

const createMockContext = () => {
  const request = { headers: {}, method: 'PATCH', url: '/api/v1/internal/stt/jobs/job-1/start', ip: '127.0.0.1', params: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => SttInternalController.prototype.startJob,
    getClass: () => SttInternalController,
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

/**
 * Exact-match / bare-`*`-wildcard semantics only. The fuller prefix/category-
 * wildcard matrix (e.g. `"consultation:*"` grants `"consultation:report:write"`)
 * is already covered against the REAL `ApiKeyService.hasScope` in
 * `unified-auth.guard.required-scopes.test.ts`; this file only needs to prove
 * grant/deny for the two credential shapes that actually reach this
 * controller (a tenant SDK key's flat scope list, and the platform key's
 * bare `["*"]`), so a minimal stand-in is sufficient and keeps this test
 * independent of `@arcaai/applications`'s internal (non-barrel-exported)
 * `ApiKeyService` class.
 */
const hasScope = (apiKey: { scopes: string[] | null }, required: string): boolean => {
  const scopes = apiKey.scopes;
  if (!scopes || scopes.length === 0) return false;
  if (scopes.includes('*')) return true;
  return scopes.includes(required);
};

describe('SttInternalController + @RequiredScopes (gap closure)', () => {
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
      hasScope,
    };
    policyEngine = {} as PolicyEngine;
    clsService = { get: () => undefined, set: () => undefined };
    guard = new UnifiedAuthGuard(new Reflector(), apiKeyService, policyEngine, clsService, undefined, undefined);
  });

  it('403s an ordinary tenant SDK key (STT/consultation self-service scopes, no internal scope)', async () => {
    apiKeyService.authenticateByRawKey = async () =>
      buildApiKey(['stt:transcription:read', 'stt:transcription:write', 'stt:stream:write', 'consultation:session:read', 'consultation:session:write']);

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(createMockContext())).rejects.toThrow(/internal:stt:worker/);
  });

  it('403s a key with no scopes at all (deny by default)', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(null);

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
  });

  it('passes the platform SERVICE_ACCOUNT credential (scopes: ["*"]) — the STT worker is unaffected', async () => {
    apiKeyService.authenticateByRawKey = async () => buildApiKey(['*']);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
  });
});
