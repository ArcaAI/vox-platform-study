/**
 * @arcaai/vox — useEntitlements Hook
 *
 * Front-end contract for the DB-backed plan-entitlements system:
 *   - global-admin: kill-switch, plan-matrix CRUD, per-tenant override + snapshot,
 *     explicit downgrade, manual trial-expiry sweep (`/admin/entitlements/*`);
 *   - tenant self-view: capability/usage snapshot (`/entitlements/me`).
 *
 * Mirrors `useApiKeys`/`useGlobalSettings`: composes `useApiOperation` for
 * loading/error, holds the platform matrix + kill-switch in local state for the
 * matrix editor, and fetches per-tenant snapshots/overrides on demand. Plan and
 * override edits echo the `version` back as `expectedVersion` (OCC → 412 on
 * drift; the client lifts `currentVersion` onto `AgenticError.context`).
 */

import { useCallback, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { ENTITLEMENTS_ENDPOINTS } from '../core/constants';

/** Commercial plan tiers (mirrors `TenantPlan` in @arcaai/domains). */
export type EntitlementPlan = 'ENTERPRISE' | 'PRO' | 'TRIAL' | 'STARTER';

/** Trial-clock snapshot for the countdown/expiry banner (Q4). */
export interface TrialInfo {
  isTrial: boolean;
  trialEndsAt?: string | null;
  daysRemaining?: number | null;
  expired: boolean;
}

/** One resolved capability with its live usage (proposal). */
export interface CapabilityUsageRow {
  key: string;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  unlimited: boolean;
  nearLimit: boolean;
  exceeded: boolean;
}

export interface ResolvedFeatures {
  dnaReports: boolean;
  voiceEnrollment: boolean;
  monitoringAccess: boolean;
}

/** Read-only capability/usage snapshot (`GET /admin/entitlements/tenants/:id` and `/entitlements/me`). */
export interface EntitlementCapabilities {
  tenantId: string;
  plan?: EntitlementPlan | null;
  gated: boolean;
  enforcementEnabled: boolean;
  quantities: CapabilityUsageRow[];
  meters: CapabilityUsageRow[];
  features: ResolvedFeatures;
  modelTier: string;
  rateLimitTier: string;
  rateLimitPerMinute?: number | null;
  trial: TrialInfo;
}

/** A per-plan default-matrix row (`version` is the OCC token). */
export interface PlanEntitlement {
  id: string;
  plan: EntitlementPlan;
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  maxConcurrentSessions?: number | null;
  storageQuotaBytes?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports: boolean;
  featureVoiceEnrollment: boolean;
  featureMonitoringAccess: boolean;
  modelTier: string;
  rateLimitTier: string;
  version: number;
}

/** Global-admin edit of a plan row; only supplied fields change. `expectedVersion` REQUIRED (412 on drift). */
export interface UpdatePlanEntitlementInput {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  maxConcurrentSessions?: number | null;
  storageQuotaBytes?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports?: boolean;
  featureVoiceEnrollment?: boolean;
  featureMonitoringAccess?: boolean;
  modelTier?: string;
  rateLimitTier?: string;
  expectedVersion: number;
}

/** A per-tenant override row; every limit field `null` = inherit the plan default. */
export interface TenantEntitlementOverride {
  id: string;
  tenantId: string;
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  maxConcurrentSessions?: number | null;
  storageQuotaBytes?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports?: boolean | null;
  featureVoiceEnrollment?: boolean | null;
  featureMonitoringAccess?: boolean | null;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  version: number;
}

/** Create-or-update a per-tenant override ("increase on demand", Q7). `expectedVersion` REQUIRED only when updating. */
export interface UpsertTenantOverrideInput {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  maxConcurrentSessions?: number | null;
  storageQuotaBytes?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports?: boolean | null;
  featureVoiceEnrollment?: boolean | null;
  featureMonitoringAccess?: boolean | null;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  expectedVersion?: number;
}

/** Per-capability record of what a downgrade soft-disabled (Q10 newest-first). */
export interface DowngradeDisabledGroup {
  capability: string;
  resourceType: string;
  limit: number | null;
  disabledCount: number;
  ids: string[];
}

export interface DowngradeReport {
  tenantId: string;
  fromPlan: EntitlementPlan | null;
  toPlan: EntitlementPlan;
  enforcementEnabled: boolean;
  disabled: DowngradeDisabledGroup[];
  totalDisabled: number;
}

export interface TrialExpiryReport {
  examined: number;
  downgraded: number;
  tenantIds: string[];
}

export interface UseEntitlementsReturn {
  /** Platform matrix (populated by `listPlans`). */
  plans: PlanEntitlement[];
  /** Kill-switch state (populated by `getEnabled`/`setEnabled`); undefined until read. */
  enabled?: boolean;
  isLoading: boolean;
  error: Error | null;

  // Kill-switch (Q9)
  getEnabled: () => Promise<boolean>;
  setEnabled: (enabled: boolean) => Promise<boolean>;

  // Plan-matrix CRUD (Q1)
  listPlans: () => Promise<PlanEntitlement[]>;
  getPlan: (plan: string) => Promise<PlanEntitlement>;
  updatePlan: (plan: string, input: UpdatePlanEntitlementInput) => Promise<PlanEntitlement>;

  // Per-tenant override (Q1/Q7) + snapshot
  getTenantSnapshot: (tenantId: string) => Promise<EntitlementCapabilities>;
  getOverride: (tenantId: string) => Promise<TenantEntitlementOverride | null>;
  upsertOverride: (tenantId: string, input: UpsertTenantOverrideInput) => Promise<TenantEntitlementOverride>;
  clearOverride: (tenantId: string) => Promise<void>;

  // Lifecycle (Q4/Q10)
  triggerDowngrade: (tenantId: string, plan: EntitlementPlan) => Promise<DowngradeReport>;
  runTrialExpiry: () => Promise<TrialExpiryReport>;

  // Tenant self-view
  me: () => Promise<EntitlementCapabilities>;
}

export function useEntitlements(): UseEntitlementsReturn {
  const { execute, isLoading, error } = useApiOperation('useEntitlements');
  const [plans, setPlans] = useState<PlanEntitlement[]>([]);
  const [enabled, setEnabledState] = useState<boolean | undefined>(undefined);

  const getEnabled = useCallback(
    () =>
      execute<boolean>('getEnabled', async (client) => {
        const res = await client.get<{ enabled: boolean }>(ENTITLEMENTS_ENDPOINTS.ENABLED);
        setEnabledState(res.enabled);
        return res.enabled;
      }),
    [execute],
  );

  const setEnabled = useCallback(
    (next: boolean) =>
      execute<boolean>('setEnabled', async (client) => {
        const res = await client.put<{ enabled: boolean }>(ENTITLEMENTS_ENDPOINTS.ENABLED, { enabled: next });
        setEnabledState(res.enabled);
        return res.enabled;
      }),
    [execute],
  );

  const listPlans = useCallback(
    () =>
      execute<PlanEntitlement[]>('listPlans', async (client) => {
        const rows = await client.get<PlanEntitlement[]>(ENTITLEMENTS_ENDPOINTS.PLANS);
        setPlans(rows);
        return rows;
      }),
    [execute],
  );

  const getPlan = useCallback(
    (plan: string) => execute<PlanEntitlement>('getPlan', (client) => client.get<PlanEntitlement>(ENTITLEMENTS_ENDPOINTS.PLAN(plan))),
    [execute],
  );

  const updatePlan = useCallback(
    (plan: string, input: UpdatePlanEntitlementInput) =>
      execute<PlanEntitlement>('updatePlan', async (client) => {
        const updated = await client.patch<PlanEntitlement>(ENTITLEMENTS_ENDPOINTS.PLAN(plan), input);
        setPlans((prev) => prev.map((p) => (p.plan === updated.plan ? updated : p)));
        return updated;
      }),
    [execute],
  );

  const getTenantSnapshot = useCallback(
    (tenantId: string) =>
      execute<EntitlementCapabilities>('getTenantSnapshot', (client) =>
        client.get<EntitlementCapabilities>(ENTITLEMENTS_ENDPOINTS.TENANT_SNAPSHOT(tenantId)),
      ),
    [execute],
  );

  const getOverride = useCallback(
    (tenantId: string) =>
      execute<TenantEntitlementOverride | null>('getOverride', (client) =>
        client.get<TenantEntitlementOverride | null>(ENTITLEMENTS_ENDPOINTS.TENANT_OVERRIDE(tenantId)),
      ),
    [execute],
  );

  const upsertOverride = useCallback(
    (tenantId: string, input: UpsertTenantOverrideInput) =>
      execute<TenantEntitlementOverride>('upsertOverride', (client) =>
        client.put<TenantEntitlementOverride>(ENTITLEMENTS_ENDPOINTS.TENANT_OVERRIDE(tenantId), input),
      ),
    [execute],
  );

  const clearOverride = useCallback(
    (tenantId: string) =>
      execute<void>('clearOverride', async (client) => {
        await client.delete(ENTITLEMENTS_ENDPOINTS.TENANT_OVERRIDE(tenantId));
      }),
    [execute],
  );

  const triggerDowngrade = useCallback(
    (tenantId: string, plan: EntitlementPlan) =>
      execute<DowngradeReport>('triggerDowngrade', (client) =>
        client.post<DowngradeReport>(ENTITLEMENTS_ENDPOINTS.TENANT_DOWNGRADE(tenantId), { plan }),
      ),
    [execute],
  );

  const runTrialExpiry = useCallback(
    () =>
      execute<TrialExpiryReport>('runTrialExpiry', (client) => client.post<TrialExpiryReport>(ENTITLEMENTS_ENDPOINTS.TRIAL_EXPIRY_RUN, undefined)),
    [execute],
  );

  const me = useCallback(
    () => execute<EntitlementCapabilities>('me', (client) => client.get<EntitlementCapabilities>(ENTITLEMENTS_ENDPOINTS.ME)),
    [execute],
  );

  return {
    plans,
    enabled,
    isLoading,
    error,
    getEnabled,
    setEnabled,
    listPlans,
    getPlan,
    updatePlan,
    getTenantSnapshot,
    getOverride,
    upsertOverride,
    clearOverride,
    triggerDowngrade,
    runTrialExpiry,
    me,
  };
}
