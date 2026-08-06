/**
 * Plan entitlements: constants, the seeded default matrix, and the
 * global kill-switch key.
 *
 * Mirrors the `rate-limit.constants.ts` registry: every entitlement knob and
 * the enforcement kill-switch is declared here so the resolver, the service,
 * the admin API, and the seed all reference the same literals. The concrete
 * numbers are the PROPOSED starting matrix (proposal §2 / Q2) — DB-backed and
 * tunable, with enforcement OFF by default (Q9), so exactness is not blocking.
 */

import { TenantPlan } from '@arcaai/domains';

/** Namespace stamped on every entitlements `GlobalSetting` row. */
export const ENTITLEMENTS_NAMESPACE = 'entitlements';

/**
 * Platform tenant that owns the single authoritative kill-switch row. Matches
 * `RATE_LIMIT_TENANT_ID` / the seed `SEED_TENANT_ID` — one platform row keeps
 * the flat `AppSettingsService` cache lookup deterministic.
 */
export const ENTITLEMENTS_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/** `GlobalSetting` key for the enforcement kill-switch. */
export const entitlementsEnabledKey = (): string => `${ENTITLEMENTS_NAMESPACE}.enabled`;

/**
 * Domain event emitted whenever a quota precheck BLOCKS a create/submit (Q10).
 * A named event (not a `SysEventType`) keeps the audit/websocket wiring a
 * Phase-4 concern; subscribers can persist it to `AuditLog` there.
 */
export const ENTITLEMENTS_QUOTA_BLOCKED_EVENT = 'entitlements.quota-blocked';

/**
 * Domain event emitted when a storage upload crosses the tenant quota (Q6).
 * SOFT-WARN only — the upload proceeds; this is a telemetry/notification signal,
 * NOT a block. Subscribers surface it (banner/audit) in later phases.
 */
export const ENTITLEMENTS_STORAGE_WARN_EVENT = 'entitlements.storage-warn';

/**
 * Enforcement ships OFF by default (proposal Q9). Until an operator flips
 * `entitlements.enabled` to `true` per-env, every quota/feature check is a
 * no-op — so a partial landing of this epic is safe.
 */
export const ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT = false;

/** Model-access tiers driving the clone-subset at tenant create (Q8). */
export type ModelTier = 'base' | 'full' | 'full_custom';
export const MODEL_TIERS: readonly ModelTier[] = ['base', 'full', 'full_custom'] as const;
export const isModelTier = (v: string): v is ModelTier => (MODEL_TIERS as readonly string[]).includes(v);

/** 1 GiB in bytes — storage quotas are expressed in GiB in the matrix. */
export const GIB = 1024 ** 3;

/**
 * The per-plan default matrix (proposal §2). `null` = unlimited/ungated for
 * that dimension. These are the seeded `PlanEntitlement` row values AND the
 * in-code fallback the resolver uses when a DB row is missing.
 */
export interface PlanEntitlementValues {
  maxUsers: number | null;
  maxDepartments: number | null;
  maxPromptTemplates: number | null;
  maxAsrPipelines: number | null;
  maxApiKeys: number | null;
  storageQuotaBytes: number | null;
  /** Concurrency cap — simultaneous active STT sessions (null = unlimited). */
  maxConcurrentSessions: number | null;
  monthlyConsultations: number | null;
  monthlyTranscriptionMinutes: number | null;
  monthlySummaries: number | null;
  /**
   * Per-capability included allowances (TASK-615 D11). `null` = unlimited —
   * every plan seeds NULL today; a commercial ceiling is set later through
   * the admin plan matrix, once shadow metering has run a full cycle.
   */
  monthlySttSessionSeconds: number | null;
  monthlyLlmTokens: number | null;
  monthlyTtsCharacters: number | null;
  monthlyNlpTextUnits: number | null;
  monthlyEmbeddingTokens: number | null;
  featureDnaReports: boolean;
  featureVoiceEnrollment: boolean;
  featureMonitoringAccess: boolean;
  modelTier: ModelTier;
  rateLimitTier: string;
}

/** PRO baseline — reused verbatim for TRIAL (Q4: trial = 1-week PRO experience). */
const PRO_VALUES: PlanEntitlementValues = {
  maxUsers: 25,
  maxDepartments: 10,
  maxPromptTemplates: 50,
  maxAsrPipelines: 5,
  maxApiKeys: 10,
  storageQuotaBytes: 100 * GIB,
  // PRO/TRIAL ≈ 25 concurrent doctors (anchored to the seat cap).
  maxConcurrentSessions: 25,
  monthlyConsultations: 5_000,
  monthlyTranscriptionMinutes: 12_000,
  monthlySummaries: 5_000,
  monthlySttSessionSeconds: null,
  monthlyLlmTokens: null,
  monthlyTtsCharacters: null,
  monthlyNlpTextUnits: null,
  monthlyEmbeddingTokens: null,
  featureDnaReports: true,
  featureVoiceEnrollment: true,
  featureMonitoringAccess: false,
  modelTier: 'full',
  rateLimitTier: 'default',
};

export const PLAN_ENTITLEMENT_DEFAULTS: Record<TenantPlan, PlanEntitlementValues> = {
  STARTER: {
    maxUsers: 5,
    maxDepartments: 2,
    maxPromptTemplates: 10,
    maxAsrPipelines: 1,
    maxApiKeys: 2,
    storageQuotaBytes: 5 * GIB,
    // STARTER ≈ 5 concurrent doctors.
    maxConcurrentSessions: 5,
    monthlyConsultations: 500,
    monthlyTranscriptionMinutes: 1_000,
    monthlySummaries: 500,
    monthlySttSessionSeconds: null,
    monthlyLlmTokens: null,
    monthlyTtsCharacters: null,
    monthlyNlpTextUnits: null,
    monthlyEmbeddingTokens: null,
    featureDnaReports: false,
    featureVoiceEnrollment: false,
    featureMonitoringAccess: false,
    modelTier: 'base',
    rateLimitTier: 'strict',
  },
  TRIAL: { ...PRO_VALUES },
  PRO: { ...PRO_VALUES },
  ENTERPRISE: {
    maxUsers: 100,
    maxDepartments: 40,
    maxPromptTemplates: 300,
    maxAsrPipelines: 20,
    maxApiKeys: 50,
    storageQuotaBytes: 1_000 * GIB,
    // ENTERPRISE ≈ 100 concurrent doctors.
    maxConcurrentSessions: 100,
    monthlyConsultations: 50_000,
    monthlyTranscriptionMinutes: 120_000,
    monthlySummaries: 50_000,
    monthlySttSessionSeconds: null,
    monthlyLlmTokens: null,
    monthlyTtsCharacters: null,
    monthlyNlpTextUnits: null,
    monthlyEmbeddingTokens: null,
    featureDnaReports: true,
    featureVoiceEnrollment: true,
    featureMonitoringAccess: true,
    modelTier: 'full_custom',
    rateLimitTier: 'relaxed',
  },
};
