/**
 * Pure rate-limit resolution (TASK-785).
 *
 * The five-level cascade, with NO Nest, NO DB and NO Redis, so the precedence
 * contract is exhaustively unit-testable (`__tests__/rate-limit-resolver.test.ts`)
 * independently of the guard that consumes it. `TieredThrottlerGuard` supplies
 * the cached rule sets; this module decides which one wins.
 *
 * Declared order (OD-1) — FIRST level with an opinion wins:
 *
 *   1. tenant × route    a rule owned by the request's tenant naming this route
 *   2. tenant            a rule owned by the request's tenant matching every route (`*`)
 *   3. plan              the tenant's subscription plan
 *   4. platform route    a SYSTEM-owned rule naming this route
 *   5. platform base     the named tier baseline — always an opinion, so resolution terminates
 *
 * Ranks 1 and 2 are the SAME rule set: `*` is simply the least specific pattern
 * a tenant can write, so "most specific match wins" inside the tenant scope
 * yields rank 1 > rank 2 without a discriminator column. The reported `level`
 * distinguishes them for `explain`.
 *
 * TENANT SPECIFICITY OUTRANKS ROUTE SPECIFICITY. A tenant's broad `*:/api/*`
 * rule beats a SYSTEM rule naming the exact route. Pattern precision only
 * breaks ties WITHIN one level. That is deliberate (OD-1) and counterintuitive
 * enough to be pinned by its own test.
 */

/** The reserved pattern meaning "every route" — how a tenant expresses rank 2. */
export const ALL_ROUTES_PATTERN = '*';

export type RateLimitMatchKindName = 'EXACT' | 'PREFIX';

export type RateLimitLevel = 'tenant-route' | 'tenant' | 'plan' | 'platform-route' | 'platform-base';

/** The subset of a `RateLimitRule` row the hot path needs. */
export interface RateLimitRuleSnapshot {
  id: string;
  tenantId: string;
  routeMatch: string;
  matchKind: RateLimitMatchKindName;
  limitValue: number;
  windowMs: number;
  /** `false` = this scope is EXEMPT; resolution stops here rather than falling through. */
  active: boolean;
}

export interface RateLimitValue {
  limitValue: number;
  windowMs: number;
}

/** One level's offer, kept even when it loses so `explain` can show it. */
export interface RateLimitOffer extends RateLimitValue {
  level: RateLimitLevel;
  ruleId?: string;
  active: boolean;
}

export interface RateLimitResolution {
  /** `null` = exempt: do not throttle this request at all. */
  effective: RateLimitValue | null;
  /** Which level decided. Never null — rank 5 always has an opinion. */
  level: RateLimitLevel;
  ruleId?: string;
  /** Every level that had an opinion, most-significant first (AC-8). */
  trace: RateLimitOffer[];
}

export interface RateLimitResolveInput {
  /** `null` for traffic with no TRUSTED tenant — skips ranks 1–3 entirely. */
  tenantId: string | null;
  /** `METHOD:/route/pattern`, built from the router's registered pattern. */
  routeKey: string;
  /** Live rules owned by `tenantId`. Ignored when `tenantId` is null. */
  tenantRules: readonly RateLimitRuleSnapshot[];
  /** Live rules owned by the SYSTEM tenant. */
  platformRules: readonly RateLimitRuleSnapshot[];
  /**
   * Rank 2's OTHER source: the tenant's own tighten-only `rateLimit.maxRequests`
   * / `rateLimit.windowMs` settings row, when it actually set one.
   *
   * Kept separate from `tenantRules` because the two lanes have different
   * writers and different powers: a super admin writes RULES and may loosen; a
   * tenant writes this SETTING and `tenant-clamp.ts` lets it only tighten. Both
   * are tenant-wide, so both sit at rank 2 — a tenant × route rule still wins,
   * and both still outrank the plan.
   */
  tenantSetting?: RateLimitValue | null;
  /** Rank 3, already composed from the plan + per-tenant entitlement override. */
  plan: RateLimitValue | null;
  /** Rank 5 — the named tier baseline for this throttler. */
  base: RateLimitValue;
}

/**
 * Does `rule` apply to `routeKey`?
 *
 * EXACT  — the whole route key must be equal.
 * PREFIX — `*` matches everything. Otherwise the pattern is `METHOD:path`,
 *          where METHOD may be `*`, and `path` may end in `*` to match a
 *          subtree. A trailing `/*` is compared INCLUDING the slash, so
 *          `/api/v1/admin/*` matches `/api/v1/admin/x` but never
 *          `/api/v1/admin-tools/x`.
 */
export function matchesRoute(rule: RateLimitRuleSnapshot, routeKey: string): boolean {
  if (rule.matchKind === 'EXACT') return rule.routeMatch === routeKey;
  if (rule.routeMatch === ALL_ROUTES_PATTERN) return true;

  const sep = rule.routeMatch.indexOf(':');
  if (sep < 0) return false;

  const patternMethod = rule.routeMatch.slice(0, sep);
  const patternPath = rule.routeMatch.slice(sep + 1);

  const routeSep = routeKey.indexOf(':');
  if (routeSep < 0) return false;
  const routeMethod = routeKey.slice(0, routeSep);
  const routePath = routeKey.slice(routeSep + 1);

  if (patternMethod !== '*' && patternMethod !== routeMethod) return false;

  if (patternPath.endsWith('*')) {
    return routePath.startsWith(patternPath.slice(0, -1));
  }
  return routePath === patternPath;
}

/**
 * The most specific matching rule in one scope: EXACT first, then the longest
 * PREFIX. Ties (equal-length prefixes that both match) break on `routeMatch`
 * then `id`, so the answer never depends on row order.
 */
export function bestMatch(rules: readonly RateLimitRuleSnapshot[], routeKey: string): RateLimitRuleSnapshot | undefined {
  let best: RateLimitRuleSnapshot | undefined;

  for (const rule of rules) {
    if (!matchesRoute(rule, routeKey)) continue;
    if (rule.matchKind === 'EXACT') {
      // At most one EXACT rule can match per scope (the unique index guarantees
      // it), and EXACT always outranks PREFIX — so this is the answer.
      return rule;
    }
    if (best === undefined || isMoreSpecific(rule, best)) best = rule;
  }

  return best;
}

function isMoreSpecific(candidate: RateLimitRuleSnapshot, incumbent: RateLimitRuleSnapshot): boolean {
  if (candidate.routeMatch.length !== incumbent.routeMatch.length) {
    return candidate.routeMatch.length > incumbent.routeMatch.length;
  }
  if (candidate.routeMatch !== incumbent.routeMatch) return candidate.routeMatch < incumbent.routeMatch;
  return candidate.id < incumbent.id;
}

function offerFromRule(rule: RateLimitRuleSnapshot, level: RateLimitLevel): RateLimitOffer {
  return { level, limitValue: rule.limitValue, windowMs: rule.windowMs, ruleId: rule.id, active: rule.active };
}

export function resolveRateLimit(input: RateLimitResolveInput): RateLimitResolution {
  const trace: RateLimitOffer[] = [];

  // Ranks 1 + 2 — one lookup. `*` is the least specific tenant pattern, so the
  // tenant-wide rule loses to any route-specific rule of the same tenant.
  if (input.tenantId) {
    const tenantRule = bestMatch(input.tenantRules, input.routeKey);
    if (tenantRule) {
      trace.push(offerFromRule(tenantRule, tenantRule.routeMatch === ALL_ROUTES_PATTERN ? 'tenant' : 'tenant-route'));
    }

    // Rank 2's self-service lane. Ordered AFTER the rule lookup so a super
    // admin's tenant × route rule still wins, and before the plan so a tenant
    // that deliberately throttled itself is never widened back up to its plan.
    if (input.tenantSetting) {
      trace.push({ level: 'tenant', ...input.tenantSetting, active: true });
    }

    // Rank 3.
    if (input.plan) {
      trace.push({ level: 'plan', ...input.plan, active: true });
    }
  }

  // Rank 4.
  const platformRule = bestMatch(input.platformRules, input.routeKey);
  if (platformRule) trace.push(offerFromRule(platformRule, 'platform-route'));

  // Rank 5 — always present, so `trace` is never empty and resolution always
  // terminates with a level.
  trace.push({ level: 'platform-base', ...input.base, active: true });

  const winner = trace[0];
  return {
    effective: winner.active ? { limitValue: winner.limitValue, windowMs: winner.windowMs } : null,
    level: winner.level,
    ruleId: winner.ruleId,
    trace,
  };
}
