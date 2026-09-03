/**
 * the API-key authorization path must FAIL CLOSED.
 *
 * Before this ticket, `UnifiedAuthGuard.handleApiKeyAuth` authenticated the key
 * and `return true`d. `enforceApiKeyScopes` returned EARLY (permitting) whenever
 * a route declared no `@RequiredScopes`, and CASL was evaluated only inside
 * `handleJwtPostAuth`, which an API-key caller never reaches. Net effect: for
 * every route without explicit scopes, an API key bearing ANY trivial scope
 * passed with NO authorization check at all, and `@Authorize(...)` /
 * `@CanManage(...)` were inert for API-key callers.
 *
 * The two rules this file pins:
 *
 *   1. DENY BY DEFAULT — an API key may reach a route only if that route
 *      explicitly declares what an API key may do (`@RequiredScopes`).
 *      Absence is a denial, never a permit. `@ForbidApiKey()` remains the
 *      explicit "never" marker.
 *   2. SCOPES *AND* ABILITIES — a declared scope is necessary but not
 *      sufficient. The same CASL permissions the JWT path enforces are also
 *      enforced for the key's bound principal. A credential may never exceed
 *      the user it is bound to.
 *
 * The JWT path is untouched by both rules.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard } from '../unified-auth.guard';
import { Authorize, RequiredScopes, ForbidApiKey, Public } from '../decorators';
import { PolicyEngine } from '../policy.engine';

class DummyController {
  /** The defect's shape: a permission decorator, but no API-key declaration. */
  @Authorize(['manage', 'Tenant'])
  unscopedButAuthorized() {}

  /** Bare `@Authorize()` — authentication-only, no permission, no scopes. */
  @Authorize()
  bareAuthorizeNoScopes() {}

  /** Explicitly declared API-key surface. */
  @Authorize(['create', 'Summary'])
  @RequiredScopes('consultation:report:write')
  scopedAndAuthorized() {}

  /** Declared API-key surface with no CASL permission of its own. */
  @Authorize()
  @RequiredScopes('stt:transcription:read')
  scopedOnly() {}

  /** Explicit never. */
  @Authorize(['manage', 'all'])
  @ForbidApiKey()
  forbidden() {}

  @Public()
  publicRoute() {}
}

const createMockContext = (handler: () => void, extra: Record<string, unknown> = {}) => {
  const request = {
    headers: {},
    method: 'POST',
    url: '/api/v1/some/route',
    ip: '127.0.0.1',
    params: {},
    ...extra,
  } as Record<string, unknown>;
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => DummyController,
    } as unknown as ExecutionContext,
  };
};

const buildApiKey = (overrides: Record<string, unknown> = {}) => ({
  id: 'key-1',
  keyName: 'test-key',
  tenantId: 'tenant-1',
  userId: 'user-1',
  scopes: ['consultation:report:write', 'stt:transcription:read'],
  rateLimit: 0,
  allowedIps: [],
  ...overrides,
});

describe('UnifiedAuthGuard — API-key path fails closed ', () => {
  let guard: UnifiedAuthGuard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-rolled service doubles; matches this folder's existing test style.
  let apiKeyService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let policyEngine: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clsService: any;
  let ability: { can: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ability = { can: vi.fn().mockReturnValue(true) };
    apiKeyService = {
      extractApiKeyFromRequest: () => 'raw-key-123',
      authenticateByRawKey: vi.fn(async () => buildApiKey()),
      hasScope: (key: { scopes: string[] | null }, scope: string) => (key.scopes ?? []).includes(scope) || (key.scopes ?? []).includes('*'),
    };
    policyEngine = { buildAbility: vi.fn(async () => ability) };
    clsService = { get: vi.fn(() => undefined), set: vi.fn() };
    guard = new UnifiedAuthGuard(new Reflector(), apiKeyService, policyEngine, clsService, undefined, undefined);
  });

  // ─── Rule 1: deny by default ──────────────────────────────────────────

  it('(a) DENIES an API key on a route that declares no @RequiredScopes', async () => {
    const { ctx } = createMockContext(DummyController.prototype.unscopedButAuthorized);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/does not accept API-key authentication/);
  });

  it('(a2) DENIES even a `*`-wildcard key on a route that declares no @RequiredScopes', async () => {
    apiKeyService.authenticateByRawKey = vi.fn(async () => buildApiKey({ scopes: ['*'] }));
    const { ctx } = createMockContext(DummyController.prototype.unscopedButAuthorized);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('(a3) DENIES on a bare @Authorize() route (auth-only, no permission, no scopes)', async () => {
    const { ctx } = createMockContext(DummyController.prototype.bareAuthorizeNoScopes);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ─── Rule 1 (positive): an explicitly declared surface still works ─────

  it('(b) PERMITS a key holding the declared scope when its principal also holds the ability', async () => {
    const { ctx } = createMockContext(DummyController.prototype.scopedAndAuthorized);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('(b2) still 403s a key MISSING the declared scope, with the scope-denial message', async () => {
    apiKeyService.authenticateByRawKey = vi.fn(async () => buildApiKey({ scopes: ['user:profile:read'] }));
    const { ctx } = createMockContext(DummyController.prototype.scopedAndAuthorized);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/does not have required scope/);
  });

  it('(b3) PERMITS a scoped route that declares no CASL permission (scope is the whole gate there)', async () => {
    const { ctx } = createMockContext(DummyController.prototype.scopedOnly);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(policyEngine.buildAbility).not.toHaveBeenCalled();
  });

  // ─── Rule 2: scopes AND abilities ──────────────────────────────────────

  it('(e) DENIES a correctly-scoped key whose bound principal lacks the CASL ability', async () => {
    ability.can = vi.fn().mockReturnValue(false);
    const { ctx } = createMockContext(DummyController.prototype.scopedAndAuthorized);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/Missing permissions/);
  });

  it('(e2) builds the ability for the KEY’s bound user and tenant', async () => {
    const { ctx } = createMockContext(DummyController.prototype.scopedAndAuthorized);
    await guard.canActivate(ctx);
    expect(policyEngine.buildAbility).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1' }));
  });

  it('(g) DENIES a key with NO bound user on a route that declares a CASL permission', async () => {
    apiKeyService.authenticateByRawKey = vi.fn(async () => buildApiKey({ userId: null }));
    const { ctx } = createMockContext(DummyController.prototype.scopedAndAuthorized);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/not linked to a user/);
  });

  it('(h) does NOT publish the ability to CLS or the request on the API-key path', async () => {
    const { ctx, request } = createMockContext(DummyController.prototype.scopedAndAuthorized);
    await guard.canActivate(ctx);
    expect(request.ability).toBeUndefined();
    expect(clsService.set).not.toHaveBeenCalledWith('userAbility', expect.anything());
  });

  // ─── Rule 1: the explicit "never" marker still wins ────────────────────

  it('(c) @ForbidApiKey() still denies, and with its own message (not the deny-by-default one)', async () => {
    apiKeyService.authenticateByRawKey = vi.fn(async () => buildApiKey({ scopes: ['*'] }));
    const { ctx } = createMockContext(DummyController.prototype.forbidden);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/does not accept API-key authentication/);
  });

  it('(c2) a @Public() route is still reachable — auth never runs', async () => {
    const { ctx } = createMockContext(DummyController.prototype.publicRoute);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(apiKeyService.authenticateByRawKey).not.toHaveBeenCalled();
  });
});

// ─── Rule: the JWT path is completely unaffected ────────────────────────

describe('UnifiedAuthGuard — JWT path unaffected by the API-key deny-by-default rule ', () => {
  let guard: UnifiedAuthGuard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clsService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let policyEngine: any;
  let ability: { can: ReturnType<typeof vi.fn> };

  const jwtContext = (handler: () => void) => {
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer jwt-token' },
      method: 'POST',
      url: '/api/v1/some/route',
      ip: '127.0.0.1',
      params: {},
      user: { id: 'user-9', tenantId: 'tenant-1' },
    };
    return {
      request,
      ctx: {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => DummyController,
      } as unknown as ExecutionContext,
    };
  };

  beforeEach(() => {
    ability = { can: vi.fn().mockReturnValue(true) };
    policyEngine = { buildAbility: vi.fn(async () => ability), evaluateShadowVerdict: vi.fn(), recordShadowDivergence: vi.fn() };
    clsService = { get: vi.fn(() => undefined), set: vi.fn() };
    guard = new UnifiedAuthGuard(
      new Reflector(),
      // no API key on the request — extract returns null
      { extractApiKeyFromRequest: () => null, authenticateByRawKey: vi.fn(), hasScope: () => false },
      policyEngine,
      clsService,
      undefined,
      { canActivate: async () => true },
    );
  });

  it('(d) a JWT caller reaches a route that declares NO @RequiredScopes', async () => {
    const { ctx } = jwtContext(DummyController.prototype.unscopedButAuthorized);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('(d2) a JWT caller is unaffected by @ForbidApiKey()', async () => {
    const { ctx } = jwtContext(DummyController.prototype.forbidden);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('(d3) the JWT path still publishes the ability to CLS and the request', async () => {
    const { ctx, request } = jwtContext(DummyController.prototype.unscopedButAuthorized);
    await guard.canActivate(ctx);
    expect(request.ability).toBe(ability);
    expect(clsService.set).toHaveBeenCalledWith('userAbility', ability);
  });
});
