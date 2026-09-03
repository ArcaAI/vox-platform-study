/**
 * The precedence contract, as executable spec (P0).
 *
 * `resolveRateLimit` is pure — no Nest, no DB, no Redis — precisely so the
 * five-level cascade can be pinned exhaustively here rather than through an
 * HTTP fixture. The guard's own tests then only have to cover wiring and
 * bucket keying.
 *
 * Declared order :
 *   1. tenant × route 2. tenant 3. plan 4. platform route 5. platform base
 */
import { describe, it, expect } from 'vitest';
import { ALL_ROUTES_PATTERN, RateLimitRuleSnapshot, resolveRateLimit } from '../rate-limit-resolver';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ROUTE = 'POST:/api/v1/auth/login';

const BASE = { limitValue: 100, windowMs: 60_000 };

function rule(over: Partial<RateLimitRuleSnapshot> & Pick<RateLimitRuleSnapshot, 'routeMatch'>): RateLimitRuleSnapshot {
  return {
    id: `rule-${over.routeMatch}-${over.tenantId ?? TENANT}`,
    tenantId: TENANT,
    matchKind: 'EXACT',
    limitValue: 1,
    windowMs: 60_000,
    active: true,
    ...over,
  };
}

function resolve(over: Partial<Parameters<typeof resolveRateLimit>[0]> = {}) {
  return resolveRateLimit({
    tenantId: TENANT,
    routeKey: ROUTE,
    tenantRules: [],
    platformRules: [],
    plan: null,
    base: BASE,
    ...over,
  });
}

describe('resolveRateLimit — level precedence', () => {
  it('L1 beats L2: a tenant×route rule wins over the tenant-wide rule', () => {
    const r = resolve({
      tenantRules: [rule({ routeMatch: ROUTE, limitValue: 11 }), rule({ routeMatch: ALL_ROUTES_PATTERN, matchKind: 'PREFIX', limitValue: 22 })],
    });
    expect(r.level).toBe('tenant-route');
    expect(r.effective).toEqual({ limitValue: 11, windowMs: 60_000 });
  });

  it('L2 beats L3: the tenant-wide rule wins over the plan', () => {
    const r = resolve({
      tenantRules: [rule({ routeMatch: ALL_ROUTES_PATTERN, matchKind: 'PREFIX', limitValue: 22 })],
      plan: { limitValue: 33, windowMs: 60_000 },
    });
    expect(r.level).toBe('tenant');
    expect(r.effective?.limitValue).toBe(22);
  });

  it('L3 beats L4: the plan wins over a platform route rule', () => {
    const r = resolve({
      plan: { limitValue: 33, windowMs: 60_000 },
      platformRules: [rule({ tenantId: SYSTEM, routeMatch: ROUTE, limitValue: 44 })],
    });
    expect(r.level).toBe('plan');
    expect(r.effective?.limitValue).toBe(33);
  });

  it('L4 beats L5: a platform route rule wins over the base tier', () => {
    const r = resolve({ platformRules: [rule({ tenantId: SYSTEM, routeMatch: ROUTE, limitValue: 44 })] });
    expect(r.level).toBe('platform-route');
    expect(r.effective?.limitValue).toBe(44);
  });

  it('falls through to L5 when no level has an opinion', () => {
    const r = resolve();
    expect(r.level).toBe('platform-base');
    expect(r.effective).toEqual(BASE);
  });
});

describe('resolveRateLimit — matching within a level', () => {
  it('EXACT beats PREFIX', () => {
    const r = resolve({
      tenantRules: [
        rule({ routeMatch: '*:/api/v1/*', matchKind: 'PREFIX', limitValue: 5 }),
        rule({ routeMatch: ROUTE, matchKind: 'EXACT', limitValue: 9 }),
      ],
    });
    expect(r.effective?.limitValue).toBe(9);
  });

  it('the longest PREFIX wins among competing prefixes', () => {
    const r = resolve({
      tenantRules: [
        rule({ routeMatch: '*:/api/*', matchKind: 'PREFIX', limitValue: 1 }),
        rule({ routeMatch: '*:/api/v1/auth/*', matchKind: 'PREFIX', limitValue: 2 }),
        rule({ routeMatch: '*:/api/v1/*', matchKind: 'PREFIX', limitValue: 3 }),
      ],
    });
    expect(r.effective?.limitValue).toBe(2);
  });

  it('a method-qualified prefix does not match another method', () => {
    const r = resolve({ tenantRules: [rule({ routeMatch: 'GET:/api/v1/auth/*', matchKind: 'PREFIX', limitValue: 7 })] });
    expect(r.level).toBe('platform-base');
  });

  it('a `*:` prefix matches any method', () => {
    const r = resolve({ tenantRules: [rule({ routeMatch: '*:/api/v1/auth/*', matchKind: 'PREFIX', limitValue: 7 })] });
    expect(r.effective?.limitValue).toBe(7);
  });

  it('the reserved `*` pattern matches every route', () => {
    const r = resolve({
      routeKey: 'GET:/api/v1/anything/at/all',
      tenantRules: [rule({ routeMatch: ALL_ROUTES_PATTERN, matchKind: 'PREFIX', limitValue: 8 })],
    });
    expect(r.level).toBe('tenant');
    expect(r.effective?.limitValue).toBe(8);
  });

  it('a prefix rule does not match a route that merely shares a path segment stem', () => {
    // `/api/v1/admin-tools` must NOT be caught by a `/api/v1/admin/` subtree rule.
    const r = resolve({
      routeKey: 'GET:/api/v1/admin-tools/list',
      tenantRules: [rule({ routeMatch: '*:/api/v1/admin/*', matchKind: 'PREFIX', limitValue: 4 })],
    });
    expect(r.level).toBe('platform-base');
  });
});

describe('resolveRateLimit — OD-1 consequence: tenant specificity outranks route specificity', () => {
  it('a tenant PREFIX rule beats a platform EXACT rule', () => {
    const r = resolve({
      tenantRules: [rule({ routeMatch: '*:/api/*', matchKind: 'PREFIX', limitValue: 5 })],
      platformRules: [rule({ tenantId: SYSTEM, routeMatch: ROUTE, matchKind: 'EXACT', limitValue: 44 })],
    });
    expect(r.level).toBe('tenant-route');
    expect(r.effective?.limitValue).toBe(5);
  });
});

describe('resolveRateLimit — exemption', () => {
  it('an inactive rule EXEMPTS the scope and does not fall through', () => {
    const r = resolve({
      tenantRules: [rule({ routeMatch: ROUTE, active: false })],
      plan: { limitValue: 33, windowMs: 60_000 },
    });
    expect(r.effective).toBeNull();
    expect(r.level).toBe('tenant-route');
  });

  it('an inactive PLATFORM rule exempts every tenant on that route', () => {
    const r = resolve({ platformRules: [rule({ tenantId: SYSTEM, routeMatch: ROUTE, active: false })] });
    expect(r.effective).toBeNull();
    expect(r.level).toBe('platform-route');
  });
});

describe('resolveRateLimit — anonymous traffic', () => {
  it('a null tenant skips L1–L3 entirely', () => {
    const r = resolveRateLimit({
      tenantId: null,
      routeKey: ROUTE,
      // Deliberately non-empty: an untrusted caller must not borrow a tenant's rules.
      tenantRules: [rule({ routeMatch: ROUTE, limitValue: 11 })],
      platformRules: [],
      plan: { limitValue: 33, windowMs: 60_000 },
      base: BASE,
    });
    expect(r.level).toBe('platform-base');
    expect(r.effective).toEqual(BASE);
  });
});

describe('resolveRateLimit — trace (AC-8 `explain`)', () => {
  it('reports every level that had an opinion, plus the winner', () => {
    const r = resolve({
      tenantRules: [rule({ routeMatch: ALL_ROUTES_PATTERN, matchKind: 'PREFIX', limitValue: 22 })],
      plan: { limitValue: 33, windowMs: 60_000 },
      platformRules: [rule({ tenantId: SYSTEM, routeMatch: ROUTE, limitValue: 44 })],
    });

    expect(r.level).toBe('tenant');
    expect(r.trace.map((o) => o.level)).toEqual(['tenant', 'plan', 'platform-route', 'platform-base']);
    // The losing levels keep their values so an admin can see what WOULD apply.
    expect(r.trace.find((o) => o.level === 'plan')?.limitValue).toBe(33);
    expect(r.trace.find((o) => o.level === 'platform-route')?.limitValue).toBe(44);
    expect(r.trace.find((o) => o.level === 'platform-base')?.limitValue).toBe(100);
  });

  it('carries the winning rule id so support can name the row', () => {
    const winner = rule({ routeMatch: ROUTE, limitValue: 11 });
    const r = resolve({ tenantRules: [winner] });
    expect(r.ruleId).toBe(winner.id);
  });
});

describe('resolveRateLimit — determinism', () => {
  it('is stable when two prefixes of equal length both match', () => {
    const rules = [
      rule({ routeMatch: '*:/api/v1/auth/aa/*', matchKind: 'PREFIX', limitValue: 1 }),
      rule({ routeMatch: '*:/api/v1/auth/ab/*', matchKind: 'PREFIX', limitValue: 2 }),
    ];
    const a = resolve({ routeKey: 'POST:/api/v1/auth/aa/x', tenantRules: rules });
    const b = resolve({ routeKey: 'POST:/api/v1/auth/aa/x', tenantRules: [...rules].reverse() });
    expect(a.effective).toEqual(b.effective);
    expect(a.ruleId).toBe(b.ruleId);
  });
});
