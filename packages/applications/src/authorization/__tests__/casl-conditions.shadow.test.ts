/**
 * TASK-712 Phase 5 Task 14 — CASL condition-evaluation SHADOW mode.
 *
 * Scope discipline (owner directive, R1): this suite proves the guard now
 * COMPUTES an instance-aware verdict for opted-in routes and RECORDS every
 * divergence from the type-only verdict — and, just as importantly, that the
 * type-only verdict remains the ONLY thing that decides the request outcome.
 * There is no enforce path here; Task 15 (deliberately not started this
 * pass) is what would ever flip a subject's instance verdict to authoritative.
 *
 * Two things under test:
 * 1. `PolicyEngine.evaluateShadowVerdict` — pure comparison, no I/O.
 * 2. `UnifiedAuthGuard`'s opt-in wiring — `@ResolveSubjectInstance(...)`
 *    metadata is read, the resolver is invoked, and a divergence is
 *    recorded via `PolicyEngine.recordShadowDivergence` — all without ever
 *    changing what `canActivate` returns or throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyEngine, AppAbility, CASL_SHADOW_DIVERGENCE_EVENT, CASL_SHADOW_DIVERGENCE_METRIC } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { UnifiedAuthGuard, SUBJECT_INSTANCE_RESOLVER_KEY, ResolveSubjectInstance, SubjectInstanceResolver } from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';

// ─── 1. PolicyEngine.evaluateShadowVerdict — pure comparison ────────────

describe('PolicyEngine.evaluateShadowVerdict', () => {
  const mockDatabaseService = { client: {}, baseClient: {} };
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine(mockDatabaseService as any, undefined);
  });

  const abilityAllowingType = (): AppAbility =>
    ({
      // Mirrors real CASL's calling convention as `PolicyEngine.can` uses it:
      // `ability.can(action, subject)` for the type-only call (2 args), and
      // `ability.can(action, subject, resource)` for the instance-aware call
      // (3 args) — see `PolicyEngine.can` in `policy.engine.ts`.
      can: vi.fn((_action: string, _subject: string, resource?: Record<string, unknown>) => {
        if (resource === undefined) return true; // type-only: matches on type alone (today's real bug)
        // Instance-aware: the fake ability applies the ONE seeded condition
        // shape this suite cares about — `tenantId` equality — exactly the
        // hazard casl-blast-radius.md names.
        return resource.tenantId === 'tenant-1';
      }),
      cannot: vi.fn(),
      relevantRuleFor: vi.fn(),
    }) as unknown as AppAbility;

  it('reports no divergence when the instance verdict agrees with the type verdict', () => {
    const ability = abilityAllowingType();
    const verdict = engine.evaluateShadowVerdict(ability, 'read', 'Consultation', { tenantId: 'tenant-1' });

    expect(verdict.typeVerdict).toBe(true);
    expect(verdict.instanceVerdict).toBe(true);
    expect(verdict.diverged).toBe(false);
  });

  it('THE HAZARD: an instance missing tenantId diverges to would-deny, not a silent deny', () => {
    const ability = abilityAllowingType();
    // No `tenantId` key at all — a partial projection / freshly-built entity,
    // exactly the call-site shape casl-blast-radius.md flags as dangerous.
    const verdict = engine.evaluateShadowVerdict(ability, 'read', 'Consultation', { id: 'c-1' });

    expect(verdict.typeVerdict).toBe(true); // what is ACTUALLY enforced today
    expect(verdict.instanceVerdict).toBe(false); // what conditions WOULD decide
    expect(verdict.diverged).toBe(true); // recorded as a divergence, not applied
  });

  it('records a divergence with the metric and event names casl-blast-radius.md specifies', () => {
    const ability = abilityAllowingType();
    const verdict = engine.evaluateShadowVerdict(ability, 'manage', 'Consultation', { id: 'c-1' });
    const logSpy = vi.spyOn((engine as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');

    engine.recordShadowDivergence('manage', 'Consultation', verdict);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: CASL_SHADOW_DIVERGENCE_EVENT,
        action: 'manage',
        subject: 'Consultation',
        direction: 'would_deny',
      }),
    );
    expect(CASL_SHADOW_DIVERGENCE_METRIC).toBe('casl_shadow_divergence_total');
  });

  it('does not log when there is no divergence', () => {
    const ability = abilityAllowingType();
    const verdict = engine.evaluateShadowVerdict(ability, 'read', 'Consultation', { tenantId: 'tenant-1' });
    const logSpy = vi.spyOn((engine as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');

    engine.recordShadowDivergence('read', 'Consultation', verdict);

    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ─── 2. UnifiedAuthGuard — opt-in shadow wiring, never changes the outcome ──

const createMockAbility = (permissions: Record<string, boolean>): AppAbility =>
  ({
    can: vi.fn((action: string, subject: string) => permissions[`${action}:${subject}`] ?? false),
    cannot: vi.fn(),
    relevantRuleFor: vi.fn(),
  }) as unknown as AppAbility;

const createMockContext = (overrides: Record<string, unknown> = {}) => {
  const request = { headers: {}, method: 'GET', url: '/consultations/c-1', ip: '127.0.0.1', params: {}, ...overrides };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
};

describe('UnifiedAuthGuard — CASL shadow mode (Task 14)', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let apiKeyService: IApiKeyService;
  let policyEngine: PolicyEngine;
  let clsService: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let metadata: Record<string, unknown>;

  const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };
  const mockAbility = createMockAbility({ 'read:Consultation': true });

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};

    reflector = {
      getAllAndOverride: vi.fn((key: string) => metadata[key]),
    } as unknown as Reflector;

    apiKeyService = {
      extractApiKeyFromRequest: vi.fn().mockReturnValue(null),
      authenticateByRawKey: vi.fn(),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as IApiKeyService;

    policyEngine = {
      buildAbility: vi.fn().mockResolvedValue(mockAbility),
      evaluateShadowVerdict: vi.fn(),
      recordShadowDivergence: vi.fn(),
    } as unknown as PolicyEngine;

    clsService = {
      get: vi.fn((key: string) => (key === 'user' ? mockUser : undefined)),
      set: vi.fn(),
    };

    guard = new UnifiedAuthGuard(
      reflector,
      apiKeyService,
      policyEngine,
      clsService as any,
      undefined,
      { canActivate: vi.fn().mockResolvedValue(true) },
    );

    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'read', subject: 'Consultation' }];
    metadata[PERMISSION_MODE_KEY] = 'AND';
  });

  it('is a strict no-op — no resolver, no evaluateShadowVerdict call, no row loaded — when the route did not opt in', async () => {
    // No SUBJECT_INSTANCE_RESOLVER_KEY metadata set at all.
    const result = await guard.canActivate(createMockContext());

    expect(result).toBe(true);
    expect(policyEngine.evaluateShadowVerdict).not.toHaveBeenCalled();
  });

  it('THE HAZARD, end to end: an opted-in resolver returning an instance missing tenantId is recorded as a divergence but the request is still ALLOWED (type-only verdict stays authoritative)', async () => {
    const resolver: SubjectInstanceResolver = vi.fn().mockReturnValue({ id: 'c-1' }); // no tenantId
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = resolver;

    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: false,
      diverged: true,
    });

    const result = await guard.canActivate(createMockContext());

    // Shadow mode changed NOTHING about the outcome.
    expect(result).toBe(true);
    // But the resolver ran and the divergence was computed + recorded.
    expect(resolver).toHaveBeenCalled();
    expect(policyEngine.evaluateShadowVerdict).toHaveBeenCalledWith(mockAbility, 'read', 'Consultation', { id: 'c-1' });
    expect(policyEngine.recordShadowDivergence).toHaveBeenCalledWith(
      'read',
      'Consultation',
      { typeVerdict: true, instanceVerdict: false, diverged: true },
      expect.any(Object),
    );
  });

  it('does not record anything when the resolver and the type verdict agree', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: true,
      diverged: false,
    });

    const result = await guard.canActivate(createMockContext());

    expect(result).toBe(true);
    expect(policyEngine.recordShadowDivergence).not.toHaveBeenCalled();
  });

  it('skips the shadow check (no crash) when the resolver returns undefined — "nothing to compare" is not a divergence', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue(undefined);

    const result = await guard.canActivate(createMockContext());

    expect(result).toBe(true);
    expect(policyEngine.evaluateShadowVerdict).not.toHaveBeenCalled();
  });

  it('never lets a throwing resolver affect the real authorization outcome', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockImplementation(() => {
      throw new Error('boom — e.g. a DB lookup the resolver author forgot to guard');
    });

    const result = await guard.canActivate(createMockContext());

    expect(result).toBe(true);
    expect(policyEngine.evaluateShadowVerdict).not.toHaveBeenCalled();
  });

  it('supports an async resolver', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockResolvedValue({ tenantId: 'tenant-1' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: true,
      diverged: false,
    });

    const result = await guard.canActivate(createMockContext());

    expect(result).toBe(true);
    expect(policyEngine.evaluateShadowVerdict).toHaveBeenCalledWith(mockAbility, 'read', 'Consultation', { tenantId: 'tenant-1' });
  });

  it('THE FULL PROOF, denied side: shadow mode changes nothing even when the divergence runs the other way (would_allow)', async () => {
    // Type-only verdict already denies (no permission for 'manage').
    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'manage', subject: 'Consultation' }];
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1', doctorId: 'jwt-user-1' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: false,
      instanceVerdict: true,
      diverged: true,
    });

    await expect(guard.canActivate(createMockContext())).rejects.toThrow('Missing permissions: manage:Consultation');
    expect(policyEngine.recordShadowDivergence).toHaveBeenCalledWith(
      'manage',
      'Consultation',
      { typeVerdict: false, instanceVerdict: true, diverged: true },
      expect.any(Object),
    );
  });
});

// ResolveSubjectInstance itself is a thin SetMetadata wrapper — proven by the
// guard tests above actually reading what it sets. This last check pins the
// metadata KEY the decorator and the guard must agree on.
describe('ResolveSubjectInstance', () => {
  it('sets SUBJECT_INSTANCE_RESOLVER_KEY metadata to the given resolver', () => {
    const resolver: SubjectInstanceResolver = () => ({ tenantId: 't-1' });
    class Dummy {
      @ResolveSubjectInstance(resolver)
      handler() {}
    }
    const stored = Reflect.getMetadata(SUBJECT_INSTANCE_RESOLVER_KEY, Dummy.prototype.handler);
    expect(stored).toBe(resolver);
  });
});
