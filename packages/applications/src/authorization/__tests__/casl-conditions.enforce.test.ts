/**
 * TASK-712 Phase 5 Task 15 — CASL condition-evaluation ENFORCE mode.
 *
 * Task 14 shipped shadow mode: an opted-in route resolves a subject instance,
 * the instance-aware verdict is COMPUTED and any divergence RECORDED, and the
 * type-only verdict remains the only thing that decides the request. Task 15
 * flips the instance verdict to authoritative — but ONLY for the explicit,
 * code-declared `(action, subject)` pairs in `CASL_ENFORCED_PAIRS`. Every
 * other pair keeps Task 14's shadow semantics exactly.
 *
 * The invariants this suite pins (owner directive R1 — shadow → measure →
 * enforce, per pair, independently revertible):
 *
 * 1. A pair NOT on the enforce list behaves exactly as it did in shadow mode:
 *    divergence recorded, outcome unchanged. (Regression net for the flip.)
 * 2. A pair ON the enforce list whose instance verdict denies produces a
 *    ForbiddenException — 403, a PRIVILEGE denial, never the 404-over-403
 *    cross-tenant posture (which `@TenantOwnedResource` owns, elsewhere).
 * 3. Enforcement can only NARROW. An enforced pair whose type-only verdict
 *    already denies still fails with the type-only message; an instance
 *    verdict that would ALLOW never rescues a type-only deny.
 * 4. Enforcement is fail-open toward "do nothing": no resolver, a resolver
 *    returning undefined, or a throwing resolver must never manufacture a
 *    denial. A broken resolver is a diagnostics bug, not an outage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyEngine, AppAbility, CASL_ENFORCED_PAIRS, CASL_ENFORCE_DENIAL_EVENT, CASL_ENFORCE_DENIAL_METRIC } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { UnifiedAuthGuard, SUBJECT_INSTANCE_RESOLVER_KEY } from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';

// ─── 1. The enforce list itself ─────────────────────────────────────────

describe('CASL_ENFORCED_PAIRS', () => {
  const mockDatabaseService = { client: {}, baseClient: {} };
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine(mockDatabaseService as any, undefined);
  });

  it('contains ONLY pairs that are REACHABLE and whose evidence is in the ticket README', () => {
    // TASK-781: the three `ApiKey` pairs were removed. They were unreachable —
    // the route resolver loads its row through a 404-throwing accessor, so on
    // the deny case it threw and the guard failed open (TASK-779 F-1) — and
    // making them fire would have replaced a deliberate 404 with an
    // existence-leaking 403 (DEF-C3). The boundary is enforced by
    // `ApiKeyService.assertKeyAccess`, one layer down, with the safer status.
    //
    // Adding an entry here is an authorization-semantics change: it needs
    // evidence in the ticket README AND an enforce-grade resolver, or
    // `auditCaslEnforcePairReachability` refuses to boot the gateway.
    expect([...CASL_ENFORCED_PAIRS].sort()).toEqual([]);
  });

  it('isEnforcedPair answers false for ApiKey — the boundary belongs to the service layer', () => {
    for (const action of ['read', 'update', 'delete']) {
      expect(engine.isEnforcedPair(action, 'ApiKey')).toBe(false);
    }
  });

  it('isEnforcedPair answers false for the two investigated-and-disqualified candidates', () => {
    // Consultation: its controller runs a post-guard shared-patient fallback
    // the guard cannot see (enforcing would 403 a legitimate read).
    expect(engine.isEnforcedPair('read', 'Consultation')).toBe(false);
    expect(engine.isEnforcedPair('manage', 'Consultation')).toBe(false);
    // UserVoiceProfile: already enforced by TenantOwnedResourceInterceptor as
    // a deliberate 404. Guards run BEFORE interceptors, so enforcing here
    // would downgrade that to an existence-leaking 403.
    expect(engine.isEnforcedPair('update', 'UserVoiceProfile')).toBe(false);
    expect(engine.isEnforcedPair('delete', 'UserVoiceProfile')).toBe(false);
  });

  it('records an enforce denial under the documented metric and event names', () => {
    const logSpy = vi.spyOn((engine as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');

    engine.recordEnforceDenial('update', 'UserVoiceProfile', { method: 'PATCH', path: '/voice-profiles/vp-1/activate' });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: CASL_ENFORCE_DENIAL_EVENT,
        action: 'update',
        subject: 'UserVoiceProfile',
      }),
    );
    expect(CASL_ENFORCE_DENIAL_METRIC).toBe('casl_enforce_denial_total');
    expect(CASL_ENFORCE_DENIAL_EVENT).toBe('casl.enforce.denial');
  });
});

// ─── 2. UnifiedAuthGuard — enforce wiring ───────────────────────────────

/** Pairs this suite treats as enforced, independent of the shipped list. */
const TEST_ENFORCED_PAIRS = new Set(['update:UserVoiceProfile', 'delete:UserVoiceProfile']);

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

describe('UnifiedAuthGuard — CASL enforce mode (Task 15)', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let apiKeyService: IApiKeyService;
  let policyEngine: PolicyEngine;
  let clsService: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let metadata: Record<string, unknown>;

  const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };
  const mockAbility = createMockAbility({
    'update:UserVoiceProfile': true,
    'delete:UserVoiceProfile': true,
    'read:Consultation': true,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};

    reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) } as unknown as Reflector;

    apiKeyService = {
      extractApiKeyFromRequest: vi.fn().mockReturnValue(null),
      authenticateByRawKey: vi.fn(),
      hasScope: vi.fn().mockReturnValue(true),
    } as unknown as IApiKeyService;

    policyEngine = {
      buildAbility: vi.fn().mockResolvedValue(mockAbility),
      evaluateShadowVerdict: vi.fn(),
      recordShadowDivergence: vi.fn(),
      recordEnforceDenial: vi.fn(),
      // The MECHANISM is what this suite exercises, so the double declares
      // its own enforced pair. The shipped list is empty (pinned above); if
      // the mechanism only worked for the shipped list these tests would be
      // vacuous the moment that list is empty — which is today.
      isEnforcedPair: vi.fn((action: string, subject: string) => TEST_ENFORCED_PAIRS.has(`${action}:${subject}`)),
    } as unknown as PolicyEngine;

    clsService = { get: vi.fn((key: string) => (key === 'user' ? mockUser : undefined)), set: vi.fn() };

    guard = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine, clsService as any, undefined, {
      canActivate: vi.fn().mockResolvedValue(true),
    });

    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'update', subject: 'UserVoiceProfile' }];
    metadata[PERMISSION_MODE_KEY] = 'AND';
  });

  it('THE FLIP: an enforced pair whose instance verdict denies now returns 403, and the denial is recorded', async () => {
    // The seeded rule is `userId = ${user.id}`; the resolved row belongs to
    // ANOTHER user in the same tenant — today allowed (type-only), and the
    // exact in-tenant privilege gap casl-blast-radius.md §4 names.
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'someone-else' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: false,
      diverged: true,
    });

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(/update:UserVoiceProfile/);
    expect(policyEngine.recordEnforceDenial).toHaveBeenCalledWith('update', 'UserVoiceProfile', expect.any(Object));
  });

  it('is a 403 ForbiddenException — a privilege denial, never the 404-over-403 cross-tenant posture', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'someone-else' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: false,
      diverged: true,
    });

    await expect(guard.canActivate(createMockContext())).rejects.toMatchObject({ status: 403 });
  });

  it('allows an enforced pair when the instance verdict agrees — the caller owns the row', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'jwt-user-1' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: true,
      diverged: false,
    });

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('REGRESSION NET: an UNLISTED pair keeps Task 14 shadow semantics — divergence recorded, request still allowed', async () => {
    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'read', subject: 'Consultation' }];
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ id: 'c-1' }); // no tenantId — the hazard shape
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: true,
      instanceVerdict: false,
      diverged: true,
    });

    await expect(guard.canActivate(createMockContext({ url: '/consultations/c-1' }))).resolves.toBe(true);
    expect(policyEngine.recordShadowDivergence).toHaveBeenCalled();
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('ENFORCEMENT ONLY NARROWS: an instance verdict that would allow never rescues a type-only deny', async () => {
    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'delete', subject: 'UserVoiceProfile' }];
    const denyingAbility = createMockAbility({ 'delete:UserVoiceProfile': false });
    (policyEngine.buildAbility as ReturnType<typeof vi.fn>).mockResolvedValue(denyingAbility);
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue({ tenantId: 'tenant-1', userId: 'jwt-user-1' });
    (policyEngine.evaluateShadowVerdict as ReturnType<typeof vi.fn>).mockReturnValue({
      typeVerdict: false,
      instanceVerdict: true,
      diverged: true,
    });

    await expect(guard.canActivate(createMockContext())).rejects.toThrow('Missing permissions: delete:UserVoiceProfile');
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: a route with no resolver is untouched by enforce, even for a listed pair', async () => {
    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(policyEngine.evaluateShadowVerdict).not.toHaveBeenCalled();
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: a resolver returning undefined (row not found) does not manufacture a denial', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockReturnValue(undefined);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: a THROWING resolver on an enforced pair must never be the reason a real request fails', async () => {
    metadata[SUBJECT_INSTANCE_RESOLVER_KEY] = vi.fn().mockImplementation(() => {
      throw new Error('boom — the resolver author forgot to guard a DB lookup');
    });

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(policyEngine.recordEnforceDenial).not.toHaveBeenCalled();
  });
});
