/**
 * TASK-392 — pure entitlement resolution (proposal Q1/Q3).
 *
 * `resolveEntitlements` is a side-effect-free merge of three layers, in
 * increasing precedence:
 *   1. the seeded in-code default matrix (`PLAN_ENTITLEMENT_DEFAULTS`),
 *   2. the per-plan DB row (`PlanEntitlement`, admin-tunable), and
 *   3. the per-tenant override (`TenantEntitlement`, null field = "inherit").
 *
 * A `null` plan resolves to UNGATED-LEGACY (Q3): unlimited quotas, all features
 * on — the safety net for pre-entitlement tenants and the system tenant.
 *
 * Keeping this pure (no DB, no NestJS) makes the matrix + override precedence
 * exhaustively unit-testable; the `EntitlementsService` supplies the DB rows.
 */

import { TenantPlan } from '@arcaai/domains';
import { ModelTier, PLAN_ENTITLEMENT_DEFAULTS, PlanEntitlementValues } from './entitlements.constants';

/** Resolved, fully-merged limits for a tenant. `null` = unlimited/ungated. */
export interface ResolvedLimits {
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
}

export interface ResolvedFeatures {
  dnaReports: boolean;
  voiceEnrollment: boolean;
  monitoringAccess: boolean;
}

export interface ResolvedEntitlements {
  /** The tenant's plan, or `null` for ungated-legacy tenants. */
  plan: TenantPlan | null;
  /** `false` for a null-plan (ungated-legacy) tenant; `true` otherwise. */
  gated: boolean;
  limits: ResolvedLimits;
  features: ResolvedFeatures;
  modelTier: ModelTier;
  rateLimitTier: string;
  /** Per-tenant absolute rate override (Q7); `null` = use the tier. */
  rateLimitPerMinute: number | null;
}

/**
 * Structural shape of a `PlanEntitlement` DB row (or partial). `storageQuotaBytes`
 * accepts `bigint` because that is how Prisma returns the column.
 */
export interface PlanEntitlementInput {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  storageQuotaBytes?: number | bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports?: boolean;
  featureVoiceEnrollment?: boolean;
  featureMonitoringAccess?: boolean;
  modelTier?: string;
  rateLimitTier?: string;
}

/**
 * Structural shape of a `TenantEntitlement` override row. Every field is
 * nullable and a `null`/`undefined` value means "inherit the plan default".
 */
export interface TenantEntitlementOverrideInput {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  storageQuotaBytes?: number | bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports?: boolean | null;
  featureVoiceEnrollment?: boolean | null;
  featureMonitoringAccess?: boolean | null;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
}

/** Ungated-legacy resolution for a `null` plan (Q3). */
export const UNGATED_ENTITLEMENTS: ResolvedEntitlements = {
  plan: null,
  gated: false,
  limits: {
    maxUsers: null,
    maxDepartments: null,
    maxPromptTemplates: null,
    maxAsrPipelines: null,
    maxApiKeys: null,
    storageQuotaBytes: null,
    maxConcurrentSessions: null,
    monthlyConsultations: null,
    monthlyTranscriptionMinutes: null,
    monthlySummaries: null,
  },
  features: { dnaReports: true, voiceEnrollment: true, monitoringAccess: true },
  modelTier: 'full_custom',
  rateLimitTier: 'relaxed',
  rateLimitPerMinute: null,
};

/** Normalize a `number | bigint | null | undefined` to `number | null`. */
function toNum(v: number | bigint | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Pick the override value when present (non-null), else the base value. */
function pick<T>(override: T | null | undefined, base: T): T {
  return override === null || override === undefined ? base : override;
}

/**
 * Merge the seeded default ← DB plan row ← per-tenant override into a single
 * resolved entitlement set. `planRow`/`override` are both optional; pass what
 * the DB yields.
 */
export function resolveEntitlements(
  plan: TenantPlan | null,
  planRow?: PlanEntitlementInput | null,
  override?: TenantEntitlementOverrideInput | null,
): ResolvedEntitlements {
  // Q3 — no plan means ungated-legacy; overrides are intentionally ignored.
  if (plan === null || plan === undefined) {
    return UNGATED_ENTITLEMENTS;
  }

  const seeded: PlanEntitlementValues = PLAN_ENTITLEMENT_DEFAULTS[plan];

  // Layer 1→2: the DB plan row (if present) overrides the seeded constant.
  const base: PlanEntitlementValues = {
    maxUsers: pick(planRow?.maxUsers, seeded.maxUsers),
    maxDepartments: pick(planRow?.maxDepartments, seeded.maxDepartments),
    maxPromptTemplates: pick(planRow?.maxPromptTemplates, seeded.maxPromptTemplates),
    maxAsrPipelines: pick(planRow?.maxAsrPipelines, seeded.maxAsrPipelines),
    maxApiKeys: pick(planRow?.maxApiKeys, seeded.maxApiKeys),
    storageQuotaBytes: pick(toNum(planRow?.storageQuotaBytes), seeded.storageQuotaBytes),
    maxConcurrentSessions: pick(planRow?.maxConcurrentSessions, seeded.maxConcurrentSessions),
    monthlyConsultations: pick(planRow?.monthlyConsultations, seeded.monthlyConsultations),
    monthlyTranscriptionMinutes: pick(planRow?.monthlyTranscriptionMinutes, seeded.monthlyTranscriptionMinutes),
    monthlySummaries: pick(planRow?.monthlySummaries, seeded.monthlySummaries),
    featureDnaReports: pick(planRow?.featureDnaReports, seeded.featureDnaReports),
    featureVoiceEnrollment: pick(planRow?.featureVoiceEnrollment, seeded.featureVoiceEnrollment),
    featureMonitoringAccess: pick(planRow?.featureMonitoringAccess, seeded.featureMonitoringAccess),
    modelTier: (pick(planRow?.modelTier, seeded.modelTier) as ModelTier),
    rateLimitTier: pick(planRow?.rateLimitTier, seeded.rateLimitTier),
  };

  // Layer 2→3: the per-tenant override (null field = inherit `base`).
  return {
    plan,
    gated: true,
    limits: {
      maxUsers: pick(override?.maxUsers, base.maxUsers),
      maxDepartments: pick(override?.maxDepartments, base.maxDepartments),
      maxPromptTemplates: pick(override?.maxPromptTemplates, base.maxPromptTemplates),
      maxAsrPipelines: pick(override?.maxAsrPipelines, base.maxAsrPipelines),
      maxApiKeys: pick(override?.maxApiKeys, base.maxApiKeys),
      storageQuotaBytes: pick(toNum(override?.storageQuotaBytes), base.storageQuotaBytes),
      maxConcurrentSessions: pick(override?.maxConcurrentSessions, base.maxConcurrentSessions),
      monthlyConsultations: pick(override?.monthlyConsultations, base.monthlyConsultations),
      monthlyTranscriptionMinutes: pick(override?.monthlyTranscriptionMinutes, base.monthlyTranscriptionMinutes),
      monthlySummaries: pick(override?.monthlySummaries, base.monthlySummaries),
    },
    features: {
      dnaReports: pick(override?.featureDnaReports, base.featureDnaReports),
      voiceEnrollment: pick(override?.featureVoiceEnrollment, base.featureVoiceEnrollment),
      monitoringAccess: pick(override?.featureMonitoringAccess, base.featureMonitoringAccess),
    },
    modelTier: (pick(override?.modelTier, base.modelTier) as ModelTier),
    rateLimitTier: pick(override?.rateLimitTier, base.rateLimitTier),
    rateLimitPerMinute: toNum(override?.rateLimitPerMinute),
  };
}
