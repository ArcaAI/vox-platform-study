import { RateLimitLevel, RateLimitMatchKindName } from './rate-limit-resolver';

/** One rule as the admin surface sees it. */
export interface RateLimitRuleView {
  id: string;
  tenantId: string;
  /** `true` when `tenantId` is the SYSTEM tenant — a platform-wide rule (rank 4). */
  platform: boolean;
  routeMatch: string;
  matchKind: RateLimitMatchKindName;
  limitValue: number;
  windowMs: number;
  active: boolean;
  description?: string | null;
  /** OCC token — echoed as the ETag and required back as `If-Match` on PATCH. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRateLimitRuleInput {
  /** Omit (or pass the SYSTEM tenant) for a platform-wide rule. */
  tenantId?: string | null;
  routeMatch: string;
  matchKind?: RateLimitMatchKindName;
  limitValue: number;
  windowMs: number;
  active?: boolean;
  description?: string | null;
}

export interface UpdateRateLimitRuleInput {
  limitValue?: number;
  windowMs?: number;
  active?: boolean;
  description?: string | null;
  /** OCC: the version the caller believes it is updating. */
  expectedVersion?: number;
}

export interface ListRateLimitRulesQuery {
  /** Restrict to one scope. Omit for every scope. */
  tenantId?: string | null;
  /** `platform` = SYSTEM-owned rules only; `tenant` = every customer-owned rule. */
  scope?: 'platform' | 'tenant';
}

/** One level's offer in an `explain` trace (AC-8). */
export interface RateLimitExplainOffer {
  level: RateLimitLevel;
  limitValue: number;
  windowMs: number;
  ruleId?: string;
  active: boolean;
  /** `true` for the level that decided. */
  winner: boolean;
}

export interface RateLimitExplainResult {
  tenantId: string | null;
  routeKey: string;
  /** `null` when the winning level exempts the scope. */
  effective: { limitValue: number; windowMs: number } | null;
  level: RateLimitLevel;
  ruleId?: string;
  /**
   * How the counter would be bucketed — the answer to "why do two of my users
   * share a budget?", which is invisible from the limit alone.
   */
  bucket: 'tenant' | 'ip';
  trace: RateLimitExplainOffer[];
}

/**
 * Admin CRUD over `RateLimitRule` rows plus the resolution `explain`.
 *
 * SUPER_ADMIN-only at the HTTP layer (`manage all` + `@ForbidApiKey`), so these
 * methods do not re-derive privilege; they DO enforce tenant existence, the
 * per-scope rule caps, and the "a platform rule may not use `*`" governance
 * rule, none of which the schema can express.
 */
export interface IRateLimitRuleService {
  list(query?: ListRateLimitRulesQuery): Promise<RateLimitRuleView[]>;
  getById(id: string): Promise<RateLimitRuleView>;
  create(input: CreateRateLimitRuleInput): Promise<RateLimitRuleView>;
  update(id: string, input: UpdateRateLimitRuleInput): Promise<RateLimitRuleView>;
  remove(id: string): Promise<void>;
  explain(tenantId: string | null, method: string, path: string): Promise<RateLimitExplainResult>;
}

export const IRateLimitRuleService = Symbol('IRateLimitRuleService');
