/**
 * c — the EVIDENCE for enforcing `ApiKey`.
 *
 * R1's contract is shadow → MEASURE → enforce. Pass 5 could not measure
 * anything because shadow was wired to zero routes; Pass 6 wires it and, for
 * exactly one subject, replaces "no measurement" with an EXHAUSTIVE OFFLINE
 * one: this suite builds abilities from the REAL seeded rules
 * (`DEFAULT_POLICIES`, imported — never transcribed) and pins the full verdict
 * table the flip produces, using the same `PolicyEngine.can` the guard calls.
 *
 * What that proves, and what it does not. It proves that for every principal
 * shape the seed can produce, the instance verdict differs from today's
 * type-only verdict in exactly ONE direction and ONE case: a principal holding
 * only `api-key-own-manage` addressing a key that is not theirs. It does NOT
 * prove production traffic contains no other shape — which is why the
 * resolver's instance shape is closed (it returns `tenantId` + `userId`, both
 * always present on the row) and is the only instance this pair can ever see.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createPrismaAbility } from '@casl/prisma';
import { PolicyEngine, AppAbility, CASL_ENFORCED_PAIRS } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { UnifiedAuthGuard, SUBJECT_INSTANCE_RESOLVER_KEY } from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';
import { DEFAULT_POLICIES } from '../../../../database/src/prisma/db_main/seed/01-policy';

const TENANT = 'tenant-1';
const USER = 'user-1';

/** Substitutes the seed's template variables exactly as `PolicyEngine` does. */
const resolve = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace('${user.id}', USER).replace('${context.tenantId}', TENANT) : value;

const abilityFromPolicies = (names: string[]): AppAbility => {
  const rules = DEFAULT_POLICIES.filter((p) => names.includes(p.name)).flatMap((p) =>
    p.rules.map((r) => ({
      action: r.action,
      subject: r.subject,
      ...(r.conditions ? { conditions: Object.fromEntries(Object.entries(r.conditions).map(([k, v]) => [k, resolve(v)])) } : {}),
    })),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- seed rules are DB-stored JSON; the engine builds them the same untyped way.
  return createPrismaAbility(rules as any) as AppAbility;
};

/** The names actually present in the seed — asserted, so a rename fails loudly. */
const OWN_KEYS = 'api-key-own-manage';
const TENANT_ADMIN = DEFAULT_POLICIES.find((p) => p.rules.some((r) => r.subject === 'ApiKey' && r.action === 'manage'))?.name ?? '';
const SUPER_ADMIN = DEFAULT_POLICIES.find((p) => p.rules.some((r) => r.subject === 'all'))?.name ?? '';

describe('ApiKey enforce — evidence', () => {
  let engine: PolicyEngine;
  beforeEach(() => {
    engine = new PolicyEngine({ client: {}, baseClient: {} } as any, undefined);
  });

  it('the seed still contains the three policies this evidence depends on', () => {
    expect(DEFAULT_POLICIES.some((p) => p.name === OWN_KEYS)).toBe(true);
    expect(TENANT_ADMIN).not.toBe('');
    expect(SUPER_ADMIN).not.toBe('');
  });

  it('THE FLIP: an own-keys-only principal reading ANOTHER user’s key is allowed today and denied after', () => {
    const ability = abilityFromPolicies([OWN_KEYS]);
    const foreignKey = { tenantId: TENANT, userId: 'someone-else' };

    // Today (type-only) — the in-tenant privilege gap casl-blast-radius.md names.
    expect(ability.can('read', 'ApiKey')).toBe(true);
    // After the flip.
    expect(engine.can(ability, 'read', 'ApiKey', foreignKey)).toBe(false);
  });

  it('NO OUTAGE — every legitimate principal keeps its access on read/update/delete', () => {
    const own = { tenantId: TENANT, userId: USER };
    const someoneElses = { tenantId: TENANT, userId: 'someone-else' };

    for (const action of ['read', 'update', 'delete']) {
      // A user acting on their OWN key.
      expect(engine.can(abilityFromPolicies([OWN_KEYS]), action, 'ApiKey', own)).toBe(true);
      // A tenant admin (`manage:ApiKey { tenantId }`) acting on ANY key in the tenant.
      expect(engine.can(abilityFromPolicies([TENANT_ADMIN]), action, 'ApiKey', someoneElses)).toBe(true);
      // A super admin (`manage all`, unconditional).
      expect(engine.can(abilityFromPolicies([SUPER_ADMIN]), action, 'ApiKey', someoneElses)).toBe(true);
    }
  });

  it('a key with a NULL userId is readable by admins and refused to an own-keys-only principal', () => {
    // `ApiKey.userId` is nullable (apikey.prisma) — a platform/seeded key. The
    // refusal is the intended narrowing, not a regression: an own-keys-only
    // principal has no claim on a key nobody owns.
    const orphan = { tenantId: TENANT, userId: null };
    expect(engine.can(abilityFromPolicies([TENANT_ADMIN]), 'read', 'ApiKey', orphan)).toBe(true);
    expect(engine.can(abilityFromPolicies([OWN_KEYS]), 'read', 'ApiKey', orphan)).toBe(false);
  });

  it('the ApiKey pairs are NOT enforced at the guard — the CASL table above is redundant with the service', () => {
    // The verdict table above is still true, and that is precisely the point:
    // `ApiKeyService.assertKeyAccess` already enforces the SAME
    // `{tenantId, userId}` boundary the seeded rule expresses, and answers
    // 404 rather than 403 so a peer's key id is indistinguishable from a
    // non-existent one. Guards run before services, so a guard-level denial
    // could only ever pre-empt that 404 with an existence-leaking 403.
    expect([...CASL_ENFORCED_PAIRS].sort()).toEqual([]);
  });

  it('the two investigated-and-DISQUALIFIED subjects are still absent', () => {
    // Consultation: post-guard shared-patient fallback the guard cannot see.
    expect(engine.isEnforcedPair('read', 'Consultation')).toBe(false);
    expect(engine.isEnforcedPair('manage', 'Consultation')).toBe(false);
    // UserVoiceProfile: TenantOwnedResourceInterceptor answers 404 by design,
    // and guards run BEFORE interceptors (DEF-C3).
    expect(engine.isEnforcedPair('update', 'UserVoiceProfile')).toBe(false);
    expect(engine.isEnforcedPair('delete', 'UserVoiceProfile')).toBe(false);
    // Role: wired to SHADOW this pass, deliberately not enforced.
    expect(engine.isEnforcedPair('manage', 'Role')).toBe(false);
    expect(engine.isEnforcedPair('read', 'Role')).toBe(false);
  });
});

/**
 * THE REMOVAL CHANGED NO BEHAVIOUR, proven rather than asserted.
 *
 * Owner decision 2026-08-20 removed `read`/`update`/`delete:ApiKey` from
 * `CASL_ENFORCED_PAIRS` on the finding that they were enforced in NAME ONLY.
 * "In name only" is a testable claim, so this suite tests it: it drives the
 * REAL `UnifiedAuthGuard` over the REAL seeded `api-key-own-manage` ability
 * twice — once with the three pairs listed exactly as had them, once
 * with the shipped (empty) list — and asserts the outcome is IDENTICAL.
 *
 * The two runs can only differ on a request where the guard sees an instance
 * the caller does not own. `resolveApiKeyInstance` cannot produce one: it
 * loads its row through `IApiKeyService.fetchById`, which asserts access and
 * throws 404 (pinned in `apps/api/src/modules/api-key/__tests__/api-key.controller.test.ts`).
 * So only two branches exist, and both are covered below:
 *
 *   1. non-owned key → the resolver THROWS → `runCaslInstanceChecks` swallows
 *      it → no denial, either way, and the service's 404 answers downstream;
 *   2. owned key → the instance verdict is `true` → nothing to enforce.
 *
 * The counter-case is included too, as the honesty check: fed the instance the
 * resolver can never return, the two runs DO diverge — which is what makes the
 * two invariance assertions above meaningful rather than vacuous.
 */
describe('ApiKey enforce removal — behavioural invariance ', () => {
  /** Exactly what listed, restored here to compare against. */
  const TASK_712_APIKEY_PAIRS: ReadonlySet<string> = new Set(['read:ApiKey', 'update:ApiKey', 'delete:ApiKey']);

  type Outcome = { allowed: boolean; error?: string; denialsRecorded: number };

  /** Drives the real guard for one `(enforced list, resolver)` combination. */
  const runGuard = async (enforcedPairs: ReadonlySet<string>, resolver: () => unknown): Promise<Outcome> => {
    const engine = new PolicyEngine({ client: {}, baseClient: {} } as any, undefined);
    const ability = abilityFromPolicies([OWN_KEYS]);
    vi.spyOn(engine, 'buildAbility').mockResolvedValue(ability);
    vi.spyOn(engine, 'isEnforcedPair').mockImplementation((action: string, subject: string) => enforcedPairs.has(`${action}:${subject}`));
    const recordEnforceDenial = vi.spyOn(engine, 'recordEnforceDenial').mockImplementation(() => undefined);
    vi.spyOn(engine, 'recordShadowDivergence').mockImplementation(() => undefined);

    const metadata: Record<string, unknown> = {
      [REQUIRED_PERMISSIONS_KEY]: [{ action: 'read', subject: 'ApiKey' }],
      [PERMISSION_MODE_KEY]: 'AND',
      [SUBJECT_INSTANCE_RESOLVER_KEY]: { resolver, subject: 'ApiKey', enforceGrade: false },
    };

    const guard = new UnifiedAuthGuard(
      { getAllAndOverride: vi.fn((key: string) => metadata[key]) } as unknown as Reflector,
      { extractApiKeyFromRequest: vi.fn().mockReturnValue(null), authenticateByRawKey: vi.fn(), hasScope: vi.fn().mockReturnValue(true) } as unknown as IApiKeyService,
      engine,
      { get: vi.fn((key: string) => (key === 'user' ? { id: USER, tenantId: TENANT } : undefined)), set: vi.fn() } as any,
      undefined,
      { canActivate: vi.fn().mockResolvedValue(true) },
    );

    const request = { headers: {}, method: 'GET', url: '/admin/api-keys/key-1', ip: '127.0.0.1', params: { id: 'key-1' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    try {
      const allowed = await guard.canActivate(context);
      return { allowed, denialsRecorded: recordEnforceDenial.mock.calls.length };
    } catch (error) {
      return { allowed: false, error: error instanceof Error ? error.message : String(error), denialsRecorded: recordEnforceDenial.mock.calls.length };
    }
  };

  beforeEach(() => vi.restoreAllMocks());

  it('BRANCH 1 (non-owned key — the only request the pairs existed to deny): identical outcome, listed or not', async () => {
    // `fetchById` → `assertKeyAccess` → 404. The resolver propagates the throw.
    const throwingResolver = () => {
      throw new Error('API key not found');
    };

    const withPairs = await runGuard(TASK_712_APIKEY_PAIRS, throwingResolver);
    const shipped = await runGuard(CASL_ENFORCED_PAIRS, throwingResolver);

    expect(withPairs).toEqual(shipped);
    expect(shipped).toEqual({ allowed: true, denialsRecorded: 0 });
  });

  it('BRANCH 2 (owned key — access already asserted): identical outcome, listed or not', async () => {
    const ownedRow = () => ({ tenantId: TENANT, userId: USER });

    const withPairs = await runGuard(TASK_712_APIKEY_PAIRS, ownedRow);
    const shipped = await runGuard(CASL_ENFORCED_PAIRS, ownedRow);

    expect(withPairs).toEqual(shipped);
    expect(shipped).toEqual({ allowed: true, denialsRecorded: 0 });
  });

  it('HONESTY CHECK: the comparison is not vacuous — a foreign instance (which this resolver can never return) DOES diverge', async () => {
    const foreignRow = () => ({ tenantId: TENANT, userId: 'someone-else' });

    const withPairs = await runGuard(TASK_712_APIKEY_PAIRS, foreignRow);
    const shipped = await runGuard(CASL_ENFORCED_PAIRS, foreignRow);

    expect(withPairs.allowed).toBe(false);
    expect(withPairs.error).toMatch(/read:ApiKey/);
    expect(withPairs.denialsRecorded).toBe(1);
    // …and with the shipped list the request is allowed through to
    // `assertKeyAccess`, which answers 404 — the safer status.
    expect(shipped).toEqual({ allowed: true, denialsRecorded: 0 });
  });
});
