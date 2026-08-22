/**
 * Pure entitlement resolution (proposal Q1/Q3).
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
import {
  DEFAULT_TENANT_PLAN,
  ModelTier,
  PLAN_ENTITLEMENT_DEFAULTS,
  PlanEntitlementValues,
  RESERVED_UNGATED_TENANT_IDS,
} from './entitlements.constants';

/** Resolved, fully-merged limits for a tenant. `null` = unlimited/ungated. */
export interface ResolvedLimits {
  maxUsers: number | null;
  maxDepartments: number | null;
  maxPromptTemplates: number | null;
  maxAsrPipelines: number | null;
  maxApiKeys: number | null;
  maxWorkflowDefinitions: number | null;
  storageQuotaBytes: number | null;
  /** Concurrency cap — simultaneous active STT sessions (null = unlimited). */
  maxConcurrentSessions: number | null;
  monthlyConsultations: number | null;
  monthlyTranscriptionMinutes: number | null;
  monthlySummaries: number | null;
  monthlyWorkflowInvocations: number | null;
  /**
   * Per-capability INCLUDED ALLOWANCES, over the same
   * UTC-calendar-month windows as the meters above. `null` = unlimited — the
   * seeded default for every plan today (a commercial ceiling is a product
   * decision, set later through the admin plan matrix). No
   * `monthlyGuardrailCalls`: guardrail is metered but never quota-blocked
   * (D6/D16), so an allowance for it would be a control nothing reads.
   */
  monthlySttSessionSeconds: number | null;
  monthlyLlmTokens: number | null;
  monthlyTtsCharacters: number | null;
  monthlyNlpTextUnits: number | null;
  monthlyEmbeddingTokens: number | null;
}

export interface ResolvedFeatures {
  dnaReports: boolean;
  voiceEnrollment: boolean;
  monitoringAccess: boolean;
  /**
   * May this tenant's provider-credential cascade reach the
   * SYSTEM (platform-funded) tier when it holds no key of its own?
   *
   * The first ENFORCED boolean entitlement in the system: its three neighbours
   * are display-only (read by `getCapabilities`, the SDK and the console, and
   * by nothing that decides anything). This one gates platform SPEND, which is
   * why it is also the only feature that resolves `false` for a null-plan
   * tenant — see {@link UNGATED_ENTITLEMENTS}.
   */
  platformDefaultCredential: boolean;
  /**
   * May this tenant publish an `stt`-palette `WorkflowDefinition` (TASK-724)? Display-only like
   * `dnaReports`/`voiceEnrollment`/`monitoringAccess` — checked once, at
   * `WorkflowDefinitionService.publish()`, never at runtime (an already-published workflow keeps
   * running its compiled `AsrPipeline` even if this flips off later — "in-flight runs pin their
   * version" per design.md's Data Flow section). Deliberately `true` on every seeded plan
   * (TASK-724 decision, `contracts/palette.md` §Entitlement gate): STT pipeline authoring is a
   * core platform capability, not a premium add-on — every plan already gets
   * `maxAsrPipelines > 0`. No DB column backs this yet (`PlanEntitlementInput`/
   * `TenantEntitlementOverrideInput` below simply lack the field) — a follow-up ticket adds one
   * if per-tenant override becomes a real product requirement; until then this always resolves
   * from the seeded default matrix.
   */
  paletteStt: boolean;
  /**
   * TASK-705 — may this tenant run the HARNESS AGENTIC LOOP
   * (`ConsultationLoopWorkflow`: the multi-agent drain, per-agent timeout
   * isolation and adjudication layer that sits above live documentation)?
   *
   * ENFORCED, like `platformDefaultCredential` and unlike the three display-only
   * booleans: `LoopContextSignalService` consults it before every
   * `ContextAdded` / `consultation-ending` / `loop-cancel` signal, so a tenant
   * whose plan does not include it never starts a loop workflow at all.
   *
   * Resolves plan row → seeded `PlanEntitlementValues.featureAgenticLoop` →
   * per-tenant `TenantEntitlement.featureAgenticLoop` override, exactly like its
   * neighbours: `false` on STARTER, `true` on TRIAL/PRO/ENTERPRISE.
   */
  agenticLoop: boolean;
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
  /** TASK-785 — the window paired with an absolute count; `null` = use the tier's. */
  rateLimitWindowMs: number | null;
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
  maxWorkflowDefinitions?: number | null;
  storageQuotaBytes?: number | bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  monthlyWorkflowInvocations?: number | null;
  // DB column type is `BigInt?`, same normalization as storageQuotaBytes.
  monthlySttSessionSeconds?: number | bigint | null;
  monthlyLlmTokens?: number | bigint | null;
  monthlyTtsCharacters?: number | bigint | null;
  monthlyNlpTextUnits?: number | bigint | null;
  monthlyEmbeddingTokens?: number | bigint | null;
  featureDnaReports?: boolean;
  featureVoiceEnrollment?: boolean;
  featureMonitoringAccess?: boolean;
  featurePlatformDefaultCredential?: boolean;
  /** No DB column yet — see `ResolvedFeatures.paletteStt`'s doc comment (TASK-724). Always
   *  `undefined` on a real Prisma row today; kept optional so a future column is a pure addition. */
  featurePaletteStt?: boolean;
  /** TASK-705 — does this plan include the harness agentic loop? */
  featureAgenticLoop?: boolean;
  modelTier?: string;
  rateLimitTier?: string;
  /** TASK-785 — an ABSOLUTE per-plan limit; `null` = express the limit via `rateLimitTier`. */
  rateLimitPerMinute?: number | null;
  rateLimitWindowMs?: number | null;
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
  maxWorkflowDefinitions?: number | null;
  storageQuotaBytes?: number | bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  monthlyWorkflowInvocations?: number | null;
  // Negotiated-allowance override hook (null = inherit the plan default).
  monthlySttSessionSeconds?: number | bigint | null;
  monthlyLlmTokens?: number | bigint | null;
  monthlyTtsCharacters?: number | bigint | null;
  monthlyNlpTextUnits?: number | bigint | null;
  monthlyEmbeddingTokens?: number | bigint | null;
  featureDnaReports?: boolean | null;
  featureVoiceEnrollment?: boolean | null;
  featureMonitoringAccess?: boolean | null;
  featurePlatformDefaultCredential?: boolean | null;
  /** No DB column yet — see `PlanEntitlementInput.featurePaletteStt`. */
  featurePaletteStt?: boolean | null;
  /** TASK-705 — tri-state: `true` grant / `false` deny / `null` inherit the plan. */
  featureAgenticLoop?: boolean | null;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  rateLimitWindowMs?: number | null;
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
    maxWorkflowDefinitions: null,
    storageQuotaBytes: null,
    maxConcurrentSessions: null,
    monthlyConsultations: null,
    monthlyTranscriptionMinutes: null,
    monthlySummaries: null,
    monthlyWorkflowInvocations: null,
    monthlySttSessionSeconds: null,
    monthlyLlmTokens: null,
    monthlyTtsCharacters: null,
    monthlyNlpTextUnits: null,
    monthlyEmbeddingTokens: null,
  },
  /*
   * ⚠ — READ BEFORE "FIXING" THE ASYMMETRY BELOW.
   *
   * Every other boolean here is `true`: a null-plan ("ungated-legacy") tenant
   * is unrestricted by design, and that is the right default for a DISPLAY
   * flag. `platformDefaultCredential` is `false` — deliberately breaking the
   * symmetry — because it is not a display flag: it decides whether the
   * platform spends its OWN money serving a tenant that brought no key.
   *
   * Making it `true` "for consistency" silently grants the platform-default
   * credential to every ungated tenant, which is precisely inverted from the
   * fail-closed gate this exists to be. Pinned by
   * `__tests__/resolve-entitlements.test.ts`.
   */
  /*
   * TASK-705 — `agenticLoop` is `true` here, on the DISPLAY-flag side of the
   * asymmetry above, and deliberately so despite being enforced. A null-plan
   * tenant has no subscription to read an answer out of, and D-A (owner
   * decisions, 2026-08-17) requires the loop ENABLED for day-1 rather than
   * parked behind a flag. The thing it gates is orchestration quality, not
   * platform SPEND — the reason `platformDefaultCredential` must fail closed —
   * and the platform emergency stop remains available either way.
   */
  features: {
    dnaReports: true,
    voiceEnrollment: true,
    monitoringAccess: true,
    platformDefaultCredential: false,
    paletteStt: true,
    agenticLoop: true,
  },
  modelTier: 'full_custom',
  rateLimitTier: 'relaxed',
  rateLimitPerMinute: null,
  rateLimitWindowMs: null,
};

/**
 * The plan a tenant actually resolves against (TASK-785 OD-5).
 *
 * Three rules, in order:
 *   1. An explicitly stamped `Tenant.plan` always wins — on every tenant,
 *      reserved or not. This function changes a DEFAULT, never stated intent.
 *   2. A reserved platform tenant (SYSTEM, Global) with no plan stays `null`,
 *      i.e. ungated. They are not customers; see `RESERVED_UNGATED_TENANT_IDS`.
 *   3. Any other tenant with no plan resolves to `DEFAULT_TENANT_PLAN`
 *      (STARTER) — "no plan" must fail conservative, not generous.
 *
 * Call this at every site that reads `Tenant.plan` before handing it to
 * `resolveEntitlements` / `resolveBillingAllowances`; the resolvers themselves
 * stay pure and keep treating `null` as "ungated".
 */
export function effectivePlan(tenantId: string, plan: TenantPlan | null | undefined): TenantPlan | null {
  if (plan) return plan;
  if (RESERVED_UNGATED_TENANT_IDS.includes(tenantId)) return null;
  return DEFAULT_TENANT_PLAN;
}

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
    maxWorkflowDefinitions: pick(planRow?.maxWorkflowDefinitions, seeded.maxWorkflowDefinitions),
    storageQuotaBytes: pick(toNum(planRow?.storageQuotaBytes), seeded.storageQuotaBytes),
    maxConcurrentSessions: pick(planRow?.maxConcurrentSessions, seeded.maxConcurrentSessions),
    monthlyConsultations: pick(planRow?.monthlyConsultations, seeded.monthlyConsultations),
    monthlyTranscriptionMinutes: pick(planRow?.monthlyTranscriptionMinutes, seeded.monthlyTranscriptionMinutes),
    monthlySummaries: pick(planRow?.monthlySummaries, seeded.monthlySummaries),
    monthlyWorkflowInvocations: pick(planRow?.monthlyWorkflowInvocations, seeded.monthlyWorkflowInvocations),
    monthlySttSessionSeconds: pick(toNum(planRow?.monthlySttSessionSeconds), seeded.monthlySttSessionSeconds),
    monthlyLlmTokens: pick(toNum(planRow?.monthlyLlmTokens), seeded.monthlyLlmTokens),
    monthlyTtsCharacters: pick(toNum(planRow?.monthlyTtsCharacters), seeded.monthlyTtsCharacters),
    monthlyNlpTextUnits: pick(toNum(planRow?.monthlyNlpTextUnits), seeded.monthlyNlpTextUnits),
    monthlyEmbeddingTokens: pick(toNum(planRow?.monthlyEmbeddingTokens), seeded.monthlyEmbeddingTokens),
    featureDnaReports: pick(planRow?.featureDnaReports, seeded.featureDnaReports),
    featureVoiceEnrollment: pick(planRow?.featureVoiceEnrollment, seeded.featureVoiceEnrollment),
    featureMonitoringAccess: pick(planRow?.featureMonitoringAccess, seeded.featureMonitoringAccess),
    featurePlatformDefaultCredential: pick(planRow?.featurePlatformDefaultCredential, seeded.featurePlatformDefaultCredential),
    featurePaletteStt: pick(planRow?.featurePaletteStt, seeded.featurePaletteStt),
    featureAgenticLoop: pick(planRow?.featureAgenticLoop, seeded.featureAgenticLoop),
    modelTier: pick(planRow?.modelTier, seeded.modelTier) as ModelTier,
    rateLimitTier: pick(planRow?.rateLimitTier, seeded.rateLimitTier),
    rateLimitPerMinute: pick(planRow?.rateLimitPerMinute, seeded.rateLimitPerMinute ?? null),
    rateLimitWindowMs: pick(planRow?.rateLimitWindowMs, seeded.rateLimitWindowMs ?? null),
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
      maxWorkflowDefinitions: pick(override?.maxWorkflowDefinitions, base.maxWorkflowDefinitions),
      storageQuotaBytes: pick(toNum(override?.storageQuotaBytes), base.storageQuotaBytes),
      maxConcurrentSessions: pick(override?.maxConcurrentSessions, base.maxConcurrentSessions),
      monthlyConsultations: pick(override?.monthlyConsultations, base.monthlyConsultations),
      monthlyTranscriptionMinutes: pick(override?.monthlyTranscriptionMinutes, base.monthlyTranscriptionMinutes),
      monthlySummaries: pick(override?.monthlySummaries, base.monthlySummaries),
      monthlyWorkflowInvocations: pick(override?.monthlyWorkflowInvocations, base.monthlyWorkflowInvocations),
      monthlySttSessionSeconds: pick(toNum(override?.monthlySttSessionSeconds), base.monthlySttSessionSeconds),
      monthlyLlmTokens: pick(toNum(override?.monthlyLlmTokens), base.monthlyLlmTokens),
      monthlyTtsCharacters: pick(toNum(override?.monthlyTtsCharacters), base.monthlyTtsCharacters),
      monthlyNlpTextUnits: pick(toNum(override?.monthlyNlpTextUnits), base.monthlyNlpTextUnits),
      monthlyEmbeddingTokens: pick(toNum(override?.monthlyEmbeddingTokens), base.monthlyEmbeddingTokens),
    },
    features: {
      dnaReports: pick(override?.featureDnaReports, base.featureDnaReports),
      voiceEnrollment: pick(override?.featureVoiceEnrollment, base.featureVoiceEnrollment),
      monitoringAccess: pick(override?.featureMonitoringAccess, base.featureMonitoringAccess),
      platformDefaultCredential: pick(override?.featurePlatformDefaultCredential, base.featurePlatformDefaultCredential),
      paletteStt: pick(override?.featurePaletteStt, base.featurePaletteStt),
      agenticLoop: pick(override?.featureAgenticLoop, base.featureAgenticLoop),
    },
    modelTier: pick(override?.modelTier, base.modelTier) as ModelTier,
    rateLimitTier: pick(override?.rateLimitTier, base.rateLimitTier),
    // TASK-785: a per-tenant absolute override still wins, but the PLAN may now
    // carry one of its own, so absence of an override falls back to the plan's
    // value rather than straight to null.
    rateLimitPerMinute: pick(toNum(override?.rateLimitPerMinute), toNum(base.rateLimitPerMinute) ?? null),
    rateLimitWindowMs: pick(toNum(override?.rateLimitWindowMs), toNum(base.rateLimitWindowMs) ?? null),
  };
}
