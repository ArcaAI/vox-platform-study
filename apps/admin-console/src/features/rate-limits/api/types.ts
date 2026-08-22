export type RateLimitTier = 'default' | 'strict' | 'heavy' | 'relaxed';

/** Where an effective value came from (DB override vs code vs default). */
export type RateLimitSource = 'db' | 'code' | 'default';

/** GET /admin/rate-limit (RateLimitPolicyResponse). */
export interface RateLimitPolicy {
  enabled: boolean;
  enabledSource: 'db' | 'default';
  tiers: RateLimitTierPolicy[];
  routes: RateLimitRoutePolicy[];
}

export interface RateLimitTierPolicy {
  tier: RateLimitTier;
  limit: number;
  ttl: number;
  limitSource: RateLimitSource;
  ttlSource: RateLimitSource;
}

export interface RateLimitRoutePolicy {
  routeId: string;
  controller: string;
  handler?: string;
  description: string;
  tier: string;
  limit: number;
  ttl: number;
  enabled: boolean;
  limitSource: string;
  ttlSource: string;
}

export interface SetTierOverrideRequest {
  limit?: number;
  ttl?: number;
}

export interface SetRouteOverrideRequest {
  limit?: number;
  ttl?: number;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Rules, route catalog, explain (TASK-785)
// ---------------------------------------------------------------------------

export type RateLimitMatchKind = 'EXACT' | 'PREFIX';

/** Where an effective limit came from — the five levels of the precedence chain. */
export type RateLimitLevel = 'tenant-route' | 'tenant' | 'plan' | 'platform-route' | 'platform-base';

export interface RateLimitRule {
  id: string;
  tenantId: string;
  /** `true` when SYSTEM-owned — a platform-wide route rule (rank 4). */
  platform: boolean;
  routeMatch: string;
  matchKind: RateLimitMatchKind;
  limitValue: number;
  windowMs: number;
  active: boolean;
  description?: string | null;
  /** OCC token; sent back as `If-Match` on update. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRateLimitRuleRequest {
  tenantId?: string;
  routeMatch: string;
  matchKind?: RateLimitMatchKind;
  limitValue: number;
  windowMs: number;
  active?: boolean;
  description?: string;
}

export interface UpdateRateLimitRuleRequest {
  limitValue?: number;
  windowMs?: number;
  active?: boolean;
  description?: string;
}

export interface RouteCatalogEntry {
  routeId: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  decoratorLimit?: number;
  decoratorWindowMs?: number;
}

export interface RateLimitExplainOffer {
  level: RateLimitLevel;
  limitValue: number;
  windowMs: number;
  ruleId?: string;
  active: boolean;
  winner: boolean;
}

export interface RateLimitExplainResult {
  tenantId: string | null;
  routeKey: string;
  effective: { limitValue: number; windowMs: number } | null;
  level: RateLimitLevel;
  ruleId?: string;
  bucket: 'tenant' | 'ip';
  trace: RateLimitExplainOffer[];
}

/** Human labels for the five levels, in precedence order. */
export const RATE_LIMIT_LEVEL_LABELS: Record<RateLimitLevel, string> = {
  'tenant-route': 'Tenant × route',
  tenant: 'Tenant',
  plan: 'Subscription plan',
  'platform-route': 'Platform route',
  'platform-base': 'Platform base',
};

/** Rank 3 — one subscription plan's rate limit. */
export interface RateLimitPlan {
  id: string;
  plan: 'STARTER' | 'TRIAL' | 'PRO' | 'ENTERPRISE';
  /** Named tier the plan selects when it carries no absolute limit. */
  rateLimitTier: string;
  /** ABSOLUTE requests-per-window; null = use the tier. */
  rateLimitPerMinute?: number | null;
  rateLimitWindowMs?: number | null;
  /** OCC token — echoed back as `expectedVersion`. */
  version: number;
}

export interface SetRateLimitPlanRequest {
  rateLimitTier?: string;
  rateLimitPerMinute?: number | null;
  rateLimitWindowMs?: number | null;
  expectedVersion: number;
}

/**
 * The minimum of a tenant this feature needs to offer a picker.
 *
 * Deliberately re-declared rather than imported from `features/tenants`:
 * features never import each other (`13-nextjs-apps.md` §Structure), and a
 * two-field projection is a smaller price than the coupling.
 */
export interface TenantOption {
  id: string;
  name: string;
}
