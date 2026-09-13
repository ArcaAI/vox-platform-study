import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Counter } from 'prom-client';
import { ClsService } from 'nestjs-cls';
import { QuotaExceededException } from '@arcaai/exceptions';
import {
  AiProviderConnectionRepository,
  ApiKeyRepository,
  EntityId,
  PlanEntitlementEntity,
  PlanEntitlementRepository,
  ResourceType,
  SysEventType,
  TenantEntitlementEntity,
  TenantEntitlementFactory,
  TenantEntitlementRepository,
  ResourceStatusType,
  TenantPlan,
  TenantRepository,
  ValueType,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IMetricsService } from '../baseServices/metrics/IMetricsService';
import { IGlobalSettingService } from '../globalSetting/IGlobalSettingService';
import { ITenantService } from '../tenant/ITenantService';
import { IMeteringService, MeterUsage } from '../metering/IMeteringService';
import { ISocketRegistryService } from '../platform-metrics/socket-registry.service';
import { EntitlementFeatureKey, IEntitlementsService, StorageSoftWarn, TenantRateLimitPolicy } from './IEntitlementsService';
import { ResolvedEntitlements, effectivePlan, resolveEntitlements } from './resolve-entitlements';
import { buildCapabilityRow, computeTrialInfo } from './capability';
import { EntitlementLimitKey, MeterCapabilityKey, wouldExceedLimit } from './enforcement';
import { ENTITLEMENTS_QUOTA_BLOCKED_EVENT, ENTITLEMENTS_STORAGE_WARN_EVENT } from './entitlements.constants';
import {
  ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT,
  ENTITLEMENTS_METER_SKIPPED_METRIC,
  ENTITLEMENTS_NAMESPACE,
  ENTITLEMENTS_TENANT_ID,
  entitlementsEnabledKey,
} from './entitlements.constants';
import {
  EntitlementCapabilitiesResponse,
  PlanEntitlementResponse,
  TenantEntitlementResponse,
  UpdatePlanEntitlementRequest,
  UpsertTenantEntitlementRequest,
} from './dto';

/**
 * DB-backed plan-entitlements service.
 *
 * Resolution reads the seeded `PlanEntitlement` matrix and the per-tenant
 * `TenantEntitlement` override off the core repositories and merges them via
 * the pure `resolveEntitlements` (seeded constant → plan row → tenant
 * override). A `null`-plan tenant resolves to ungated-legacy (Q3), so the
 * system tenant and any pre-entitlement tenant is never gated.
 *
 * The enforcement kill-switch (`entitlements.enabled`) mirrors the
 * `rate-limit.enabled` pattern exactly: reads are O(1) off the
 * `AppSettingsService` cache; writes go through `IGlobalSettingService` and
 * force a cache refresh. Ships OFF (Q9) so display-only mode is inert.
 */
/**
 * TTL for the per-tenant rate-limit policy cache. The throttler
 * consults this on EVERY default-tier request, so we cache the resolved plan
 * tier + override for a short window instead of re-reading three DB rows per
 * request. A tier change propagates within this window (rate-limit tiers are
 * rarely retuned, so a few seconds of staleness is acceptable).
 */
const RATE_LIMIT_POLICY_TTL_MS = 30_000;

/** `bigint | null | undefined` DB column → `number | null` response field (same conversion `storageQuotaBytes` already uses). */
function toAllowanceNumber(value: bigint | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * `MeterCapabilityKey` → the `MeterUsage` field it reads. Replaces a chained
 * ternary as the capability set grew from 3 to 8: a map keeps
 * `assertMeterQuota` a flat, exhaustively-typed lookup instead of an
 * if/else-if ladder, and `Record<MeterCapabilityKey, ...>` means TypeScript
 * itself refuses to compile if a capability is ever added to the union
 * without a matching entry here.
 */
const METER_USAGE_FIELD_BY_CAPABILITY: Record<MeterCapabilityKey, (usage: MeterUsage) => number> = {
  monthlyConsultations: (u) => u.consultations,
  monthlyTranscriptionMinutes: (u) => u.transcriptionMinutes,
  monthlySummaries: (u) => u.summaries,
  monthlyWorkflowInvocations: (u) => u.workflowInvocations,
  monthlySttSessionSeconds: (u) => u.sttSessionSeconds,
  monthlyLlmTokens: (u) => u.llmTokens,
  monthlyTtsCharacters: (u) => u.ttsCharacters,
  monthlyNlpTextUnits: (u) => u.nlpTextUnits,
  monthlyEmbeddingTokens: (u) => u.embeddingTokens,
};

@Injectable()
export class EntitlementsService extends BaseService implements IEntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  /** Per-tenant rate-limit policy cache (short TTL, hot path). */
  private readonly rateLimitPolicyCache = new Map<string, { value: TenantRateLimitPolicy | null; expiresAt: number }>();

  /**
   * Counts meter checks skipped because the metering read failed. `null` when
   * no metrics service is wired, or when registering the counter itself failed
   * — observability of a fail-open must never become a second failure mode.
   */
  private readonly meterSkippedCounter: Counter<string> | null;

  constructor(
    private readonly tenantRepository: TenantRepository,
    private readonly planEntitlementRepository: PlanEntitlementRepository,
    private readonly tenantEntitlementRepository: TenantEntitlementRepository,
    private readonly apiKeyRepository: ApiKeyRepository,
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly aiProviderConnectionRepository: AiProviderConnectionRepository,
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    @Inject(IMeteringService)
    private readonly metering: IMeteringService,
    @Inject(IAppSettingsService)
    private readonly appSettings: IAppSettingsService,
    @Inject(IGlobalSettingService)
    private readonly globalSettings: IGlobalSettingService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // (concurrency) — live per-tenant open-socket count for the
    // simultaneous-session gate + display. Optional/best-effort: the gate
    // fails OPEN (0) if the registry (Redis) is unavailable so an infra blip
    // never wrongly rejects a session.
    @Optional()
    @Inject(ISocketRegistryService)
    private readonly socketRegistry?: ISocketRegistryService,
    // Fail-open observability for `assertMeterQuota` (see
    // {@link ENTITLEMENTS_METER_SKIPPED_METRIC}). Optional for the same reason
    // `socketRegistry` is: this is a signal ABOUT the path, never a
    // precondition FOR it.
    @Optional()
    @Inject(IMetricsService)
    metrics?: IMetricsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Tenant);
    this.meterSkippedCounter = this.registerMeterSkippedCounter(metrics);
  }

  /** Register the fail-open counter once, tolerating any metrics-layer failure. */
  private registerMeterSkippedCounter(metrics?: IMetricsService): Counter<string> | null {
    if (!metrics) return null;
    try {
      return metrics.createCounter({
        name: ENTITLEMENTS_METER_SKIPPED_METRIC,
        help: 'Meter quota checks skipped because the live metering read failed (fail-open). Non-zero means usage is NOT being enforced.',
        labelNames: ['capability'],
      });
    } catch (err) {
      this.logger.warn({
        message: 'Could not register the meter-skip counter — fail-open events will only be visible in logs',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // --- Kill-switch (Q9) --------------------------------------------------

  isEnforcementEnabled(): boolean {
    return this.appSettings.getValueWithDefault<boolean>(entitlementsEnabledKey(), ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT);
  }

  async setEnforcementEnabled(enabled: boolean): Promise<boolean> {
    await this.writeSetting(entitlementsEnabledKey(), String(Boolean(enabled)), ValueType.Boolean, 'Entitlements enforcement global kill-switch');
    return this.isEnforcementEnabled();
  }

  // --- Resolution + display ---------------------------------------------

  async resolveForTenant(tenantId: EntityId): Promise<ResolvedEntitlements> {
    const tenant = await this.tenantRepository.findById(tenantId);
    // a plan-less CUSTOMER tenant resolves STARTER, not ungated.
    // Reserved platform tenants (SYSTEM, Global) still resolve `null`.
    const plan = effectivePlan(tenantId, tenant.plan as TenantPlan | null | undefined);

    const planRow = plan ? await this.planEntitlementRepository.findByPlan(plan) : null;
    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);

    return resolveEntitlements(plan, planRow, override);
  }

  async getCapabilities(tenantId: EntityId): Promise<EntitlementCapabilitiesResponse> {
    const tenant = await this.tenantRepository.findById(tenantId);
    // a plan-less CUSTOMER tenant resolves STARTER, not ungated.
    // Reserved platform tenants (SYSTEM, Global) still resolve `null`.
    const plan = effectivePlan(tenantId, tenant.plan as TenantPlan | null | undefined);

    const planRow = plan ? await this.planEntitlementRepository.findByPlan(plan) : null;
    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);
    const resolved = resolveEntitlements(plan, planRow, override);

    const usage = await this.tenantService.getUsageStats(tenantId);
    const apiKeyCount = await this.apiKeyRepository.count({ where: { tenantId } });
    // Live rolling-monthly meter usage (current UTC
    // month window). Authoritative + near-realtime; independent of the
    // reconcile job, so the meters are populated even with the job off.
    const meterUsage = await this.metering.getCurrentUsage(tenantId);
    // (concurrency) — live simultaneous active STT sessions for this
    // tenant across all instances (best-effort; 0 if the registry is absent).
    const activeConcurrent = await this.getActiveConcurrency(tenantId);
    // Both counts MUST be the query the matching precheck runs, or the row
    // contradicts the gate: a tenant shown "3 / 5" would still be refused at 3.
    // Workflow definitions: `workflowDefinitionRepository.count({ tenantId })`,
    // every version row, exactly as `WorkflowDefinitionService` counts before
    // `assertQuantityQuota`.
    const workflowDefinitionCount = await this.workflowDefinitionRepository.count({ where: { tenantId } });
    // Provider connections: ENABLED rows only, across every service —
    // `AiProviderConnectionService.countTenantConnections` sums
    // `findByTenantIdAndService`, which filters `resourceStatus: ENABLED`. A
    // DISABLED row is a per-provider veto, not a consumed slot, so counting it
    // here would invent usage the gate does not see.
    const aiProviderConnectionCount = await this.aiProviderConnectionRepository.count({
      where: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
    });

    const quantities = [
      buildCapabilityRow('users', resolved.limits.maxUsers, usage.totalUsers),
      buildCapabilityRow('departments', resolved.limits.maxDepartments, usage.totalDepartments),
      buildCapabilityRow('promptTemplates', resolved.limits.maxPromptTemplates, usage.totalPromptTemplates),
      // @deprecated TASK-861 — removed in R4 with `AsrPipeline` (the agent ceiling replaces it, TASK-863).
      buildCapabilityRow('asrPipelines', resolved.limits.maxAsrPipelines, usage.totalPipelines),
      buildCapabilityRow('apiKeys', resolved.limits.maxApiKeys, apiKeyCount),
      buildCapabilityRow('workflowDefinitions', resolved.limits.maxWorkflowDefinitions, workflowDefinitionCount),
      buildCapabilityRow('aiProviderConnections', resolved.limits.maxAiProviderConnections, aiProviderConnectionCount),
      buildCapabilityRow('storageBytes', resolved.limits.storageQuotaBytes, usage.storageUsedBytes),
      // Concurrency is a point-in-time quantity (live sessions vs. cap), not a
      // rolling meter — surfaced alongside the other quantity capabilities.
      buildCapabilityRow('concurrentSessions', resolved.limits.maxConcurrentSessions, activeConcurrent),
    ];

    const meters = [
      buildCapabilityRow('monthlyConsultations', resolved.limits.monthlyConsultations, meterUsage.consultations),
      buildCapabilityRow('monthlyTranscriptionMinutes', resolved.limits.monthlyTranscriptionMinutes, meterUsage.transcriptionMinutes),
      buildCapabilityRow('monthlySummaries', resolved.limits.monthlySummaries, meterUsage.summaries),
      buildCapabilityRow('monthlyWorkflowInvocations', resolved.limits.monthlyWorkflowInvocations, meterUsage.workflowInvocations),
      // The five ledger-derived unit-allowance meters.
      buildCapabilityRow('monthlySttSessionSeconds', resolved.limits.monthlySttSessionSeconds, meterUsage.sttSessionSeconds),
      buildCapabilityRow('monthlyLlmTokens', resolved.limits.monthlyLlmTokens, meterUsage.llmTokens),
      buildCapabilityRow('monthlyTtsCharacters', resolved.limits.monthlyTtsCharacters, meterUsage.ttsCharacters),
      buildCapabilityRow('monthlyNlpTextUnits', resolved.limits.monthlyNlpTextUnits, meterUsage.nlpTextUnits),
      buildCapabilityRow('monthlyEmbeddingTokens', resolved.limits.monthlyEmbeddingTokens, meterUsage.embeddingTokens),
      // GUARDRAIL_CALLS — informational only. There is no allowance column
      // (D6/D16: guardrail is metered but never quota-blocked), so `limit` is
      // always `null` here — passing it through `buildCapabilityRow` still
      // gives the right `unlimited: true` / `exceeded: false` shape for free.
      buildCapabilityRow('guardrailCalls', null, meterUsage.guardrailCalls),
    ];

    return {
      tenantId,
      plan,
      gated: resolved.gated,
      enforcementEnabled: this.isEnforcementEnabled(),
      quantities,
      meters,
      features: resolved.features,
      modelTier: resolved.modelTier,
      rateLimitTier: resolved.rateLimitTier,
      rateLimitPerMinute: resolved.rateLimitPerMinute,
      trial: computeTrialInfo(plan, tenant.trialEndsAt ?? null),
    };
  }

  /**
   * The first ENFORCING read of a boolean entitlement.
   *
   * The three pre-existing feature booleans are display-only: nothing but
   * `getCapabilities`, the SDK's `useEntitlements` and the console reads them.
   * `featurePlatformDefaultCredential` is different — it decides whether a
   * tenant's provider-credential cascade may reach the SYSTEM (platform-funded)
   * tier, so something has to actually consult it.
   *
   * Two properties this method must keep:
   *
   *   1. NON-THROWING (contract note on `IEntitlementsService`). The caller is
   *      shaping a cascade before a provider is selected; a throw here would
   *      403 requests that were never going to need the platform credential.
   *   2. It HONOURS the kill switch , returning early exactly like
   *      `assertQuantityQuota:215` and its three siblings. For a boolean read,
   *      their "return without enforcing" is `true` — the feature is ungated.
   *      So with `entitlements.enabled` OFF the platform-default gate is INERT
   *      and every tenant reaches the SYSTEM tier. That is the accepted cost of
   *      keeping one master switch an operator can pull in an incident; the
   *      containment comes back the moment the switch is on.
   */
  async isFeatureEnabled(tenantId: EntityId, feature: EntitlementFeatureKey): Promise<boolean> {
    if (!this.isEnforcementEnabled()) return true;

    const resolved = await this.resolveForTenant(tenantId);
    return resolved.features[feature];
  }

  // --- Enforcement primitive (Q9 gate + Q10 block-new) ------------------

  async assertQuantityQuota(tenantId: EntityId, capability: EntitlementLimitKey, currentCount: number, increment = 1): Promise<void> {
    // Q9 — enforcement ships OFF; every check is inert until the kill-switch is
    // flipped per-env. This is the single gate that makes a partial landing safe.
    if (!this.isEnforcementEnabled()) return;

    const resolved = await this.resolveForTenant(tenantId);
    this.enforceLimit(tenantId, capability, resolved.limits[capability], currentCount, increment);
  }

  /**
   * The shared Q10 "block-new" decision: emit the audit event and throw the
   * typed error when `increment` more would exceed `limit`; otherwise return.
   *
   * Extracted so `assertMeterQuota` can resolve the limit BEFORE it decides
   * whether the meter is even worth reading, without either re-resolving the
   * tenant (three more DB reads on a clinical hot path) or duplicating the
   * block/throw. Pure decision — no I/O, no kill-switch read; both callers have
   * already made those.
   */
  private enforceLimit(tenantId: EntityId, capability: EntitlementLimitKey, limit: number | null, used: number, increment: number): void {
    // Unlimited/ungated (null limit, incl. null-plan legacy + system tenant, Q3).
    if (!wouldExceedLimit(limit, used, increment)) return;

    // Q10 — block the NEW action only; existing resources are grandfathered.
    // Emit an audit event (subscribers persist it), then throw the
    // typed error the API maps to 409/429.
    // `responsibleEntityId` (from CLS, when a request is in
    // flight) lets the sys-event consumer author the resulting audit-log row
    // instead of leaving it authorless; a background/system caller with no
    // CLS user emits `undefined`, same as `broadcastSysEvent` already tolerates.
    this.eventEmitter.emit(ENTITLEMENTS_QUOTA_BLOCKED_EVENT, {
      tenantId,
      capability,
      limit,
      used,
      requested: increment,
      at: new Date(),
      responsibleEntityId: this.requestUserId ?? undefined,
    });

    throw new QuotaExceededException(
      `Plan limit reached for '${capability}' (${used}/${limit}). Existing items are unaffected — raise the plan or per-tenant override to add more.`,
      { capability, limit: limit as number, used, requested: increment, tenantId },
    );
  }

  // --- Meter enforcement (Q5, → 429) ------------------------------------

  /**
   * **Billing must never take down the clinical path.**
   *
   * This assertion fronts consultation create, summary generation,
   * transcription-job submit and every TTS request. Its inputs are a resolved
   * limit and a live metering aggregate — and the aggregate is by far the most
   * fragile of the two: six `AiUsageRollupDaily` aggregates plus a raw-ledger
   * scan, none of it wrapped, in tables that a schema drift or a connection
   * squeeze can take out independently of everything else. Propagating that
   * failure turns a billing outage into a platform-wide 500 on the core
   * clinical workflow. So it does not propagate: the check is SKIPPED, loudly.
   *
   * Two ordering/containment decisions make that safe:
   *
   *   1. The RESOLVED LIMIT is read first, and an unlimited (`null`) allowance
   *      returns before the meter is touched at all. An ungated tenant neither
   *      pays for the aggregate nor inherits its failure modes — and since a
   *      null limit can never block, this is behaviour-preserving.
   *   2. The guard wraps ONLY the metering read, and lives HERE rather than in
   *      `MeteringService.getCurrentUsage`. `getCapabilities` and the invoice
   *      evidence tooling read the same method for DISPLAY and BILLING, where
   *      zeros substituted for an error would be a silent lie. Fail-open is an
   *      ENFORCEMENT policy, so it belongs at the enforcement boundary.
   *
   * A skip is never silent: ERROR log (tenant + capability + error class) plus
   * {@link ENTITLEMENTS_METER_SKIPPED_METRIC}.
   */
  async assertMeterQuota(tenantId: EntityId, capability: MeterCapabilityKey, increment = 1): Promise<void> {
    // Q9 — inert until the kill-switch is flipped; keeps hot consultation/STT/
    // summary paths free of any metering aggregation while enforcement is OFF.
    if (!this.isEnforcementEnabled()) return;

    const resolved = await this.resolveForTenant(tenantId);
    const limit = resolved.limits[capability];
    if (limit === null) return; // unlimited/ungated — never read the meter (1)

    let used: number;
    try {
      const usage = await this.metering.getCurrentUsage(tenantId);
      used = METER_USAGE_FIELD_BY_CAPABILITY[capability](usage);
    } catch (err) {
      this.recordSkippedMeterCheck(tenantId, capability, err);
      return; // FAIL OPEN — the clinical request proceeds unmetered-against
    }

    // Same block-new logic the quantity path uses (same event + typed error).
    // The API maps the meter capabilities to 429; the quantity ones to 409.
    this.enforceLimit(tenantId, capability, limit, used, increment);
  }

  /** Make a skipped quota check findable: loud log + a counter an alert can read. */
  private recordSkippedMeterCheck(tenantId: EntityId, capability: MeterCapabilityKey, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));

    this.logger.error({
      message: 'Metering read failed — meter quota check SKIPPED (fail-open); this request was NOT checked against its allowance',
      tenantId,
      capability,
      errorClass: error.name,
      error: error.message,
    });

    try {
      this.meterSkippedCounter?.inc({ capability });
    } catch {
      // Recording the skip must never become a second way to fail the request.
    }
  }

  // --- Concurrency gate (hard-block → 429) --------------------

  async assertConcurrencyQuota(tenantId: EntityId, increment = 1): Promise<void> {
    // Inert until the kill-switch is flipped; keeps the hot session-start
    // path free of any Redis registry read while enforcement is OFF.
    if (!this.isEnforcementEnabled()) return;

    const resolved = await this.resolveForTenant(tenantId);
    const limit = resolved.limits.maxConcurrentSessions;

    // Unlimited/ungated (null limit, incl. null-plan legacy + system tenant).
    if (limit === null) return;

    const active = await this.getActiveConcurrency(tenantId);
    if (!wouldExceedLimit(limit, active, increment)) return;

    // HARD-BLOCK — concurrency is a simultaneous-capacity limit, so a new
    // session at/over the cap is rejected outright (not soft-warned). Emit the
    // shared block event, then throw the typed error the API maps to 429.
    this.eventEmitter.emit(ENTITLEMENTS_QUOTA_BLOCKED_EVENT, {
      tenantId,
      capability: 'maxConcurrentSessions',
      limit,
      used: active,
      requested: increment,
      at: new Date(),
      responsibleEntityId: this.requestUserId ?? undefined,
    });

    throw new QuotaExceededException(
      `Concurrency limit reached for 'maxConcurrentSessions' (${active}/${limit} active sessions). Close an active session, or raise the plan / per-tenant concurrency override to run more at once.`,
      { capability: 'maxConcurrentSessions', limit, used: active, requested: increment, tenantId },
    );
  }

  /**
   * Live simultaneous active STT sessions for a tenant across every instance,
   * from the multi-instance socket-registry. Best-effort: a missing registry or
   * a Redis blip resolves to 0 (fail-open) so a monitoring signal never hard-
   * fails the session-start path.
   */
  private async getActiveConcurrency(tenantId: EntityId): Promise<number> {
    if (!this.socketRegistry) return 0;
    try {
      return await this.socketRegistry.getTenantAggregateCount(tenantId);
    } catch (err) {
      this.logger.debug({
        message: 'Concurrency count read failed — treating as 0 (fail-open)',
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // --- Rate-limit policy for the pre-auth throttler (Q7) -----------------

  async getTenantRateLimitPolicy(tenantId: EntityId): Promise<TenantRateLimitPolicy | null> {
    // Q9 — kill-switch OFF: the throttler keeps the global tiers unchanged. No
    // DB read, no cache entry — the hot path is completely inert until an
    // operator opts in per-env.
    if (!this.isEnforcementEnabled()) return null;

    const now = Date.now();
    const cached = this.rateLimitPolicyCache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.value;

    let value: TenantRateLimitPolicy | null;
    try {
      const resolved = await this.resolveForTenant(tenantId);
      // Ungated (null-plan / system tenant, Q3) → global tiers unchanged.
      value = resolved.gated ? { tier: resolved.rateLimitTier, perMinute: resolved.rateLimitPerMinute, windowMs: resolved.rateLimitWindowMs } : null;
    } catch (err) {
      // A bad/unknown tenantId (e.g. from an unverified pre-auth token) must not
      // throw on the throttler path — fall back to the global tiers (null) and
      // cache that so a probing client can't hammer the resolver.
      this.logger.debug({
        message: 'Rate-limit policy resolve failed — falling back to global tiers',
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      value = null;
    }

    this.rateLimitPolicyCache.set(tenantId, { value, expiresAt: now + RATE_LIMIT_POLICY_TTL_MS });
    return value;
  }

  // --- Storage soft-warn (Q6, never blocks) -----------------------------

  async evaluateStorageSoftWarn(tenantId: EntityId, additionalBytes = 0): Promise<StorageSoftWarn> {
    const none: StorageSoftWarn = { warn: false, quotaBytes: null, usedBytes: 0, projectedBytes: 0 };
    // Gated by the same kill-switch as enforcement (proposal: everything behind
    // `entitlements.enabled`). Off → no telemetry cost on the upload path.
    if (!this.isEnforcementEnabled()) return none;

    const resolved = await this.resolveForTenant(tenantId);
    const quota = resolved.limits.storageQuotaBytes;
    if (quota === null) return none; // unlimited/ungated (Q3)

    const usage = await this.tenantService.getUsageStats(tenantId);
    const used = usage.storageUsedBytes;
    const projected = used + Math.max(0, additionalBytes);
    const warn = projected > quota;

    if (warn) {
      // SOFT-WARN — emit a signal (subscribers surface a banner/audit later) but
      // NEVER throw; the upload proceeds (Q6).
      this.eventEmitter.emit(ENTITLEMENTS_STORAGE_WARN_EVENT, {
        tenantId,
        quotaBytes: quota,
        usedBytes: used,
        projectedBytes: projected,
        additionalBytes,
        at: new Date(),
      });
      this.logger.warn({
        message: 'Tenant storage soft-warn: projected usage crosses quota',
        tenantId,
        quotaBytes: quota,
        usedBytes: used,
        projectedBytes: projected,
      });
    }

    return { warn, quotaBytes: quota, usedBytes: used, projectedBytes: projected };
  }

  // --- Plan matrix CRUD (super-admin) -----------------------------------

  async listPlanEntitlements(): Promise<PlanEntitlementResponse[]> {
    const rows = await this.planEntitlementRepository.findAll({});
    return rows.map((row) => this.toPlanResponse(row));
  }

  async getPlanEntitlement(plan: string): Promise<PlanEntitlementResponse> {
    const row = await this.requirePlanRow(plan);
    return this.toPlanResponse(row);
  }

  async updatePlanEntitlement(plan: string, request: UpdatePlanEntitlementRequest): Promise<PlanEntitlementResponse> {
    const row = await this.requirePlanRow(plan);

    this.applyLimitField(request, 'maxUsers', (v) => (row.maxUsers = v));
    this.applyLimitField(request, 'maxDepartments', (v) => (row.maxDepartments = v));
    this.applyLimitField(request, 'maxPromptTemplates', (v) => (row.maxPromptTemplates = v));
    this.applyLimitField(request, 'maxAsrPipelines', (v) => (row.maxAsrPipelines = v));
    this.applyLimitField(request, 'maxApiKeys', (v) => (row.maxApiKeys = v));
    this.applyLimitField(request, 'maxWorkflowDefinitions', (v) => (row.maxWorkflowDefinitions = v));
    this.applyLimitField(request, 'maxAiProviderConnections', (v) => (row.maxAiProviderConnections = v));
    if (request.storageQuotaBytes !== undefined) {
      row.storageQuotaBytes = request.storageQuotaBytes === null ? null : BigInt(request.storageQuotaBytes);
    }
    this.applyLimitField(request, 'maxConcurrentSessions', (v) => (row.maxConcurrentSessions = v));
    this.applyLimitField(request, 'monthlyConsultations', (v) => (row.monthlyConsultations = v));
    this.applyLimitField(request, 'monthlyTranscriptionMinutes', (v) => (row.monthlyTranscriptionMinutes = v));
    this.applyLimitField(request, 'monthlySummaries', (v) => (row.monthlySummaries = v));
    this.applyLimitField(request, 'monthlyWorkflowInvocations', (v) => (row.monthlyWorkflowInvocations = v));
    // Per-capability allowance ceilings (same bigint conversion as storageQuotaBytes above).
    this.applyBigIntField(request.monthlySttSessionSeconds, (v) => (row.monthlySttSessionSeconds = v));
    this.applyBigIntField(request.monthlyLlmTokens, (v) => (row.monthlyLlmTokens = v));
    this.applyBigIntField(request.monthlyTtsCharacters, (v) => (row.monthlyTtsCharacters = v));
    this.applyBigIntField(request.monthlyNlpTextUnits, (v) => (row.monthlyNlpTextUnits = v));
    this.applyBigIntField(request.monthlyEmbeddingTokens, (v) => (row.monthlyEmbeddingTokens = v));
    if (request.featurePlatformDefaultCredential !== undefined) row.featurePlatformDefaultCredential = request.featurePlatformDefaultCredential;
    if (request.modelTier !== undefined) row.modelTier = request.modelTier;
    if (request.rateLimitTier !== undefined) row.rateLimitTier = request.rateLimitTier;
    // an ABSOLUTE per-plan limit. `null` is a MEANINGFUL value here
    // (clear it and fall back to `rateLimitTier`), so the guard is `!== undefined`.
    if (request.rateLimitPerMinute !== undefined) row.rateLimitPerMinute = request.rateLimitPerMinute;
    if (request.rateLimitWindowMs !== undefined) row.rateLimitWindowMs = request.rateLimitWindowMs;

    if (this.requestUserId) row.updatedBy = this.requestUserId;

    const updated = await this.planEntitlementRepository.updateWithVersion(row.id, row, request.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: updated.toObject() as object,
    });

    return this.toPlanResponse(updated);
  }

  // --- Tenant override CRUD (Q1/Q7) -------------------------------------

  async getTenantEntitlement(tenantId: EntityId): Promise<TenantEntitlementResponse | null> {
    const row = await this.tenantEntitlementRepository.findByTenant(tenantId);
    return row ? this.toTenantResponse(row) : null;
  }

  async upsertTenantEntitlement(tenantId: EntityId, request: UpsertTenantEntitlementRequest): Promise<TenantEntitlementResponse> {
    this.assertOverridableTenant(tenantId);

    const existing = await this.tenantEntitlementRepository.findByTenant(tenantId);

    if (existing) {
      if (request.expectedVersion === undefined) {
        throw new BadRequestException('`expectedVersion` is required to update an existing tenant entitlement override.');
      }
      this.applyTenantOverrideFields(existing, request);
      if (this.requestUserId) existing.updatedBy = this.requestUserId;

      const updated = await this.tenantEntitlementRepository.updateWithVersion(existing.id, existing, request.expectedVersion);
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: updated.id,
        data: updated.toObject() as object,
      });
      return this.toTenantResponse(updated);
    }

    // First override for this tenant — validate the tenant exists, then create.
    await this.tenantRepository.findById(tenantId);

    const entity = TenantEntitlementFactory.CreateTenantEntitlement({
      tenantId,
      createdBy: this.requestUserId ?? null,
      maxUsers: request.maxUsers ?? null,
      maxDepartments: request.maxDepartments ?? null,
      maxPromptTemplates: request.maxPromptTemplates ?? null,
      maxAsrPipelines: request.maxAsrPipelines ?? null,
      maxApiKeys: request.maxApiKeys ?? null,
      maxWorkflowDefinitions: request.maxWorkflowDefinitions ?? null,
      maxAiProviderConnections: request.maxAiProviderConnections ?? null,
      storageQuotaBytes: request.storageQuotaBytes === null || request.storageQuotaBytes === undefined ? null : BigInt(request.storageQuotaBytes),
      maxConcurrentSessions: request.maxConcurrentSessions ?? null,
      monthlyConsultations: request.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: request.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: request.monthlySummaries ?? null,
      monthlyWorkflowInvocations: request.monthlyWorkflowInvocations ?? null,
      // Negotiated per-capability allowance overrides.
      monthlySttSessionSeconds:
        request.monthlySttSessionSeconds === null || request.monthlySttSessionSeconds === undefined ? null : BigInt(request.monthlySttSessionSeconds),
      monthlyLlmTokens: request.monthlyLlmTokens === null || request.monthlyLlmTokens === undefined ? null : BigInt(request.monthlyLlmTokens),
      monthlyTtsCharacters:
        request.monthlyTtsCharacters === null || request.monthlyTtsCharacters === undefined ? null : BigInt(request.monthlyTtsCharacters),
      monthlyNlpTextUnits:
        request.monthlyNlpTextUnits === null || request.monthlyNlpTextUnits === undefined ? null : BigInt(request.monthlyNlpTextUnits),
      monthlyEmbeddingTokens:
        request.monthlyEmbeddingTokens === null || request.monthlyEmbeddingTokens === undefined ? null : BigInt(request.monthlyEmbeddingTokens),
      // The tenant's own spend ceiling (D12). Explicitly NOT `?? null` on a
      // number: `0` is the honest "spend nothing more this month" setting, and
      // `0 ?? null` is fine while `0 || null` is not — spelt out in full like
      // its allowance siblings so the next edit cannot turn a real ceiling into
      // "unlimited", which is the direction that costs money.
      monthlySpendLimitMicros:
        request.monthlySpendLimitMicros === null || request.monthlySpendLimitMicros === undefined ? null : BigInt(request.monthlySpendLimitMicros),
      featurePlatformDefaultCredential: request.featurePlatformDefaultCredential ?? null,
      modelTier: request.modelTier ?? null,
      rateLimitTier: request.rateLimitTier ?? null,
      rateLimitPerMinute: request.rateLimitPerMinute ?? null,
    });

    const created = await this.tenantEntitlementRepository.create(entity);
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      createdAt: created.createdAt,
      data: created.toObject() as object,
    });
    return this.toTenantResponse(created);
  }

  async clearTenantEntitlement(tenantId: EntityId): Promise<void> {
    const existing = await this.tenantEntitlementRepository.findByTenant(tenantId);
    if (!existing) return;

    // Reversible "remove" — null every override field so the tenant inherits
    // the plan default matrix again. The row (with its `tenantId @unique`) is
    // kept; we never delete an entitlement row (Q10 guardrail).
    existing.maxUsers = null;
    existing.maxDepartments = null;
    existing.maxPromptTemplates = null;
    existing.maxAsrPipelines = null;
    existing.maxApiKeys = null;
    existing.maxWorkflowDefinitions = null;
    existing.maxAiProviderConnections = null;
    existing.storageQuotaBytes = null;
    existing.maxConcurrentSessions = null;
    existing.monthlyConsultations = null;
    existing.monthlyTranscriptionMinutes = null;
    existing.monthlySummaries = null;
    existing.monthlyWorkflowInvocations = null;
    // Clear the new allowance overrides too (reversible, never deleted).
    existing.monthlySttSessionSeconds = null;
    existing.monthlyLlmTokens = null;
    existing.monthlyTtsCharacters = null;
    existing.monthlyNlpTextUnits = null;
    existing.monthlyEmbeddingTokens = null;
    existing.monthlySpendLimitMicros = null;
    existing.featurePlatformDefaultCredential = null;
    existing.modelTier = null;
    existing.rateLimitTier = null;
    existing.rateLimitPerMinute = null;
    if (this.requestUserId) existing.updatedBy = this.requestUserId;

    const cleared = await this.tenantEntitlementRepository.updateWithVersion(existing.id, existing, existing.version);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: cleared.id,
      data: cleared.toObject() as object,
    });
  }

  // --- Internals ---------------------------------------------------------

  private async requirePlanRow(plan: string): Promise<PlanEntitlementEntity> {
    if (!Object.values(TenantPlan).includes(plan as TenantPlan)) {
      throw new BadRequestException(`Unknown plan '${plan}'. Valid plans: ${Object.values(TenantPlan).join(', ')}.`);
    }
    const row = await this.planEntitlementRepository.findByPlan(plan as TenantPlan);
    if (!row) {
      throw new NotFoundException(`No entitlement defaults seeded for plan '${plan}'.`);
    }
    return row;
  }

  /** Assign a `number | null` limit field only when the request supplied it. */
  private applyLimitField(
    request: UpdatePlanEntitlementRequest,
    key: keyof UpdatePlanEntitlementRequest,
    assign: (value: number | null) => void,
  ): void {
    const value = request[key];
    if (value !== undefined) {
      assign(value as number | null);
    }
  }

  /**
   * Assign a `number | null` allowance field as its `bigint |
   * null` column, only when the caller supplied it (`undefined` = "leave
   * unchanged"). Same conversion `storageQuotaBytes` already uses; factored out
   * because there are now five of these instead of one.
   */
  private applyBigIntField(value: number | null | undefined, assign: (value: bigint | null) => void): void {
    if (value !== undefined) {
      assign(value === null ? null : BigInt(value));
    }
  }

  private applyTenantOverrideFields(entity: TenantEntitlementEntity, request: UpsertTenantEntitlementRequest): void {
    if (request.maxUsers !== undefined) entity.maxUsers = request.maxUsers;
    if (request.maxDepartments !== undefined) entity.maxDepartments = request.maxDepartments;
    if (request.maxPromptTemplates !== undefined) entity.maxPromptTemplates = request.maxPromptTemplates;
    if (request.maxAsrPipelines !== undefined) entity.maxAsrPipelines = request.maxAsrPipelines;
    if (request.maxApiKeys !== undefined) entity.maxApiKeys = request.maxApiKeys;
    if (request.maxWorkflowDefinitions !== undefined) entity.maxWorkflowDefinitions = request.maxWorkflowDefinitions;
    if (request.maxAiProviderConnections !== undefined) entity.maxAiProviderConnections = request.maxAiProviderConnections;
    if (request.storageQuotaBytes !== undefined) {
      entity.storageQuotaBytes = request.storageQuotaBytes === null ? null : BigInt(request.storageQuotaBytes);
    }
    if (request.maxConcurrentSessions !== undefined) entity.maxConcurrentSessions = request.maxConcurrentSessions;
    if (request.monthlyConsultations !== undefined) entity.monthlyConsultations = request.monthlyConsultations;
    if (request.monthlyTranscriptionMinutes !== undefined) entity.monthlyTranscriptionMinutes = request.monthlyTranscriptionMinutes;
    if (request.monthlySummaries !== undefined) entity.monthlySummaries = request.monthlySummaries;
    if (request.monthlyWorkflowInvocations !== undefined) entity.monthlyWorkflowInvocations = request.monthlyWorkflowInvocations;
    this.applyBigIntField(request.monthlySttSessionSeconds, (v) => (entity.monthlySttSessionSeconds = v));
    this.applyBigIntField(request.monthlyLlmTokens, (v) => (entity.monthlyLlmTokens = v));
    this.applyBigIntField(request.monthlyTtsCharacters, (v) => (entity.monthlyTtsCharacters = v));
    this.applyBigIntField(request.monthlyNlpTextUnits, (v) => (entity.monthlyNlpTextUnits = v));
    this.applyBigIntField(request.monthlyEmbeddingTokens, (v) => (entity.monthlyEmbeddingTokens = v));
    this.applyBigIntField(request.monthlySpendLimitMicros, (v) => (entity.monthlySpendLimitMicros = v));
    if (request.featurePlatformDefaultCredential !== undefined) entity.featurePlatformDefaultCredential = request.featurePlatformDefaultCredential;
    if (request.modelTier !== undefined) entity.modelTier = request.modelTier;
    if (request.rateLimitTier !== undefined) entity.rateLimitTier = request.rateLimitTier;
    if (request.rateLimitPerMinute !== undefined) entity.rateLimitPerMinute = request.rateLimitPerMinute;
  }

  /**
   * Upsert a single `entitlements.*` GlobalSetting row, then refresh the cache
   * (identical pattern to `RateLimitAdminService.writeSetting`).
   */
  private async writeSetting(key: string, value: string, dataType: ValueType, name: string): Promise<void> {
    const cached = this.appSettings.getFromCache(key);
    if (cached) {
      await this.globalSettings.update(cached.id, { value, expectedVersion: cached.version });
    } else {
      await this.globalSettings.create({
        name,
        key,
        value,
        dataType,
        namespace: ENTITLEMENTS_NAMESPACE,
        tenantId: ENTITLEMENTS_TENANT_ID,
      });
    }
    await this.appSettings.refreshCache();
  }

  private toPlanResponse(row: PlanEntitlementEntity): PlanEntitlementResponse {
    return {
      id: row.id,
      plan: row.plan,
      maxUsers: row.maxUsers ?? null,
      maxDepartments: row.maxDepartments ?? null,
      maxPromptTemplates: row.maxPromptTemplates ?? null,
      maxAsrPipelines: row.maxAsrPipelines ?? null,
      maxApiKeys: row.maxApiKeys ?? null,
      maxWorkflowDefinitions: row.maxWorkflowDefinitions ?? null,
      maxAiProviderConnections: row.maxAiProviderConnections ?? null,
      storageQuotaBytes: row.storageQuotaBytes === null || row.storageQuotaBytes === undefined ? null : Number(row.storageQuotaBytes),
      maxConcurrentSessions: row.maxConcurrentSessions ?? null,
      monthlyConsultations: row.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: row.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: row.monthlySummaries ?? null,
      monthlyWorkflowInvocations: row.monthlyWorkflowInvocations ?? null,
      monthlySttSessionSeconds: toAllowanceNumber(row.monthlySttSessionSeconds),
      monthlyLlmTokens: toAllowanceNumber(row.monthlyLlmTokens),
      monthlyTtsCharacters: toAllowanceNumber(row.monthlyTtsCharacters),
      monthlyNlpTextUnits: toAllowanceNumber(row.monthlyNlpTextUnits),
      monthlyEmbeddingTokens: toAllowanceNumber(row.monthlyEmbeddingTokens),
      featurePlatformDefaultCredential: row.featurePlatformDefaultCredential,
      modelTier: row.modelTier,
      rateLimitTier: row.rateLimitTier,
      rateLimitPerMinute: row.rateLimitPerMinute ?? null,
      rateLimitWindowMs: row.rateLimitWindowMs ?? null,
      version: row.version,
    };
  }

  private toTenantResponse(row: TenantEntitlementEntity): TenantEntitlementResponse {
    return {
      id: row.id,
      tenantId: row.tenantId,
      maxUsers: row.maxUsers ?? null,
      maxDepartments: row.maxDepartments ?? null,
      maxPromptTemplates: row.maxPromptTemplates ?? null,
      maxAsrPipelines: row.maxAsrPipelines ?? null,
      maxApiKeys: row.maxApiKeys ?? null,
      maxWorkflowDefinitions: row.maxWorkflowDefinitions ?? null,
      maxAiProviderConnections: row.maxAiProviderConnections ?? null,
      storageQuotaBytes: row.storageQuotaBytes === null || row.storageQuotaBytes === undefined ? null : Number(row.storageQuotaBytes),
      maxConcurrentSessions: row.maxConcurrentSessions ?? null,
      monthlyConsultations: row.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: row.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: row.monthlySummaries ?? null,
      monthlyWorkflowInvocations: row.monthlyWorkflowInvocations ?? null,
      monthlySttSessionSeconds: toAllowanceNumber(row.monthlySttSessionSeconds),
      monthlyLlmTokens: toAllowanceNumber(row.monthlyLlmTokens),
      monthlyTtsCharacters: toAllowanceNumber(row.monthlyTtsCharacters),
      monthlyNlpTextUnits: toAllowanceNumber(row.monthlyNlpTextUnits),
      monthlyEmbeddingTokens: toAllowanceNumber(row.monthlyEmbeddingTokens),
      monthlySpendLimitMicros: toAllowanceNumber(row.monthlySpendLimitMicros),
      featurePlatformDefaultCredential: row.featurePlatformDefaultCredential ?? null,
      modelTier: row.modelTier ?? null,
      rateLimitTier: row.rateLimitTier ?? null,
      rateLimitPerMinute: row.rateLimitPerMinute ?? null,
      version: row.version,
    };
  }

  /**
   * The SYSTEM tenant has no entitlements to override (TASK-959 FU-1).
   *
   * `00000000-…` is the platform CONFIGURATION tier, not a customer: it carries
   * no plan, and no request ever runs as it, so nothing resolves an override row
   * written there. `monthlySpendLimitMicros` is where that stops being harmless
   * — `assertSpendLimit` is called with the REQUEST tenant, so a ceiling set on
   * SYSTEM bounds nobody while looking, in the admin UI and in the row, exactly
   * like a ceiling that is set.
   *
   * Refused for EVERYONE, platform administrator included: this is not a
   * privilege boundary (there is no caller for whom it would be meaningful), it
   * is an invalid target. `EntitlementsLifecycleService.triggerDowngrade`
   * already refuses the same tenant on the same reasoning.
   *
   * The check runs BEFORE any lookup deliberately, and that is consistent with
   * rule 05's ordering rule rather than an exception to it: the answer does not
   * vary by row, so there is no id space to probe — every caller gets the same
   * 403 for the one id, whether or not a row exists behind it.
   */
  private assertOverridableTenant(tenantId: EntityId): void {
    if (tenantId === ENTITLEMENTS_TENANT_ID) {
      throw new ForbiddenException('The system tenant is a configuration tier and carries no entitlement override.');
    }
  }
}
