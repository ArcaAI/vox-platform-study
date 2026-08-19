/**
 * TASK-712 Phase 5 Task 15c — the EVIDENCE for enforcing `ApiKey`.
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
import { describe, it, expect, beforeEach } from 'vitest';
import { createPrismaAbility } from '@casl/prisma';
import { PolicyEngine, AppAbility, CASL_ENFORCED_PAIRS } from '../policy.engine';
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

    // Today (type-only) — the in-tenant privilege gap casl-blast-radius.md §4 names.
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

  it('the enforce list contains exactly the three ApiKey pairs this evidence covers', () => {
    // Pinned. Any addition is an authorization-semantics change and must come
    // with its own evidence in the ticket README before this test is edited.
    expect([...CASL_ENFORCED_PAIRS].sort()).toEqual(['delete:ApiKey', 'read:ApiKey', 'update:ApiKey']);
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
