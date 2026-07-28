import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { QuotaExceededException } from '@arcaai/exceptions';
import {
  ApiKeyRepository,
  EntityId,
  PlanEntitlementEntity,
  PlanEntitlementRepository,
  ResourceType,
  SysEventType,
  TenantEntitlementEntity,
  TenantEntitlementFactory,
  TenantEntitlementRepository,
  TenantPlan,
  TenantRepository,
  ValueType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IGlobalSettingService } from '../globalSetting/IGlobalSettingService';
import { ITenantService } from '../tenant/ITenantService';
import { IMeteringService } from '../metering/IMeteringService';
import { ISocketRegistryService } from '../platform-metrics/socket-registry.service';
import { IEntitlementsService, StorageSoftWarn, TenantRateLimitPolicy } from './IEntitlementsService';
import { ResolvedEntitlements, resolveEntitlements } from './resolve-entitlements';
import { buildCapabilityRow, computeTrialInfo } from './capability';
import { EntitlementLimitKey, MeterCapabilityKey, wouldExceedLimit } from './enforcement';
import { ENTITLEMENTS_QUOTA_BLOCKED_EVENT, ENTITLEMENTS_STORAGE_WARN_EVENT } from './entitlements.constants';
import {
  ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT,
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

@Injectable()
export class EntitlementsService extends BaseService implements IEntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  /** Per-tenant rate-limit policy cache (short TTL, hot path). */
  private readonly rateLimitPolicyCache = new Map<string, { value: TenantRateLimitPolicy | null; expiresAt: number }>();

  constructor(
    private readonly tenantRepository: TenantRepository,
    private readonly planEntitlementRepository: PlanEntitlementRepository,
    private readonly tenantEntitlementRepository: TenantEntitlementRepository,
    private readonly apiKeyRepository: ApiKeyRepository,
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
  ) {
    super(eventEmitter, clsService, ResourceType.Tenant);
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
    const plan = (tenant.plan as TenantPlan | null | undefined) ?? null;

    const planRow = plan ? await this.planEntitlementRepository.findByPlan(plan) : null;
    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);

    return resolveEntitlements(plan, planRow, override);
  }

  async getCapabilities(tenantId: EntityId): Promise<EntitlementCapabilitiesResponse> {
    const tenant = await this.tenantRepository.findById(tenantId);
    const plan = (tenant.plan as TenantPlan | null | undefined) ?? null;

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

    const quantities = [
      buildCapabilityRow('users', resolved.limits.maxUsers, usage.totalUsers),
      buildCapabilityRow('departments', resolved.limits.maxDepartments, usage.totalDepartments),
      buildCapabilityRow('promptTemplates', resolved.limits.maxPromptTemplates, usage.totalPromptTemplates),
      buildCapabilityRow('asrPipelines', resolved.limits.maxAsrPipelines, usage.totalPipelines),
      buildCapabilityRow('apiKeys', resolved.limits.maxApiKeys, apiKeyCount),
      buildCapabilityRow('storageBytes', resolved.limits.storageQuotaBytes, usage.storageUsedBytes),
      // Concurrency is a point-in-time quantity (live sessions vs. cap), not a
      // rolling meter — surfaced alongside the other quantity capabilities.
      buildCapabilityRow('concurrentSessions', resolved.limits.maxConcurrentSessions, activeConcurrent),
    ];

    const meters = [
      buildCapabilityRow('monthlyConsultations', resolved.limits.monthlyConsultations, meterUsage.consultations),
      buildCapabilityRow('monthlyTranscriptionMinutes', resolved.limits.monthlyTranscriptionMinutes, meterUsage.transcriptionMinutes),
      buildCapabilityRow('monthlySummaries', resolved.limits.monthlySummaries, meterUsage.summaries),
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

  // --- Enforcement primitive (Q9 gate + Q10 block-new) ------------------

  async assertQuantityQuota(tenantId: EntityId, capability: EntitlementLimitKey, currentCount: number, increment = 1): Promise<void> {
    // Q9 — enforcement ships OFF; every check is inert until the kill-switch is
    // flipped per-env. This is the single gate that makes a partial landing safe.
    if (!this.isEnforcementEnabled()) return;

    const resolved = await this.resolveForTenant(tenantId);
    const limit = resolved.limits[capability];

    // Unlimited/ungated (null limit, incl. null-plan legacy + system tenant, Q3).
    if (!wouldExceedLimit(limit, currentCount, increment)) return;

    // Q10 — block the NEW action only; existing resources are grandfathered.
    // Emit an audit event (subscribers persist it), then throw the
    // typed error the API maps to 409/429.
    this.eventEmitter.emit(ENTITLEMENTS_QUOTA_BLOCKED_EVENT, {
      tenantId,
      capability,
      limit,
      used: currentCount,
      requested: increment,
      at: new Date(),
    });

    throw new QuotaExceededException(
      `Plan limit reached for '${capability}' (${currentCount}/${limit}). Existing items are unaffected — raise the plan or per-tenant override to add more.`,
      { capability, limit: limit as number, used: currentCount, requested: increment, tenantId },
    );
  }

  // --- Meter enforcement (Q5, → 429) ------------------------------------

  async assertMeterQuota(tenantId: EntityId, capability: MeterCapabilityKey, increment = 1): Promise<void> {
    // Q9 — inert until the kill-switch is flipped; keeps hot consultation/STT/
    // summary paths free of any metering aggregation while enforcement is OFF.
    if (!this.isEnforcementEnabled()) return;

    const usage = await this.metering.getCurrentUsage(tenantId);
    const used =
      capability === 'monthlyConsultations'
        ? usage.consultations
        : capability === 'monthlyTranscriptionMinutes'
          ? usage.transcriptionMinutes
          : usage.summaries;

    // Delegates to the shared block-new logic (same event + typed error). The
    // API maps the meter capabilities to 429; the quantity ones to 409.
    await this.assertQuantityQuota(tenantId, capability, used, increment);
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
      value = resolved.gated ? { tier: resolved.rateLimitTier, perMinute: resolved.rateLimitPerMinute } : null;
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
    if (request.storageQuotaBytes !== undefined) {
      row.storageQuotaBytes = request.storageQuotaBytes === null ? null : BigInt(request.storageQuotaBytes);
    }
    this.applyLimitField(request, 'maxConcurrentSessions', (v) => (row.maxConcurrentSessions = v));
    this.applyLimitField(request, 'monthlyConsultations', (v) => (row.monthlyConsultations = v));
    this.applyLimitField(request, 'monthlyTranscriptionMinutes', (v) => (row.monthlyTranscriptionMinutes = v));
    this.applyLimitField(request, 'monthlySummaries', (v) => (row.monthlySummaries = v));
    if (request.featureDnaReports !== undefined) row.featureDnaReports = request.featureDnaReports;
    if (request.featureVoiceEnrollment !== undefined) row.featureVoiceEnrollment = request.featureVoiceEnrollment;
    if (request.featureMonitoringAccess !== undefined) row.featureMonitoringAccess = request.featureMonitoringAccess;
    if (request.modelTier !== undefined) row.modelTier = request.modelTier;
    if (request.rateLimitTier !== undefined) row.rateLimitTier = request.rateLimitTier;

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
      storageQuotaBytes: request.storageQuotaBytes === null || request.storageQuotaBytes === undefined ? null : BigInt(request.storageQuotaBytes),
      maxConcurrentSessions: request.maxConcurrentSessions ?? null,
      monthlyConsultations: request.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: request.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: request.monthlySummaries ?? null,
      featureDnaReports: request.featureDnaReports ?? null,
      featureVoiceEnrollment: request.featureVoiceEnrollment ?? null,
      featureMonitoringAccess: request.featureMonitoringAccess ?? null,
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
    existing.storageQuotaBytes = null;
    existing.maxConcurrentSessions = null;
    existing.monthlyConsultations = null;
    existing.monthlyTranscriptionMinutes = null;
    existing.monthlySummaries = null;
    existing.featureDnaReports = null;
    existing.featureVoiceEnrollment = null;
    existing.featureMonitoringAccess = null;
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

  private applyTenantOverrideFields(entity: TenantEntitlementEntity, request: UpsertTenantEntitlementRequest): void {
    if (request.maxUsers !== undefined) entity.maxUsers = request.maxUsers;
    if (request.maxDepartments !== undefined) entity.maxDepartments = request.maxDepartments;
    if (request.maxPromptTemplates !== undefined) entity.maxPromptTemplates = request.maxPromptTemplates;
    if (request.maxAsrPipelines !== undefined) entity.maxAsrPipelines = request.maxAsrPipelines;
    if (request.maxApiKeys !== undefined) entity.maxApiKeys = request.maxApiKeys;
    if (request.storageQuotaBytes !== undefined) {
      entity.storageQuotaBytes = request.storageQuotaBytes === null ? null : BigInt(request.storageQuotaBytes);
    }
    if (request.maxConcurrentSessions !== undefined) entity.maxConcurrentSessions = request.maxConcurrentSessions;
    if (request.monthlyConsultations !== undefined) entity.monthlyConsultations = request.monthlyConsultations;
    if (request.monthlyTranscriptionMinutes !== undefined) entity.monthlyTranscriptionMinutes = request.monthlyTranscriptionMinutes;
    if (request.monthlySummaries !== undefined) entity.monthlySummaries = request.monthlySummaries;
    if (request.featureDnaReports !== undefined) entity.featureDnaReports = request.featureDnaReports;
    if (request.featureVoiceEnrollment !== undefined) entity.featureVoiceEnrollment = request.featureVoiceEnrollment;
    if (request.featureMonitoringAccess !== undefined) entity.featureMonitoringAccess = request.featureMonitoringAccess;
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
      storageQuotaBytes: row.storageQuotaBytes === null || row.storageQuotaBytes === undefined ? null : Number(row.storageQuotaBytes),
      maxConcurrentSessions: row.maxConcurrentSessions ?? null,
      monthlyConsultations: row.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: row.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: row.monthlySummaries ?? null,
      featureDnaReports: row.featureDnaReports,
      featureVoiceEnrollment: row.featureVoiceEnrollment,
      featureMonitoringAccess: row.featureMonitoringAccess,
      modelTier: row.modelTier,
      rateLimitTier: row.rateLimitTier,
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
      storageQuotaBytes: row.storageQuotaBytes === null || row.storageQuotaBytes === undefined ? null : Number(row.storageQuotaBytes),
      maxConcurrentSessions: row.maxConcurrentSessions ?? null,
      monthlyConsultations: row.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: row.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: row.monthlySummaries ?? null,
      featureDnaReports: row.featureDnaReports ?? null,
      featureVoiceEnrollment: row.featureVoiceEnrollment ?? null,
      featureMonitoringAccess: row.featureMonitoringAccess ?? null,
      modelTier: row.modelTier ?? null,
      rateLimitTier: row.rateLimitTier ?? null,
      rateLimitPerMinute: row.rateLimitPerMinute ?? null,
      version: row.version,
    };
  }
}
