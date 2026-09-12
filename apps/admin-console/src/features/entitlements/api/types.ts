import type { TenantPlan } from '@/features/tenants/api/types';

export interface EntitlementsEnabled {
  enabled: boolean;
}

/** Numeric limits shared by plan defaults and tenant overrides (null = unlimited). */
interface EntitlementLimits {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  /** @deprecated TASK-861 — removed in R4 with audio pipelines. */
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  maxWorkflowDefinitions?: number | null;
  maxAiProviderConnections?: number | null;
  storageQuotaBytes?: number | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  monthlyWorkflowInvocations?: number | null;
}

/** GET /admin/entitlements/plans rows (PlanEntitlementResponse). */
export interface PlanEntitlement extends EntitlementLimits {
  id: string;
  plan: TenantPlan;
  modelTier: string;
  rateLimitTier: string;
  version: number;
}

/** PATCH /admin/entitlements/plans/:plan — OCC via body expectedVersion only. */
export interface UpdatePlanEntitlementRequest extends EntitlementLimits {
  modelTier?: string;
  rateLimitTier?: string;
  expectedVersion: number;
}

/** GET /admin/entitlements/tenants/:tenantId (and GET /tenants/me/entitlements). */
export interface EntitlementCapabilities {
  tenantId: string;
  plan?: TenantPlan | null;
  gated: boolean;
  enforcementEnabled: boolean;
  quantities: CapabilityUsageRow[];
  meters: CapabilityUsageRow[];
  /** Resolved feature capabilities. Enforcing flags only since TASK-883. */
  features: Record<string, boolean>;
  modelTier: string;
  rateLimitTier: string;
  rateLimitPerMinute?: number | null;
  trial: TrialInfo;
}

export interface CapabilityUsageRow {
  key: string;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  unlimited: boolean;
  nearLimit: boolean;
  exceeded: boolean;
}

export interface TrialInfo {
  isTrial: boolean;
  trialEndsAt?: string | null;
  daysRemaining?: number | null;
  expired: boolean;
}

/** GET/PUT /admin/entitlements/tenants/:tenantId/override (nullable feature tri-state). */
export interface TenantEntitlement extends EntitlementLimits {
  id: string;
  tenantId: string;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  version: number;
}

export interface UpsertTenantEntitlementRequest extends EntitlementLimits {
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  /** Required only when updating an existing override row. */
  expectedVersion?: number;
}

/** POST /admin/entitlements/tenants/:tenantId/downgrade result. */
export interface DowngradeReport {
  tenantId: string;
  fromPlan: TenantPlan | null;
  toPlan: TenantPlan;
  enforcementEnabled: boolean;
  disabled: DowngradeDisabledGroup[];
  totalDisabled: number;
}

export interface DowngradeDisabledGroup {
  capability: string;
  resourceType: string;
  limit: number | null;
  disabledCount: number;
  ids: string[];
}

/** POST /admin/entitlements/trial-expiry/run result. */
export interface TrialExpiryReport {
  examined: number;
  downgraded: number;
  tenantIds: string[];
}
