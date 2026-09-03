/**
 * guard-level reachability evidence for verification criteria 2 and 3.
 *
 * `apps/api/src/bootstrap/__tests__/task-773-admin-plane-svc-declarations.test.ts`
 * proves the DECLARATIONS are right (every swept controller carries the correct
 * `@RequiredSvcScopes`/`@ForbidServiceAccount` metadata). This file proves the
 * complementary thing: that `UnifiedAuthGuard`, given those real declarations,
 * actually PRODUCES the right runtime verdict — reachable when scoped, refused
 * when not, and refused for a structurally different reason on the machine-closed
 * carve-outs.
 *
 * Harness pattern matched: `packages/applications/src/authorization/__tests__/
 * unified-auth.guard.service-account.test.ts` (mock `IApiKeyService`/`PolicyEngine`/
 * `ClsService`/`IServiceAccountAuthenticator`, drive `guard.canActivate(context)`
 * directly). Two changes from that file, both deliberate:
 *
 *  - `context.getClass()` returns REAL, SHIPPED controller classes
 *    (`DepartmentController`, `TenantController`, `WebhookController`,
 *    `ServiceAccountController`, `ConsultationController`) instead of a bare
 *    `{}`, and metadata is read with a REAL `Reflector()` (`new Reflector`,
 *    `@nestjs/core` — no DI container needed, it is just `Reflect.getMetadata`
 *    under the hood). So every `@RequiredSvcScopes(...)` / `@ForbidServiceAccount()`
 *    assertion below is evidence about the actual decorator on the actual class,
 *    not a metadata dict a test typed by hand.
 *  - `IServiceAccountAuthenticator.hasScope` is wired to the REAL
 *    `hasServiceAccountScope` (from the registry, `@arcaai/applications`) instead
 * of a bespoke matcher, so the wildcard-boundary assertion is evidence
 *    about the registry's actual prefix semantics, not a re-implementation of
 *    them that could silently diverge.
 *
 * `PolicyEngine.buildAbilityFromRules` and `IApiKeyService` stay mocked, exactly
 * as the matched harness does — CASL ability construction and the API-key branch
 * are out of scope here (covered by `service-account-scopes.registry.test.ts`
 * and the guard's own API-key suites, respectively).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ForbiddenException, Logger, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  UnifiedAuthGuard,
  SERVICE_ACCOUNT_TOKEN_HEADER,
  hasServiceAccountScope,
  serviceAccountPolicyRules,
  type IServiceAccountAuthenticator,
  type ServiceAccountPrincipalLike,
} from '@arcaai/applications';

// Real, shipped admin controllers — the A2 sweep's actual output.
import { DepartmentController } from '../department/department.controller'; // svc:admin:department:manage
import { TenantController } from '../tenant/tenant.controller'; // svc:admin:tenant:write (GET /admin/tenants lives here)
import { WebhookController } from '../webhook/webhook.controller'; // svc:webhook:event:write — the O-1 pre-convention family, NOT svc:admin:*
import { ServiceAccountController } from '../service-account/service-account.controller'; // D-3 machine-closed carve-out
// A real BUSINESS-plane controller that declares no svc:* scope at all (only
// the API-key `@RequiredScopes`) and no `@ForbidServiceAccount()` — the
// deny-by-default case, verified against a route nobody had to decorate for
// this ticket to prove the guard's default posture.
import { ConsultationController } from '../consultation/consultation.controller';

/**
 * `This route does not accept service-account authentication` —
 * `SERVICE_ACCOUNT_ROUTE_DENIED_MESSAGE` in `unified-auth.guard.ts`. Not
 * exported (deliberately identical wording for both denial reasons, per that
 * file's own doc comment), so it is pinned here as a literal. Any drift in the
 * production string will fail this suite rather than go unnoticed.
 */
const MACHINE_CLOSED_MESSAGE = 'This route does not accept service-account authentication';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function principal(overrides: Partial<ServiceAccountPrincipalLike> = {}): ServiceAccountPrincipalLike {
  return {
    id: 'sa-1',
    clientId: 'hope_svc_x',
    tenantId: TENANT_A,
    workingTenantId: TENANT_A,
    scopes: ['svc:admin:department:manage'],
    roles: [],
    allowedTenantIds: null,
    ...overrides,
  };
}

describe('admin-plane guard-level reachability (real controllers, real Reflector)', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let apiKeyService: { extractApiKeyFromRequest: ReturnType<typeof vi.fn>; authenticateByRawKey: ReturnType<typeof vi.fn>; hasScope: ReturnType<typeof vi.fn> };
  let policyEngine: { buildAbility: ReturnType<typeof vi.fn>; buildAbilityFromRules: ReturnType<typeof vi.fn> };
  let clsService: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let serviceAccounts: IServiceAccountAuthenticator & { authenticateByToken: ReturnType<typeof vi.fn> };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reflector = new Reflector();
    apiKeyService = { extractApiKeyFromRequest: vi.fn(() => null), authenticateByRawKey: vi.fn(), hasScope: vi.fn() };
    // Real ability check off the REAL derivation of a service account's scope
    // set (`serviceAccountPolicyRules`), so a wildcard's ability grant is
    // evidence about the registry, not a hand-typed stand-in for it.
    policyEngine = {
      buildAbility: vi.fn(),
      buildAbilityFromRules: vi.fn((rules: Array<{ action: string; subject: string }>) => ({
        can: (action: string, subject: string) => rules.some((r) => r.action === action && r.subject === subject),
        cannot: () => false,
        relevantRuleFor: () => undefined,
      })),
    };
    clsService = { get: vi.fn(() => undefined), set: vi.fn() };
    serviceAccounts = {
      authenticateByToken: vi.fn(async () => principal()),
      // The REAL registry matcher — the only thing under test in the wildcard
      // assertion is whether `svc:admin:*` reaches `svc:admin:department:manage`
      // and NOT `svc:webhook:event:write`, and that answer must come from
      // production code, not a re-implementation of it.
      hasScope: (p, required) => hasServiceAccountScope(p.scopes, required),
    };
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    guard = new UnifiedAuthGuard(
      reflector,
      apiKeyService as never,
      policyEngine as never,
      clsService as never,
      undefined,
      undefined,
      serviceAccounts,
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * Builds a real-shaped `ExecutionContext`: `getClass()` returns the actual
   * shipped controller class, so `reflector.getAllAndOverride` reads exactly
   * the metadata `UnifiedAuthGuard` reads at request time. `getHandler()`
   * defaults to a bare, undecorated function (none of the routes exercised
   * here carry method-level overrides of `@RequiredSvcScopes`/
   * `@ForbidServiceAccount`/`@CanXxx` — all five are class-level declarations),
   * so the class-level metadata is what decides every case.
   */
  function makeContext(targetClass: Function, handler: Function = function unadornedHandler() {}): ExecutionContext {
    const request = { headers: { [SERVICE_ACCOUNT_TOKEN_HEADER]: 'opaque-token' }, method: 'GET', url: '/api/v1/admin/x', ip: '127.0.0.1', params: {} };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => targetClass,
    } as unknown as ExecutionContext;
  }

  // ── 1. Positive ──────────────────────────────────────────────────────────

  describe('1. positive — holding the declared scope reaches the route', () => {
    it('a principal holding svc:admin:department:manage reaches DepartmentController (admin/departments)', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:department:manage'] }));
      await expect(guard.canActivate(makeContext(DepartmentController))).resolves.toBe(true);
    });

    it('GET /api/v1/admin/tenants is reachable by EITHER half of the scope pair (O-4)', async () => {
      // History, because this test previously asserted the opposite. Verification
      // criterion 2 named `svc:admin:tenant:read` for this route, and when A6 was
      // written NO controller declared that string: `TenantController` carried one
      // class-level `svc:admin:tenant:write` covering reads and writes alike, so a
      // `:read`-only principal was REFUSED here. That gap became O-3/O-4.
      //
      // O-4 closed it. The read routes now declare the PAIR at method level, so
      // both halves reach them — the pair rather than `:read` alone precisely so
      // this assertion's `:write` case keeps passing, since
      // `enforceServiceAccountScopes` is `required.some(...)` and a lone `:read`
      // would have revoked the route from every existing `:write` grant.
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:tenant:write'] }));
      await expect(guard.canActivate(makeContext(TenantController, TenantController.prototype.fetchAll))).resolves.toBe(true);

      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:tenant:read'] }));
      await expect(guard.canActivate(makeContext(TenantController, TenantController.prototype.fetchAll))).resolves.toBe(true);
    });

    it('a WRITE route still demands the write half — :read does not widen into mutation', async () => {
      // The other side of O-4, and the reason the pair is method-level only: a
      // read-only grant must not reach a mutation. `delete` carries no method-level
      // svc declaration, so it inherits the class-level `svc:admin:tenant:write`.
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:tenant:read'] }));
      await expect(guard.canActivate(makeContext(TenantController, TenantController.prototype.delete))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── 2. Negative (scope) ──────────────────────────────────────────────────

  describe('2. negative — a DIFFERENT valid scope is refused, and the refusal is a scope denial', () => {
    it('a principal holding svc:admin:tenant:write (a real, valid scope) is refused on admin/departments', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:tenant:write'] }));
      const outcome = guard.canActivate(makeContext(DepartmentController));

      await expect(outcome).rejects.toBeInstanceOf(ForbiddenException);
      // Never an authentication failure — the token itself was fine.
      await expect(outcome.catch((e) => e)).resolves.not.toBeInstanceOf(UnauthorizedException);
    });

    it('the refusal message names it as a scope shortfall, distinct from the generic route-denied wording', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:tenant:write'] }));
      await expect(guard.canActivate(makeContext(DepartmentController))).rejects.toThrow(
        'Service account does not have required scope(s): svc:admin:department:manage',
      );
      const call = warnSpy.mock.calls.find((c) => (c[0] as Record<string, unknown>)?.message === 'Service account scope insufficient');
      expect(call).toBeDefined();
      expect((call?.[0] as Record<string, unknown>)?.requiredScopes).toEqual(['svc:admin:department:manage']);
      expect((call?.[0] as Record<string, unknown>)?.heldScopes).toEqual(['svc:admin:tenant:write']);
    });
  });

  // ── 3. Wildcard — svc:admin:* reaches admin areas, NOT svc:webhook:event:write ──

  describe('3. wildcard — svc:admin:* expands over the admin PREFIX, not "the admin plane"', () => {
    it('svc:admin:* reaches an svc:admin:<area> route (DepartmentController)', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:*'] }));
      await expect(guard.canActivate(makeContext(DepartmentController))).resolves.toBe(true);
    });

    it('the SAME svc:admin:* principal does NOT reach svc:webhook:event:write (WebhookController, admin/webhooks) — O-1', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:*'] }));
      const outcome = guard.canActivate(makeContext(WebhookController));

      await expect(outcome).rejects.toBeInstanceOf(ForbiddenException);
      await expect(outcome.catch((e) => e)).resolves.toMatchObject({
        message: expect.stringContaining('svc:webhook:event:write'),
      });
      // A scope denial, not the machine-closed denial — WebhookController is a
      // wired svc: surface, just not one `svc:admin:*` happens to cover.
      await expect(outcome.catch((e) => e)).resolves.not.toMatchObject({ message: MACHINE_CLOSED_MESSAGE });
    });

    it('the platform-broad svc:* DOES reach svc:webhook:event:write — confirms the boundary is admin-prefix-specific, not webhook-specific', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:*'] }));
      await expect(guard.canActivate(makeContext(WebhookController))).resolves.toBe(true);
    });
  });

  // ── 4. Machine-closed — a FORBIDDEN-class denial, not a scope denial ────────

  describe('4. machine-closed — @ForbidServiceAccount() refuses even svc:*, and it is a DIFFERENT denial than a scope shortfall', () => {
    it('a principal holding svc:* (broadest possible) is still refused on ServiceAccountController (admin/service-accounts)', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:*'] }));
      const outcome = guard.canActivate(makeContext(ServiceAccountController));

      await expect(outcome).rejects.toBeInstanceOf(ForbiddenException);
      await expect(outcome.catch((e) => e)).resolves.toMatchObject({ message: MACHINE_CLOSED_MESSAGE });
    });

    it('the FORBIDDEN check runs BEFORE the token is even validated — structurally different from a scope check', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:*'] }));
      await expect(guard.canActivate(makeContext(ServiceAccountController))).rejects.toBeInstanceOf(ForbiddenException);

      // `handleServiceAccountAuth` checks `@ForbidServiceAccount()` BEFORE
      // calling `authenticateByToken` — a forbidden route has no principal
      // that could rescue it. A scope denial (test 2/3), by contrast, can only
      // be reached AFTER a principal was authenticated.
      expect(serviceAccounts.authenticateByToken).not.toHaveBeenCalled();

      const call = warnSpy.mock.calls.find((c) => (c[0] as Record<string, unknown>)?.reason === 'forbid_service_account');
      expect(call).toBeDefined();
      expect((call?.[0] as Record<string, unknown>)?.message).toBe('Service account denied');
    });

    it('the machine-closed message is IDENTICAL for @ForbidServiceAccount() regardless of held scope, and DIFFERS from a scope-shortfall message', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:department:manage'] }));
      const narrowScopeOutcome = guard.canActivate(makeContext(ServiceAccountController));
      await expect(narrowScopeOutcome.catch((e) => e)).resolves.toMatchObject({ message: MACHINE_CLOSED_MESSAGE });

      // Contrast: DepartmentController's scope denial (test 2) carries a
      // DIFFERENT message shape ("does not have required scope(s): ..."). The
      // two denials must never be confusable by their wording.
      expect(MACHINE_CLOSED_MESSAGE).not.toContain('does not have required scope');
    });
  });

  // ── 5. Deny-by-default — a business-plane route with no svc:* declaration ───

  describe('5. deny-by-default — a route declaring no svc:* scope refuses every service account, regardless of scopes held', () => {
    it('ConsultationController (business plane, only @RequiredScopes for API keys, no svc:* declaration) refuses svc:* — the broadest possible grant', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:*'] }));
      const outcome = guard.canActivate(makeContext(ConsultationController, ConsultationController.prototype.list));

      await expect(outcome).rejects.toBeInstanceOf(ForbiddenException);
      await expect(outcome.catch((e) => e)).resolves.toMatchObject({ message: MACHINE_CLOSED_MESSAGE });

      // Distinguishable from the carve-out by the SERVER-SIDE log reason,
      // even though the client-facing message is deliberately identical (see
      // `SERVICE_ACCOUNT_ROUTE_DENIED_MESSAGE`'s doc comment: a caller must not
      // be able to probe "deliberately closed" vs "simply undeclared").
      const call = warnSpy.mock.calls.find((c) => (c[0] as Record<string, unknown>)?.reason === 'no_svc_scopes_declared');
      expect(call).toBeDefined();
      // Unlike a scope carve-out, the token WAS authenticated first — the route is simply
      // not a service-account surface at all, not a deliberate carve-out.
      expect(serviceAccounts.authenticateByToken).toHaveBeenCalled();
    });

    it('also refuses a principal holding a real, valid svc:admin:* wildcard — no admin grant reaches an undeclared business route', async () => {
      serviceAccounts.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:*'] }));
      await expect(guard.canActivate(makeContext(ConsultationController, ConsultationController.prototype.list))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── Sanity: the ability half still composes as a conjunction on a real route ──

  it('sanity: DepartmentController is gated as a conjunction — the derived ability for svc:admin:department:manage really does grant manage:Department', () => {
    // Not a guard.canActivate() case — a direct check that the registry
    // function the guard calls (`serviceAccountPolicyRules`) produces an
    // ability that actually satisfies DepartmentController's class-level
    // `@CanManage('Department')`, so test 1's 200 is not an artifact of the
    // mocked ability builder ignoring its input.
    const rules = serviceAccountPolicyRules(['svc:admin:department:manage']);
    expect(rules).toContainEqual({ action: 'manage', subject: 'Department' });
  });
});
