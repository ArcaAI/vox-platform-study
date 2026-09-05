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
 * Platform tenant that owns the single authoritative kill-switch row. The
 * SYSTEM tenant is the SOLE platform-configuration tier (owner ruling
 * 2026-08-20) — matches `RATE_LIMIT_TENANT_ID` and
 * `PLATFORM_TENANT_IDS` in `AppSettingsService` / `SettingsRegistryWriteService`,
 * and the seed's `SYSTEM_TENANT_ID`. One platform row keeps the flat
 * `AppSettingsService` cache lookup deterministic. NEVER the GLOBAL/default
 * tenant (`50000000-…`) — that id is a CUSTOMER tenant, never a runtime tier.
 */
export const ENTITLEMENTS_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The GLOBAL/default tenant (`50000000-…`). A CUSTOMER tenant used by platform
 * admins as a playground to trial configuration before promoting it into
 * SYSTEM — never a configuration tier, and deliberately absent from every
 * runtime cascade (`00-project-context.md` §"The two reserved tenants are NOT
 * two config tiers").
 *
 * It is named here for ONE purpose: {@link RESERVED_UNGATED_TENANT_IDS}.
 */
export const ENTITLEMENTS_GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/**
 * Tenants that never receive the {@link DEFAULT_TENANT_PLAN} fallback.
 *
 * SYSTEM is a configuration TIER, not a customer — metering it is meaningless.
 * Global is the platform-admin playground; putting it on STARTER would cap the
 * playground at 10 req/min with the agentic loop off, which is exactly the
 * surface a platform admin uses to trial configuration.
 *
 * This list governs the DEFAULT only. An explicitly stamped `Tenant.plan` is
 * always honoured, on these tenants as on any other — see {@link effectivePlan}.
 */
export const RESERVED_UNGATED_TENANT_IDS: readonly string[] = [ENTITLEMENTS_TENANT_ID, ENTITLEMENTS_GLOBAL_TENANT_ID] as const;

/**
 * The plan a CUSTOMER tenant resolves against when `Tenant.plan` is NULL
 * (owner decision 2026-08-22).
 *
 * Previously a NULL plan resolved to `UNGATED_ENTITLEMENTS`: unlimited quotas
 * and `rateLimitTier: 'relaxed'` (300/min) — i.e. an unknown, unbilled tenant
 * was granted MORE than a paying PRO customer and more than the 100/min platform
 * default. Defaulting to the lowest paid plan makes "no plan" fail conservative
 * instead of fail generous.
 *
 * This REVERSES the NULL-plan half of, which had SYSTEM and Global
 * keep `plan = null` specifically to resolve ungated. That intent survives —
 * it is now carried by {@link RESERVED_UNGATED_TENANT_IDS} rather than by the
 * absence of a plan, so it no longer leaks to unknown customer tenants.
 */
export const DEFAULT_TENANT_PLAN: TenantPlan = TenantPlan.STARTER;

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
 * Enforcement ships ON by default (owner decision 2026-08-22;
 * supersedes proposal Q9's "OFF until an operator flips it per-env", which was
 * the safe posture while the epic was landing in pieces — it has since landed).
 *
 * This constant is only the fallback used when the `entitlements.enabled`
 * `GlobalSetting` row is ABSENT. The seeded row is what actually decides a live
 * environment (`seed/15-entitlements.ts`), and an operator flip via
 * `PUT /admin/entitlements/enabled` always wins over both. Flipping this to
 * `true` matters for exactly one case — a database that was never seeded — where
 * the old value silently granted unlimited quota to every tenant.
 */
export const ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT = true;

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
  /** @deprecated TASK-861 — removed in R4. Ceiling on the retired `AsrPipeline` rows; the Agent ceiling (`maxAgents`) is TASK-863's key and this stays its placeholder alias until it lands. */
  maxAsrPipelines: number | null;
  maxApiKeys: number | null;
  /** Quantity ceiling on PUBLISHED WorkflowDefinition slugs ( exposure plane). */
  maxWorkflowDefinitions: number | null;
  storageQuotaBytes: number | null;
  /** Concurrency cap — simultaneous active STT sessions (null = unlimited). */
  maxConcurrentSessions: number | null;
  monthlyConsultations: number | null;
  monthlyTranscriptionMinutes: number | null;
  monthlySummaries: number | null;
  /** Fourth business-object meter — PUBLISHED-workflow invocations via `/api/v1/workflows/:slug/invoke`. */
  monthlyWorkflowInvocations: number | null;
  /**
   * Per-capability included allowances, derived in
   * from each plan's ratified business ceilings and then DOUBLED:
   *
   *   sttSessionSeconds = transcriptionMinutes × 60 × 1.1
   *   llmTokens = summaries × 6,000
   *   ttsCharacters = consultations × 2,000
   *   nlpTextUnits = consultations × 30
   *   embeddingTokens = consultations × 1,500
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
  /**
   * May this plan's tenants consume the PLATFORM-DEFAULT
   * (SYSTEM-tenant) provider credential when they hold no key of their own?
   *
   * ENFORCED — like every flag left on this interface, since TASK-883 retired
   * the three display-only booleans that used to sit above it. It decides
   * whether the provider-credential cascade reaches the SYSTEM tier,
   * i.e. whether the platform spends its own money serving this tenant.
   *
   * `false` on all four plans. A plan-level grant on PRO or ENTERPRISE
   * would hand every tenant on that tier a platform-funded cloud path — the
   * margin hole closed when it ratified "SYSTEM stays self-hosted,
   * managed cloud is a paid add-on". Grants are per tenant, through
   * `TenantEntitlement`, which is also how ENTERPRISE is actually sold.
   */
  featurePlatformDefaultCredential: boolean;
  /**
   * May this plan's tenants publish an `stt`-palette `WorkflowDefinition` ?
   * Checked once at publish time, never at runtime — `true` on every plan below: STT
   * pipeline authoring is a core platform capability, not a premium add-on.
   */
  featurePaletteStt: boolean;
  /**
   * may this plan's tenants run the HARNESS AGENTIC LOOP?
   *
   * The owner ruling (`docs/programs/agentic-workflow-platform/owner-decisions-2026-08-17.md`
   * row 705): *"harness agentic loop is one of the core business, so, lets treat
   * it as a feature in subscription plan"*. Loop eligibility is therefore
   * COMMERCIAL — a plan property resolved from the database — and no longer an
   * environment kill-switch. The operational device survives as a separate,
   * subtract-only emergency stop (`harness.loop.emergencyStop`); see
   * `../consultation/consultation-gates.constants.ts`.
   *
   * ENFORCING, unlike its display-only neighbours: `LoopContextSignalService`
   * resolves it on every signal.
   *
   * THE SPLIT IS A PRODUCT DECISION, NOT A TECHNICAL ONE. STARTER (the $50 entry
   * tier, 50 consultations/month) does not include multi-agent loop orchestration;
   * TRIAL mirrors PRO (Q4: trial = a 1-week PRO experience) so an evaluating
   * customer sees the capability that sells the platform.
   */
  featureAgenticLoop: boolean;
  modelTier: ModelTier;
  rateLimitTier: string;
  /**
   * an ABSOLUTE per-plan rate limit. Optional and unset across the
   * seeded matrix on purpose: every seeded plan still expresses its limit
   * INDIRECTLY, by naming a `rateLimitTier`. These exist so a super admin can
   * price a plan's throughput directly without minting a new named tier.
   */
  rateLimitPerMinute?: number | null;
  rateLimitWindowMs?: number | null;
}

/** PRO baseline — reused verbatim for TRIAL (Q4: trial = 1-week PRO experience). */
const PRO_VALUES: PlanEntitlementValues = {
  maxUsers: 25,
  maxDepartments: 10,
  maxPromptTemplates: 50,
  maxAsrPipelines: 5,
  maxApiKeys: 10,
  maxWorkflowDefinitions: 5,
  storageQuotaBytes: 100 * GIB,
  // PRO/TRIAL ≈ 25 concurrent doctors (anchored to the seat cap).
  maxConcurrentSessions: 25,
  // RATIFIED 2026-08-08: PRO = $100/mo bundling 250 consultations.
  monthlyConsultations: 250,
  monthlyTranscriptionMinutes: 5_000, // 250 × 20-min average
  monthlySummaries: 250,
  // Same ceiling as monthlyConsultations — one workflow invocation per
  // consultation is the starting assumption (D-tunable; enforcement OFF by
  // default, so exactness is not blocking — see the file header).
  monthlyWorkflowInvocations: 250,
  monthlySttSessionSeconds: 660_000,
  monthlyLlmTokens: 3_000_000,
  monthlyTtsCharacters: 1_000_000,
  monthlyNlpTextUnits: 15_000,
  monthlyEmbeddingTokens: 750_000,
  featurePlatformDefaultCredential: false,
  featurePaletteStt: true,
  featureAgenticLoop: true,
  modelTier: 'full',
  rateLimitTier: 'default',
};

export const PLAN_ENTITLEMENT_DEFAULTS: Record<TenantPlan, PlanEntitlementValues> = {
  STARTER: {
    maxUsers: 5,
    // (owner decision 2026-08-22): these two are STRUCTURAL floors, not
    // commercial ones, and they are sized to what tenant creation actually
    // provisions — 8 golden departments (`seed/04-department.ts`) and the 14
    // SYSTEM pipelines `provisionTenantPipelineCatalog` clones. They were 2 and 1,
    // which meant every new tenant landed 4x and 14x OVER its own caps the moment
    // OD-5 stopped resolving plan-less tenants as ungated. Provisioning writes
    // through the repository so creation never failed — but the tenant could not
    // then add anything, and its capability snapshot read `exceeded` on day one.
    //
    // Sized to EXACTLY the provisioned catalog, deliberately: STARTER gets the
    // standard set and no room to add its own, which is a price-ladder statement
    // (upgrade to customise) rather than an accident. The commercial caps below
    // (50 consultations/month, 5 users) are untouched.
    maxDepartments: 8,
    maxPromptTemplates: 10,
    maxAsrPipelines: 14,
    maxApiKeys: 2,
    maxWorkflowDefinitions: 1,
    storageQuotaBytes: 5 * GIB,
    // STARTER ≈ 5 concurrent doctors.
    maxConcurrentSessions: 5,
    // RATIFIED 2026-08-08: STARTER = $50/mo bundling 50 consultations.
    monthlyConsultations: 50,
    monthlyTranscriptionMinutes: 1_000, // 50 × 20-min average
    monthlySummaries: 50,
    monthlyWorkflowInvocations: 50,
    monthlySttSessionSeconds: 132_000,
    monthlyLlmTokens: 600_000,
    monthlyTtsCharacters: 200_000,
    monthlyNlpTextUnits: 3_000,
    monthlyEmbeddingTokens: 150_000,
    featurePlatformDefaultCredential: false,
    featurePaletteStt: true,
    featureAgenticLoop: false,
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
    maxWorkflowDefinitions: 20,
    storageQuotaBytes: 1_000 * GIB,
    // ENTERPRISE ≈ 100 concurrent doctors.
    maxConcurrentSessions: 100,
    // RATIFIED 2026-08-08: ENTERPRISE is NEGOTIATED — usage
    // unlimited by default; structural caps stay finite on purpose.
    monthlyConsultations: null,
    monthlyTranscriptionMinutes: null,
    monthlySummaries: null,
    monthlyWorkflowInvocations: null,
    monthlySttSessionSeconds: null,
    monthlyLlmTokens: null,
    monthlyTtsCharacters: null,
    monthlyNlpTextUnits: null,
    monthlyEmbeddingTokens: null,
    featurePlatformDefaultCredential: false,
    featurePaletteStt: true,
    featureAgenticLoop: true,
    modelTier: 'full_custom',
    rateLimitTier: 'relaxed',
  },
};
