/**
 * the two halves left as prose.
 *
 * 1. **OR mode.** `runCaslInstanceChecks` applied ONE route-level resolver to
 *    EVERY required permission and never consulted `PERMISSION_MODE_KEY`. On a
 *    `@CanAny` route that means: the type-only verdict allows via alternative
 *    B, the enforced denial from alternative A is then applied, and the route's
 * declared OR semantics silently become AND. disclosed this as a
 *    limitation; here it becomes behaviour.
 * 2. **Subject mismatch.** With two required permissions and one resolver, the
 *    instance shaped for subject X was evaluated against subject Y's
 *    conditions, where a spurious `false` becomes a wrongful 403. A resolver
 *    may now declare the subject it resolves; enforcement applies to that
 *    subject only.
 *
 * Plus the honesty proof this ticket exists for: when a denial IS applied,
 * `casl_enforce_denial_total` actually moves. The counter is exercised through
 * a REAL `PolicyEngine.recordEnforceDenial` (not a spy), so this suite fails
 * if the metric is ever renamed, unlabelled, or detached from the registry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { register } from 'prom-client';
import { PolicyEngine, AppAbility, CASL_ENFORCE_DENIAL_METRIC } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { UnifiedAuthGuard, SUBJECT_INSTANCE_RESOLVER_KEY, ResolveSubjectInstance } from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';

const TEST_ENFORCED_PAIRS = new Set(['update:UserVoiceProfile', 'read:Consultation']);

const createMockAbility = (permissions: Record<string, boolean>): AppAbility =>
  ({
    can: vi.fn((action: string, subject: string) => permissions[`${action}:${subject}`] ?? false),
    cannot: vi.fn(),
    relevantRuleFor: vi.fn(),
  }) as unknown as AppAbility;

const createMockContext = (overrides: Record<string, unknown> = {}) => {
  const request = { headers: {}, method: 'PATCH', url: '/voice-profiles/vp-1/activate', ip: '127.0.0.1', params: { id: 'vp-1' }, ...overrides };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
};

/** Total across every label combination of `casl_enforce_denial_total`. */
const denialTotal = async (): Promise<number> => {
  const metric = register.getSingleMetric(CASL_ENFORCE_DENIAL_METRIC);
  if (!metric) return 0;
  const collected = (await metric.get()) as { values: Array<{ value: number }> };
  return collected.values.reduce((sum, sample) => sum + sample.value, 0);
};

describe('UnifiedAuthGuard — enforce mode is permission-scoped ', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let policyEngine: PolicyEngine;
  let metadata: Record<string, unknown>;
  let recordEnforceDenial: ReturnType<typeof vi.fn>;

  const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };
  const mockAbility = createMockAbility({
    'update:UserVoiceProfile': true,
    'read:Consultation': true,
    'manage:Tenant': true,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};

    reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) } as unknown as Reflector;

    const apiKeyService = {
      extractApiKeyFromRequest: vi.fn().mockReturnValue(null),
      authenticateByRawKey: vi.fn(),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as IApiKeyService;

    recordEnforceDenial = vi.fn();
    policyEngine = {
      buildAbility: vi.fn().mockResolvedValue(mockAbility),
      evaluateShadowVerdict: vi.fn().mockReturnValue({ typeVerdict: true, instanceVerdict: false, diverged: true }),
      recordShadowDivergence: vi.fn(),
      recordEnforceDenial,
      isEnforcedPair: vi.fn((action: string, subject: string) => TEST_ENFORCED_PAIRS.has(`${action}:${subject}`)),
    } as unknown as PolicyEngine;

    const clsService = { get: vi.fn((key: string) => (key === 'user' ? mockUser : undefined)), set: vi.fn() };

    guard = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine, clsService as never, undefined, {
      canActivate: vi.fn().mockResolvedValue(true),
    });

    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'update', subject: 'UserVoiceProfile' }];
    metadata[PERMISSION_MODE_KEY] = 'AND';
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = {
      resolver: vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'someone-else' }),
      enforceGrade: true,
    };
  });

  // ─── OR mode ──────────────────────────────────────────────────────────

  it('R4: an OR-mode route never produces an enforced denial — its declared OR semantics survive', async () => {
    metadata[PERMISSION_MODE_KEY] = 'OR';
    metadata[REQUIRED_PERMISSIONS_KEY] = [
      { action: 'update', subject: 'UserVoiceProfile' }, // enforced, would deny on this instance
      { action: 'manage', subject: 'Tenant' }, // the alternative the caller actually holds
    ];

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('the same route in AND mode still enforces — OR is the exemption, not a blanket off-switch', async () => {
    metadata[PERMISSION_MODE_KEY] = 'AND';
    await expect(guard.canActivate(createMockContext())).rejects.toMatchObject({ status: 403 });
  });

  // ─── Subject scoping ──────────────────────────────────────────────────

  it('a resolver that declares its subject is applied ONLY to permissions for that subject', async () => {
    metadata[REQUIRED_PERMISSIONS_KEY] = [
      { action: 'read', subject: 'Consultation' }, // enforced pair, but NOT what the resolver resolves
      { action: 'update', subject: 'UserVoiceProfile' },
    ];
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = {
      resolver: vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'jwt-user-1' }),
      subject: 'Consultation',
      enforceGrade: true,
    };
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({ typeVerdict: true, instanceVerdict: false, diverged: true });

    await expect(guard.canActivate(createMockContext())).rejects.toMatchObject({ status: 403 });
    // Exactly ONE denial — the subject the resolver declared. The
    // `UserVoiceProfile` permission was never evaluated against a
    // `Consultation` instance.
    expect(recordEnforceDenial).toHaveBeenCalledTimes(1);
    expect(recordEnforceDenial).toHaveBeenCalledWith('read', 'Consultation', expect.any(Object));
  });

  it('an undeclared-subject resolver keeps the legacy behaviour (every permission), so nothing silently stops enforcing', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = {
      resolver: vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'someone-else' }),
      enforceGrade: true,
    };
    await expect(guard.canActivate(createMockContext())).rejects.toMatchObject({ status: 403 });
    expect(recordEnforceDenial).toHaveBeenCalledWith('update', 'UserVoiceProfile', expect.any(Object));
  });

  it('a bare-function resolver (the pre-metadata shape) still works', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'someone-else' });
    await expect(guard.canActivate(createMockContext())).rejects.toMatchObject({ status: 403 });
  });

  it('ResolveSubjectInstance stores a descriptor carrying the declared options', () => {
    const fn = vi.fn();
    const decorate = ResolveSubjectInstance(fn, { subject: 'ApiKey', enforceGrade: true });
    class Target {}
    decorate(Target);
    expect(Reflect.getMetadata(SUBJECT_INSTANCE_RESOLVER_KEY, Target)).toEqual({ resolver: fn, subject: 'ApiKey', enforceGrade: true });
  });

  // ─── The metric is alive ──────────────────────────────────────────────

  it('HONESTY PROOF: an applied denial actually increments casl_enforce_denial_total', async () => {
    // The whole point of: prove the counter is not structurally dead.
    // A REAL PolicyEngine records the denial, so the increment is observed on
    // the real prom-client registry rather than on a spy.
    const realEngine = new PolicyEngine({ client: {}, baseClient: {} } as never, undefined);
    vi.spyOn(realEngine, 'buildAbility').mockResolvedValue(mockAbility);
    vi.spyOn(realEngine, 'evaluateShadowVerdict').mockReturnValue({ typeVerdict: true, instanceVerdict: false, diverged: true });
    vi.spyOn(realEngine, 'isEnforcedPair').mockImplementation((action: string, subject: string) => TEST_ENFORCED_PAIRS.has(`${action}:${subject}`));

    const clsService = { get: vi.fn((key: string) => (key === 'user' ? mockUser : undefined)), set: vi.fn() };
    const apiKeyService = {
      extractApiKeyFromRequest: vi.fn().mockReturnValue(null),
      authenticateByRawKey: vi.fn(),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as IApiKeyService;
    const realGuard = new UnifiedAuthGuard(reflector, apiKeyService, realEngine, clsService as never, undefined, {
      canActivate: vi.fn().mockResolvedValue(true),
    });

    const before = await denialTotal();
    await expect(realGuard.canActivate(createMockContext())).rejects.toMatchObject({ status: 403 });
    const after = await denialTotal();

    expect(after).toBe(before + 1);
  });
});
