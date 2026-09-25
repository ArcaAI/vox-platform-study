import type { TenantPlan } from '@/features/tenants/api/types';

export interface EntitlementsEnabled {
  enabled: boolean;
}

/** Numeric limits shared by plan defaults and tenant overrides (null = unlimited). */
interface EntitlementLimits {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxApiKeys?: number | null;
  /** Max PUBLISHED workflow definitions. */
  maxWorkflowDefinitions?: number | null;
  /** Max AI provider connections per tenant, across every service. */
  maxAiProviderConnections?: number | null;
  storageQuotaBytes?: number | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  /** Monthly PUBLISHED-workflow invocations. */
  monthlyWorkflowInvocations?: number | null;
  monthlySttSessionSeconds?: number | null;
  /** Monthly LLM tokens, every billable kind summed. */
  monthlyLlmTokens?: number | null;
  /** Monthly TTS characters, counted as Unicode code points. */
  monthlyTtsCharacters?: number | null;
  monthlyNlpTextUnits?: number | null;
  monthlyEmbeddingTokens?: number | null;
}

/**
 * TASK-998 OD-4 — per-provider cloud-ASR capacity, keyed by provider id
 * (`azure-speech` | `azure-foundry` | `sarvam` | `openai`, i.e. exactly
 * `CLOUD_BYO_PROVIDERS.stt` on the gateway).
 *
 * Deliberately NOT part of {@link EntitlementLimits}: everything in there is a
 * scalar `number | null` the plan form renders as a numeric input, while this is
 * a map with two dimensions per provider. Folding it in would break that form's
 * one assumption.
 *
 * Two dimensions, because the vendor enforces two different things:
 *  - `requestsPerMinute` — the sync-REST cap; bounds BATCH transcription.
 *  - `maxConcurrentStreams` — the concurrent-WebSocket cap; bounds LIVE sessions.
 *
 * An absent provider, an absent dimension or a null value means "no opinion at
 * this tier"; unresolved at both tiers = unlimited (not enforced).
 */
export type SttProviderQuotas = Record<string, { requestsPerMinute?: number | null; maxConcurrentStreams?: number | null }>;

/** GET /admin/entitlements/plans rows (PlanEntitlementResponse). */
export interface PlanEntitlement extends EntitlementLimits {
  id: string;
  plan: TenantPlan;
  modelTier: string;
  rateLimitTier: string;
  /** TASK-998 OD-4 — the PLATFORM DEFAULT cloud-ASR capacity for this plan. */
  sttProviderQuotas?: SttProviderQuotas | null;
  /** TASK-998 OD-4 — may a tenant on this plan hold its own allocation ("Pro and above")? */
  featureProviderQuotaAllocation?: boolean;
  version: number;
}

/** PATCH /admin/entitlements/plans/:plan — OCC via body expectedVersion only. */
export interface UpdatePlanEntitlementRequest extends EntitlementLimits {
  modelTier?: string;
  rateLimitTier?: string;
  /** TASK-998 OD-4 — null clears every platform default (back to unlimited). */
  sttProviderQuotas?: SttProviderQuotas | null;
  featureProviderQuotaAllocation?: boolean;
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
  /** TASK-998 OD-4 — this tenant's OWN allocation; null = inherit the platform default. */
  sttProviderQuotas?: SttProviderQuotas | null;
  version: number;
}

export interface UpsertTenantEntitlementRequest extends EntitlementLimits {
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  /**
   * TASK-998 OD-4 — requires a plan carrying `featureProviderQuotaAllocation`
   * ("Pro and above"), otherwise the gateway answers 403. Clearing (null / {})
   * is always allowed and returns the tenant to the platform default.
   */
  sttProviderQuotas?: SttProviderQuotas | null;
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
