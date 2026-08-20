/** Entitlements administration (capabilities-matrix row 4). SUPER_ADMIN only. */

import { deleteJson, getJson, patchWithEtag, postJson, putJson, putWithEtag } from '@/shared/api';
import type { TenantPlan } from '@/features/tenants/api/types';
import type {
  DowngradeReport,
  EntitlementCapabilities,
  EntitlementsEnabled,
  PlanEntitlement,
  TenantEntitlement,
  TrialExpiryReport,
  UpdatePlanEntitlementRequest,
  UpsertTenantEntitlementRequest,
} from './types';

const BASE = 'admin/entitlements';

export function getEnforcementEnabled(): Promise<EntitlementsEnabled> {
  return getJson(`${BASE}/enabled`);
}

/** Platform-wide enforcement kill-switch. */
export function setEnforcementEnabled(enabled: boolean): Promise<EntitlementsEnabled> {
  return putJson(`${BASE}/enabled`, { enabled });
}

export function listPlanEntitlements(): Promise<PlanEntitlement[]> {
  return getJson(`${BASE}/plans`);
}

export function getPlanEntitlement(plan: TenantPlan): Promise<PlanEntitlement> {
  return getJson(`${BASE}/plans/${plan}`);
}

/**
 * OCC: `If-Match` is REQUIRED on this route. The validator is the version the
 * caller read from the plan row and already carries in `body.expectedVersion`
 * (the header overrides the body server-side); drift is 412, and a missing
 * header would be 428.
 */
export async function updatePlanEntitlement(plan: TenantPlan, body: UpdatePlanEntitlementRequest): Promise<PlanEntitlement> {
  return (await patchWithEtag<PlanEntitlement>(`${BASE}/plans/${plan}`, body, `"${body.expectedVersion}"`)).data;
}

/** Effective capabilities (plan + override merge, usage, trial). */
export function getTenantEntitlements(tenantId: string): Promise<EntitlementCapabilities> {
  return getJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}`);
}

export async function getTenantOverride(tenantId: string): Promise<TenantEntitlement | null> {
  return (await getJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}/override`)) ?? null;
}

/**
 * Upsert — `If-Match` is REQUIRED. On an existing row the caller passes the
 * version it read as `body.expectedVersion`; with no row the override GET
 * answered `null` (no ETag to echo), so the call carries the create-intent
 * validator `"0"`, which the gateway accepts for a first write and rejects
 * (412) against a row that already exists.
 */
export async function upsertTenantOverride(tenantId: string, body: UpsertTenantEntitlementRequest): Promise<TenantEntitlement> {
  return (
    await putWithEtag<TenantEntitlement>(`${BASE}/tenants/${encodeURIComponent(tenantId)}/override`, body, `"${body.expectedVersion ?? 0}"`)
  ).data;
}

export function clearTenantOverride(tenantId: string): Promise<{ cleared: true }> {
  return deleteJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}/override`);
}

export function triggerDowngrade(tenantId: string, plan: TenantPlan): Promise<DowngradeReport> {
  return postJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}/downgrade`, { plan });
}

export function runTrialExpiry(): Promise<TrialExpiryReport> {
  return postJson(`${BASE}/trial-expiry/run`);
}
