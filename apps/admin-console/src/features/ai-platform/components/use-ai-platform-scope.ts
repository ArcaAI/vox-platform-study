'use client';

import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useSession } from '@/shared/auth';
import { SYSTEM_TENANT_ID } from '@/shared/catalog';

export const SCOPE_VALUES = ['system', 'tenant'] as const;
export type AiPlatformScope = (typeof SCOPE_VALUES)[number];

export interface ResolvedAiPlatformScope {
  /** Which tier the screen is currently acting on. */
  scope: AiPlatformScope;
  /** The tenant id every read and write on this screen is parameterised by. */
  tenantId: string;
  /** Human label for the CURRENT scope, for the banner and the footer. */
  label: string;
  /**
   * Human label for the WORKING TENANT, whichever tier is active.
   *
   * Distinct from `label` on purpose: the tier control has to name the tier it
   * would switch TO, and naming it from `label` made the tenant button read
   * "Tenant configuration — Platform default (SYSTEM)" whenever the system tier
   * was the active one — a control describing the state it is leaving.
   */
  workingTenantLabel: string | null;
  /** Whether the SYSTEM tier can be selected at all (elevated callers only). */
  canSelectSystem: boolean;
  /**
   * Why the tenant tier is unavailable, or null when it is available. A control
   * that is disabled without a reason is an affordance without a function
   * (rule 11 §5) — the caller renders this string next to it.
   */
  tenantUnavailableReason: string | null;
  setScope: (next: AiPlatformScope) => void;
  /** True until the session projection has hydrated. */
  isLoading: boolean;
}

/**
 * TENANCY IS A SELECTOR, NOT A ROUTE (TASK-845 step 2).
 *
 * The platform default and a tenant's own configuration are the two tiers of
 * ONE cascade, so splitting them across two screens (`/ai-task-defaults` and
 * `/ai-configuration`) made an administrator navigate to compare a value with
 * the value it overrides. Here the tier is a control on one screen, and it
 * parameterises every read.
 *
 * Two tiers, never three: the SYSTEM tenant is the platform-configuration tier,
 * and the only other option is the caller's OWN tenant scope. The "Global"
 * tenant (`50000000-…`) is a customer tenant — a platform-admin playground —
 * and can only be reached the way any other customer tenant is: by selecting it
 * in the shell's working-tenant switcher. It is never a fallback tier here.
 *
 * Precedence when the URL says nothing: an elevated caller lands on SYSTEM
 * (the tier they administer); a tenant-bound caller lands on, and is pinned to,
 * their own tenant.
 */
export function useAiPlatformScope(): ResolvedAiPlatformScope {
  const session = useSession();
  const elevated = session.data?.effectiveIsElevated ?? false;
  const workingTenantId = session.data?.effectiveTenantId ?? null;
  const workingTenantName = session.data?.workingTenantName ?? null;

  const [raw, setRaw] = useQueryState('scope', parseAsStringLiteral(SCOPE_VALUES).withDefault('system'));

  // A tenant-bound caller has no SYSTEM tier to administer, so the URL cannot
  // put them there — otherwise a shared link would land them on a scope whose
  // every read 403s.
  const scope: AiPlatformScope = elevated ? raw : 'tenant';
  const tenantUnavailableReason = workingTenantId
    ? null
    : 'Select a working tenant in the top bar to configure a tenant’s own providers.';

  const effectiveScope: AiPlatformScope = scope === 'tenant' && !workingTenantId ? 'system' : scope;

  return {
    scope: effectiveScope,
    tenantId: effectiveScope === 'system' ? SYSTEM_TENANT_ID : (workingTenantId ?? SYSTEM_TENANT_ID),
    label: effectiveScope === 'system' ? 'Platform default (SYSTEM)' : (workingTenantName ?? workingTenantId ?? 'Working tenant'),
    workingTenantLabel: workingTenantId ? (workingTenantName ?? workingTenantId) : null,
    canSelectSystem: elevated,
    tenantUnavailableReason,
    setScope: (next) => void setRaw(next === 'system' ? null : next),
    isLoading: session.isLoading,
  };
}
