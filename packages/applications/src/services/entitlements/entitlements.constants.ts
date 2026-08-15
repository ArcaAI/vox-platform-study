/**
 * Plan entitlements: constants, the seeded default matrix, and the
 * global kill-switch key.
 *
 * Mirrors the `rate-limit.constants.ts` registry: every entitlement knob and
 * the enforcement kill-switch is declared here so the resolver, the service,
 * the admin API, and the seed all reference the same literals. The concrete
 * numbers are the PROPOSED starting matrix (/ Q2) — DB-backed and
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
 *
 * `SysEventService.handleEntitlementsQuotaBlockedEvent`
 * (`../sysEvent/sysEvent.service.ts`) is that subscriber.
 */
export const ENTITLEMENTS_QUOTA_BLOCKED_EVENT = 'entitlements.quota-blocked';

/**
 * The payload `assertQuantityQuota` / `assertMeterQuota` / `assertConcurrencyQuota`
 * emit on {@link ENTITLEMENTS_QUOTA_BLOCKED_EVENT}. Deliberately NOT a `SysEvent`
 * (no `id`, no `resourceType`) — it is a narrower, purpose-built shape that
 * predates the sys-event pipeline gaining a listener for it; the consumer
 * adapts it into an `AuditLogJob` itself rather than forcing the emit sites to
 * construct a full `SysEvent`.
 */
export interface QuotaBlockedEvent {
  tenantId: string;
  /** `EntitlementLimitKey | MeterCapabilityKey | 'maxConcurrentSessions'` — kept as `string` so this type has no dependency on `enforcement.ts`. */
  capability: string;
  limit: number | null;
  used: number;
  requested: number;
  at: Date;
  /** The user whose request triggered the block, when known (CLS-scoped calls only; absent for a background/system caller). */
  responsibleEntityId?: string;
}

/**
 * Domain event emitted when a storage upload crosses the tenant quota (Q6).
 * SOFT-WARN only — the upload proceeds; this is a telemetry/notification signal,
 * NOT a block. Subscribers surface it (banner/audit) in later phases.
 */
export const ENTITLEMENTS_STORAGE_WARN_EVENT = 'entitlements.storage-warn';

/**
 * Prometheus counter incremented every time a meter quota check is SKIPPED
 * because the live metering read failed (`assertMeterQuota`'s fail-open).
 *
 * A fail-open is invisible by construction — the clinician's request succeeds
 * either way — so without this counter "metering has been down for six hours
 * and nothing is being checked" is indistinguishable from "nobody is over
 * quota". The ERROR log says *why* a single skip happened; this says *whether,
 * and how often*, which is the question an alert rule can ask.
 *
 * Labelled by `capability` ONLY. `tenantId` is deliberately NOT a label — it is
 * unbounded cardinality (`09-infrastructure-devops.md`); the tenant is in the
 * log line, where it belongs.
 */
export const ENTITLEMENTS_METER_SKIPPED_METRIC = 'entitlements_meter_check_skipped_total';

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
 * The per-plan default matrix. `null` = unlimited/ungated for
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
   * Per-capability included allowances, derived in
   * from each plan's ratified business ceilings and then DOUBLED:
   *
   *   sttSessionSeconds = transcriptionMinutes × 60 × 1.1
   *   llmTokens         = summaries          × 6,000
   *   ttsCharacters     = consultations      × 2,000
   *   nlpTextUnits      = consultations      ×    30
   *   embeddingTokens   = consultations      × 1,500
   *
   * The ×2 headroom is deliberate — `monthlyConsultations` is the commercial
   * cap, so these are RUNAWAY GUARDS, not a second business ceiling. `null` =
   * unlimited (ENTERPRISE only, negotiated per contract).
   */
  monthlySttSessionSeconds: number | null;
  monthlyLlmTokens: number | null;
  monthlyTtsCharacters: number | null;
  monthlyNlpTextUnits: number | null;
  monthlyEmbeddingTokens: number | null;
  featureDnaReports: boolean;
  featureVoiceEnrollment: boolean;
  featureMonitoringAccess: boolean;
  /**
   * May this plan's tenants consume the PLATFORM-DEFAULT
   * (SYSTEM-tenant) provider credential when they hold no key of their own?
   *
   * Unlike its three neighbours this flag is ENFORCED, not display-only: it
   * decides whether the provider-credential cascade reaches the SYSTEM tier,
   * i.e. whether the platform spends its own money serving this tenant.
   *
   * `false` on all four plans (OD-7). A plan-level grant on PRO or ENTERPRISE
   * would hand every tenant on that tier a platform-funded cloud path — the
   * margin hole closed when it ratified "SYSTEM stays self-hosted,
   * managed cloud is a paid add-on". Grants are per tenant, through
   * `TenantEntitlement`, which is also how ENTERPRISE is actually sold.
   */
  featurePlatformDefaultCredential: boolean;
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
  // RATIFIED 2026-08-08: PRO = $100/mo bundling 250 consultations.
  monthlyConsultations: 250,
  monthlyTranscriptionMinutes: 5_000, // 250 × 20-min average
  monthlySummaries: 250,
  monthlySttSessionSeconds: 660_000,
  monthlyLlmTokens: 3_000_000,
  monthlyTtsCharacters: 1_000_000,
  monthlyNlpTextUnits: 15_000,
  monthlyEmbeddingTokens: 750_000,
  featureDnaReports: true,
  featureVoiceEnrollment: true,
  featureMonitoringAccess: false,
  featurePlatformDefaultCredential: false,
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
    // RATIFIED 2026-08-08: STARTER = $50/mo bundling 50 consultations.
    monthlyConsultations: 50,
    monthlyTranscriptionMinutes: 1_000, // 50 × 20-min average
    monthlySummaries: 50,
    monthlySttSessionSeconds: 132_000,
    monthlyLlmTokens: 600_000,
    monthlyTtsCharacters: 200_000,
    monthlyNlpTextUnits: 3_000,
    monthlyEmbeddingTokens: 150_000,
    featureDnaReports: false,
    featureVoiceEnrollment: false,
    featureMonitoringAccess: false,
    featurePlatformDefaultCredential: false,
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
    // RATIFIED 2026-08-08: ENTERPRISE is NEGOTIATED — usage
    // unlimited by default; structural caps stay finite on purpose.
    monthlyConsultations: null,
    monthlyTranscriptionMinutes: null,
    monthlySummaries: null,
    monthlySttSessionSeconds: null,
    monthlyLlmTokens: null,
    monthlyTtsCharacters: null,
    monthlyNlpTextUnits: null,
    monthlyEmbeddingTokens: null,
    featureDnaReports: true,
    featureVoiceEnrollment: true,
    featureMonitoringAccess: true,
    featurePlatformDefaultCredential: false,
    modelTier: 'full_custom',
    rateLimitTier: 'relaxed',
  },
};
