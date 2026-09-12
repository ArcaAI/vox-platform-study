'use client';

import { useSession } from '@/shared/auth';
import { SYSTEM_TENANT_ID, useTenantNames } from '@/shared/catalog';

/** Which configuration tier the screen is acting on. */
export type ProviderTier = 'platform' | 'tenant';

export interface ResolvedProviderScope {
  /** `platform` = the SYSTEM tier; `tenant` = one customer tenant's own rows. */
  tier: ProviderTier;
  /** The tenant id every read and write on this screen is parameterised by. */
  tenantId: string;
  /** Human label for the current scope — the banner and the footer read it. */
  label: string;
  /**
   * Whether the SESSION is elevated — distinct from `tier`: an elevated admin
   * on the tenant tier is acting on a working tenant it can clear, a tenant
   * admin on the same tier has no other tier to go to (TASK-954). The wording
   * around the scope reads this; the reads and writes never do.
   */
  elevated: boolean;
  /**
   * True until the session has actually ARRIVED — not merely until the query
   * stops reporting `isLoading`.
   *
   * The distinction is load-bearing here in a way it is not on most screens. On
   * the very first paint TanStack has a pending query that is not yet fetching,
   * so `isLoading` is false while `data` is still undefined; read naively, an
   * elevated administrator is momentarily indistinguishable from a tenant-bound
   * one, and this screen would render the whole TENANT view — tenant wording and
   * all — before swapping it out. So absence of data IS the loading state, and a
   * failed read is reported as settled rather than as a permanent skeleton.
   */
  isLoading: boolean;
}

/**
 * THE WORKING TENANT DECIDES THE SCOPE (TASK-932 R-12).
 *
 * WHAT THIS REPLACES, AND WHY. TASK-862 shipped a `?scope=` toggle
 * ("Platform default / ‹tenant›") on this screen, INDEPENDENT of the shell's
 * working-tenant switcher. That made tenancy answerable in two places at once,
 * and they could disagree: an admin with «Sunrise» selected in the top bar could
 * be editing SYSTEM, with the "Acting on «Sunrise»" banner nowhere in sight,
 * and one click away from writing a platform default while believing they were
 * configuring a customer. The owner's ruling (2026-09-09) is that the toggle
 * must not exist — the working tenant already answers "whose configuration am I
 * looking at?", for every screen in the console, and this one is not special.
 *
 * So the rule is a projection of the session, with no state of its own:
 *
 *   elevated + NO working tenant  → the PLATFORM tier (SYSTEM). This is where a
 *                                   platform admin configures the built-in
 *                                   inference services and the weight store.
 *   elevated + a working tenant   → that tenant's own rows, with the
 *                                   "Acting on ‹Tenant›" mutation banner.
 *   not elevated                  → the caller's OWN tenant, always. (TASK-954:
 *                                   `effectiveTenantId` now IS the own tenant
 *                                   for a tenant-bound session; the fallback to
 *                                   `effectiveUser.tenantId` is belt-and-braces
 *                                   for a session projection sealed before it.
 *                                   Before this, a tenant admin fell through to
 *                                   SYSTEM here and every card 403'd.)
 *
 * Two tiers, never three: "Global" (`50000000-…`) is a CUSTOMER tenant — the
 * platform-admin playground — reached the way any other customer tenant is, by
 * selecting it in the switcher. It is never a fallback tier here
 * (`00-project-context.md` §"The two reserved tenants are NOT two config tiers").
 */
export function useProviderScope(): ResolvedProviderScope {
  const session = useSession();
  // The tenant catalog answers "what is this tenant called" for a tenant admin,
  // whose session carries no working-tenant NAME. It never throws: a caller
  // without the list read gets an empty map and the id renders instead.
  const tenantNames = useTenantNames();
  const isLoading = session.data === undefined && !session.isError;
  const elevated = session.data?.effectiveIsElevated ?? false;
  const scopedTenantId = session.data?.effectiveTenantId ?? session.data?.effectiveUser.tenantId ?? null;
  const workingTenantName = session.data?.workingTenantName ?? null;

  // A tenant-bound caller has no platform tier to administer; an elevated one
  // with no tenant selected has nothing BUT the platform tier. Neither is a
  // choice the screen makes.
  const tier: ProviderTier = elevated && !scopedTenantId ? 'platform' : 'tenant';

  if (tier === 'platform') {
    return { tier, tenantId: SYSTEM_TENANT_ID, label: 'Platform (SYSTEM)', elevated, isLoading };
  }

  // `?? SYSTEM` is unreachable in practice — a non-elevated session always
  // carries a tenant — and is written this way rather than as a throw so a
  // half-hydrated session renders the loading state instead of crashing.
  const tenantId = scopedTenantId ?? SYSTEM_TENANT_ID;
  return {
    tier,
    tenantId,
    label: workingTenantName ?? tenantNames.get(tenantId) ?? tenantId,
    elevated,
    isLoading,
  };
}
