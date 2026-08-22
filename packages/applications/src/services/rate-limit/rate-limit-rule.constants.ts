/**
 * Rate-limit RULE constants (TASK-785).
 *
 * Deliberately separate from `rate-limit.constants.ts`, which is the registry
 * of `GlobalSetting` KEYS for the named tier baselines (rank 5). Rules are rows
 * in their own table, not key-value settings, and conflating the two registries
 * is how the `rate-limit.*` / `rateLimit.*` grammar split happened.
 */

import { ALL_ROUTES_PATTERN } from './rate-limit-resolver';

export { ALL_ROUTES_PATTERN };

/**
 * The reserved SYSTEM tenant — a rule owned by it is a PLATFORM rule (rank 4).
 * The SOLE platform-configuration tier (owner ruling 2026-08-20, TASK-763 OD-1);
 * NEVER the GLOBAL/default tenant `50000000-…`, which is a CUSTOMER tenant.
 */
export const RATE_LIMIT_RULE_SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Redis channel for cross-instance rule-cache invalidation.
 *
 * A CHANNEL OF ITS OWN, not `app-settings:invalidate`. Rules are not
 * `GlobalSetting` rows, so riding that channel would make every rule write
 * force a full settings-cache rebuild on every node (and vice versa) — coupling
 * two caches with very different write rates.
 */
export const RATE_LIMIT_RULES_INVALIDATION_CHANNEL = 'rate-limit-rules:invalidate';

/**
 * Hot-path bounds. `bestMatch` is a linear scan over one scope's rules on EVERY
 * request, so the rule count is a latency input, not just a storage concern.
 *
 * Exceeding a cap is a 409 at write time rather than a silent truncation at read
 * time: a dropped rule would read as "all rules applied" while quietly not
 * applying (`09-infrastructure-devops.md` — no silent caps).
 */
export const MAX_RULES_PER_TENANT = 200;
export const MAX_PLATFORM_RULES = 500;

/** Backstop refresh cadence. Invalidation is the propagation path; this is the safety net. */
export const RATE_LIMIT_RULE_CACHE_REFRESH_CRON = '45 * * * * *';
export const RATE_LIMIT_RULE_CACHE_REFRESH_JOB = 'rate-limit-rule-cache-refresh';

/**
 * Build the route key the resolver matches on: `METHOD:/route/pattern`.
 *
 * `path` MUST be the router's registered PATTERN (`/api/v1/tenants/:id`), never
 * a resolved URL — matching on resolved URLs would make both the rule set and
 * the throttler's bucket keys unbounded in cardinality.
 */
export const buildRouteKey = (method: string, path: string): string => `${method.toUpperCase()}:${path}`;
