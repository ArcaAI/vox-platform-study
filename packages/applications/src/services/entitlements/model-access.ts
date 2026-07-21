/**
 * Plan → model-catalog clone-subset.
 *
 * Pure helpers (no DB/DI) so the clone-subset decision is unit-testable and
 * usable directly from `TenantService.provisionTenantModelCatalog` WITHOUT
 * importing the request-scoped `EntitlementsService` (which would create a
 * module cycle — the entitlements module already imports the tenant module).
 *
 * The subset is expressed with a `tier:<base|full|full_custom>` tag convention
 * on `AiModel.tags`: a model requires the HIGHEST tier it is tagged with, and
 * is cloned into a tenant only when the tenant's plan tier meets that bar.
 * Models with NO `tier:*` tag require `base`, so they clone into every tier —
 * a catalog with no tier tags (today's seed) clones in full (non-breaking).
 */
import { TenantPlan } from '@arcaai/domains';
import { ModelTier, PLAN_ENTITLEMENT_DEFAULTS, isModelTier } from './entitlements.constants';

const TIER_RANK: Record<ModelTier, number> = { base: 0, full: 1, full_custom: 2 };
const TIER_TAG_PREFIX = 'tier:';

/**
 * The model tier a plan grants (from the seeded default matrix). A `null` plan
 * (ungated-legacy / system tenant, Q3) gets the full catalog.
 */
export function modelTierForPlan(plan: TenantPlan | null | undefined): ModelTier {
  if (!plan) return 'full_custom';
  return PLAN_ENTITLEMENT_DEFAULTS[plan].modelTier;
}

/**
 * Q8 clone-subset predicate: is a model (by its tags) available to `tenantTier`?
 * The model's required tier is the highest `tier:<t>` tag it carries (default
 * `base` when untagged); available iff `rank(tenantTier) >= rank(required)`.
 */
export function modelAllowedForTier(tags: string[] | null | undefined, tenantTier: ModelTier): boolean {
  const required = (tags ?? [])
    .filter((t) => t.toLowerCase().startsWith(TIER_TAG_PREFIX))
    .map((t) => t.slice(TIER_TAG_PREFIX.length).toLowerCase())
    .filter((t): t is ModelTier => isModelTier(t))
    .reduce((max, t) => Math.max(max, TIER_RANK[t]), TIER_RANK.base);

  return TIER_RANK[tenantTier] >= required;
}
