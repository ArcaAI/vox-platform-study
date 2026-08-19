/**
 * TASK-712 Phase 5 Task 15b — SubjectInstanceResolver dependency access.
 *
 * Task 14 gave `@ResolveSubjectInstance(...)` the raw request and nothing
 * else, so a resolver could build an instance from `params`/`body` but could
 * not LOAD A ROW. Every identity-shaped hazard in `casl-blast-radius.md` §4
 * (`userId`, `doctorId`, `targetUserId`, `createdBy`, `isSystemRole`) needs
 * the row, so shadow mode could not be wired to a single real route and
 * `casl_shadow_divergence_total` could never move.
 *
 * This suite pins the contract that unblocks it: the resolver receives a
 * SECOND argument — a `SubjectResolverContext` backed by Nest's `ModuleRef` —
 * whose `get(token)` resolves a provider from anywhere in the container.
 *
 * The three fail-open paths of Task 14 are UNCHANGED and re-pinned here,
 * because DI adds two new ways to fail (no container wired; a token that does
 * not resolve) and neither may ever become an outage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyEngine, AppAbility } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { UnifiedAuthGuard, SUBJECT_INSTANCE_RESOLVER_KEY, SubjectResolverContext } from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';

const createMockAbility = (permissions: Record<string, boolean>): AppAbility =>
  ({
    can: vi.fn((action: string, subject: string) => permissions[`${action}:${subject}`] ?? false),
    cannot: vi.fn(),
    relevantRuleFor: vi.fn(),
  }) as unknown as AppAbility;

const createMockContext = (overrides: Record<string, unknown> = {}) => {
  const request = { headers: {}, method: 'GET', url: '/admin/api-keys/k-1', ip: '127.0.0.1', params: { id: 'k-1' }, ...overrides };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
};

const FAKE_TOKEN = Symbol('IFakeService');

describe('SubjectInstanceResolver — dependency access (Task 15b)', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let policyEngine: PolicyEngine;
  let metadata: Record<string, unknown>;
  let moduleRef: { get: ReturnType<typeof vi.fn> };
  const fakeService = { fetchById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', userId: 'jwt-user-1' }) };

  const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

  const build = (withModuleRef: boolean) => {
    const apiKeyService = {
      extractApiKeyFromRequest: vi.fn().mockReturnValue(null),
      authenticateByRawKey: vi.fn(),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as IApiKeyService;
    const cls = { get: vi.fn((key: string) => (key === 'user' ? mockUser : undefined)), set: vi.fn() };
    return new UnifiedAuthGuard(
      reflector,
      apiKeyService,
      policyEngine,
      cls as any,
      undefined,
      { canActivate: vi.fn().mockResolvedValue(true) },
      undefined,
      withModuleRef ? (moduleRef as any) : undefined,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};
    reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) } as unknown as Reflector;
    policyEngine = {
      buildAbility: vi.fn().mockResolvedValue(createMockAbility({ 'read:ApiKey': true })),
      evaluateShadowVerdict: vi.fn().mockReturnValue({ typeVerdict: true, instanceVerdict: true, diverged: false }),
      recordShadowDivergence: vi.fn(),
      recordEnforceDenial: vi.fn(),
      isEnforcedPair: vi.fn().mockReturnValue(false),
    } as unknown as PolicyEngine;
    moduleRef = { get: vi.fn().mockReturnValue(fakeService) };
    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'read', subject: 'ApiKey' }];
    metadata[PERMISSION_MODE_KEY] = 'AND';
    guard = build(true);
  });

  it('passes a resolver context as the SECOND argument, and its get() resolves non-strictly from the container', async () => {
    const resolver = vi.fn(async (request: any, ctx: SubjectResolverContext) => {
      const svc = ctx.get<typeof fakeService>(FAKE_TOKEN);
      return await svc.fetchById(request.params.id);
    });
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = resolver;

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);

    expect(resolver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ get: expect.any(Function) }));
    // Non-strict is load-bearing: the guard is provided in the root module,
    // while the services a resolver wants live in feature modules.
    expect(moduleRef.get).toHaveBeenCalledWith(FAKE_TOKEN, { strict: false });
  });

  it('feeds the LOADED row into the verdict — the whole point of giving the resolver DI', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = async (request: any, ctx: SubjectResolverContext) =>
      await ctx.get<typeof fakeService>(FAKE_TOKEN).fetchById(request.params.id);

    await guard.canActivate(createMockContext());

    expect(policyEngine.evaluateShadowVerdict).toHaveBeenCalledWith(expect.anything(), 'read', 'ApiKey', {
      tenantId: 'tenant-1',
      userId: 'jwt-user-1',
    });
  });

  it('FAIL-OPEN: no container wired ⇒ ctx.get throws, and the request is completely unaffected', async () => {
    guard = build(false);
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = (_request: any, ctx: SubjectResolverContext) => ctx.get(FAKE_TOKEN);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(policyEngine.evaluateShadowVerdict).not.toHaveBeenCalled();
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: a token that does not resolve ⇒ swallowed, no denial, no divergence', async () => {
    moduleRef.get.mockImplementation(() => {
      throw new Error('Nest could not find IFakeService');
    });
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = (_request: any, ctx: SubjectResolverContext) => ctx.get(FAKE_TOKEN);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(policyEngine.recordShadowDivergence).not.toHaveBeenCalled();
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });
});
