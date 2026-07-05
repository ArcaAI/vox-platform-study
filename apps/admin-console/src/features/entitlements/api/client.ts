/** Entitlements administration (capabilities-matrix row 4). GLOBAL_ADMIN only. */

import { deleteJson, getJson, patchJson, postJson, putJson } from '@/shared/api';
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

/** OCC via body expectedVersion (no If-Match on this route) — 412 on drift. */
export function updatePlanEntitlement(plan: TenantPlan, body: UpdatePlanEntitlementRequest): Promise<PlanEntitlement> {
    return patchJson(`${BASE}/plans/${plan}`, body);
}

/** Effective capabilities (plan + override merge, usage, trial). */
export function getTenantEntitlements(tenantId: string): Promise<EntitlementCapabilities> {
    return getJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}`);
}

export function getTenantOverride(tenantId: string): Promise<TenantEntitlement | null> {
    return getJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}/override`);
}

/** Upsert — pass expectedVersion only when a row already exists. */
export function upsertTenantOverride(tenantId: string, body: UpsertTenantEntitlementRequest): Promise<TenantEntitlement> {
    return putJson(`${BASE}/tenants/${encodeURIComponent(tenantId)}/override`, body);
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
