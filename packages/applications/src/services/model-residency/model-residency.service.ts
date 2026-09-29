import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AiDeploymentKind,
  AiModelEntity,
  AiModelRepository,
  ModelResidencyClass,
  ModelResidencyPolicyEntity,
  ModelResidencyPolicyFactory,
  ModelResidencyPolicyRepository,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  generateId,
} from '@arcaai/domains';
import { ArgumentInvalidException, BusinessException, DataNotFoundException } from '@arcaai/exceptions';
import { ClsService } from 'nestjs-cls';
import { fallbackOnNotFound, warnAndFallback } from '../../common/swallow-policy';
import { BaseService } from '../../common/base.service';
import { isSuperAdmin } from '../../common/tenant-guards';
import type { IActiveUserContext } from '../../interfaces';
import { LmStudioEngineClient, LmStudioEngineError, type LmStudioLoadOptions } from '../inference-engine/lmstudio-engine.client';
import { IPrometheusQueryService, type PrometheusSample } from '../platform-metrics/prometheus-query.service';
import { MODEL_RESIDENCY_DEFAULTS, type ModelResidencySettingKey } from '../settings-registry/descriptors/model-residency.descriptors';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import type {
  CreateModelResidencyPolicyRequest,
  LmStudioResidencyLoadOptions,
  LoadModelResidencyRequest,
  ModelResidencyCatalogueResponse,
  ModelResidencyDevice,
  ModelResidencyModel,
  ModelResidencyOperationResponse,
  ModelResidencyPinResponse,
  ModelResidencyPolicyResponse,
  ModelResidencyRecommendation,
  ModelResidencyUnloadResponse,
  ModelResidencyViewResponse,
  PinModelResidencyRequest,
  UnloadModelResidencyRequest,
  UpdateModelResidencyPolicyRequest,
} from './dto';
import { ImplicitLivePathReader, type LivePathModel } from './implicit-live-path';
import type { IModelResidencyService, ModelResidencyLoadResult } from './IModelResidencyService';
import { ModelUsageIndexReader } from './model-usage-index';
import {
  type ReportedResidentModel,
  type ResidencyBytesSource,
  type ResidencyClassName,
  type ResidencyClassSource,
  type ResidencyControlledService,
  type ResidencyMode,
  type ResidencyModelState,
  type ResidencyServiceName,
  type ServiceResidencyReport,
  RESIDENCY_CONTROLLED_SERVICES,
  refFor,
  residencyKey,
  residencyServiceOf,
} from './model-residency.types';
import { PhysicalGpuLoadGate } from './physical-gpu-load-gate';
import { ResidencyAgentClient, ResidencyAgentError } from './residency-agent.client';
import { buildResidencyCatalogue } from './residency-catalogue';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError } from './residency-load-spec.builder';
import { residencyAdmissionRejectionsTotal, residencyDecisionsTotal } from './residency-metrics';
import { ResidencyOperationRegistry } from './residency-operations';
import {
  CooldownTracker,
  type EngineDecision,
  type EngineDevice,
  type EngineModel,
  type EngineSettings,
  PromotionTracker,
  planTick,
  usableBytes,
} from './residency-policy-engine';

/**
 * TASK-1005 — the gateway ModelResidencyController: the ONE control plane that
 * decides and executes model load / unload / pin across `stt`, `nlp` and LM
 * Studio (Triton's explicit model-control mode, plan D-1). `stt-worker` has no
 * control API and is observed through Prometheus only.
 *
 * ── THE LOOP (every 10 s, plan §5.3) ─────────────────────────────────────────
 *
 *   observe  → the LEDGER: each agent's `GET /internal/residency`, LM Studio's
 *              REST v1 listing, DCGM per-device memory, per-model request
 *              rates, the SYSTEM policy rows and the implicit live path. A
 *              service whose last good report is > 30 s old is listed in
 *              `freshness.staleServices` and keeps its last known rows.
 *   decide   → `planTick` (pure; `residency-policy-engine.ts`).
 *   act      → SHADOW (`residency.enforce=false`, the default): record the
 *              recommendation and meter it — NOTHING is sent (D-3, OD-1).
 *              ENFORCE: send the commands, every load behind the
 *              one-load-per-physical-GPU gate.
 *
 * Operator actions (load / unload / pin from the console) are commands, not
 * policy: they run in either mode, are audited as sys-events on
 * `ResourceType.ModelResidencyPolicy`, and go through the SAME gate.
 *
 * ── MEASURED, NEVER ESTIMATED (D-2) ──────────────────────────────────────────
 *
 * The agents measure a load's footprint themselves (free-memory delta around a
 * serialised load); LM Studio reports none, so the controller measures it as
 * the DCGM `DCGM_FI_DEV_FB_USED` delta per card around its OWN load — which is
 * only attributable because the gate holds both cards for the duration. Every
 * measured footprint is written back to `AiModel.observedMemoryMb /
 * observedLoadSeconds / observedAt`, and the admission check and the eviction
 * score read only those measured values.
 *
 * ── PER PROCESS ──────────────────────────────────────────────────────────────
 *
 * The gate, the operation registry, the recommendation log and LM Studio's
 * controller-side pins live in this process. The gateway runs one replica
 * today; a second replica would need a shared lock before `residency.enforce`
 * is turned on (see the ticket's risks).
 */

/** The decision loop's cadence (plan §5.3) — also the view's bounded staleness. */
export const RESIDENCY_TICK_MS = 10_000;
/** A service whose last good report is older than this is `stale` (admin fixture). */
const STALE_AFTER_MS = 30_000;
/** A read reuses the ledger when it is younger than this. */
const LEDGER_REUSE_MS = 5_000;
/** The recommendation log keeps this many entries, newest first. */
const RECOMMENDATION_RING = 200;
/** A shadow recommendation identical to one recorded within this window is not recorded again. */
const RECOMMENDATION_DEDUPE_MS = 5 * 60_000;

const MiB = 1024 * 1024;

const PROMQL = {
  fbUsed: 'max by (gpu, modelName) (DCGM_FI_DEV_FB_USED)',
  fbFree: 'max by (gpu) (DCGM_FI_DEV_FB_FREE)',
  fbReserved: 'max by (gpu) (DCGM_FI_DEV_FB_RESERVED)',
  gpuUtil: 'max by (gpu) (DCGM_FI_DEV_GPU_UTIL)',
  fbUsedAt: 'max by (gpu) (timestamp(DCGM_FI_DEV_FB_USED))',
  // The Python services label their series `service=…`, which Prometheus renames
  // `exported_service` because each scrape job sets its own `service` target
  // label; `job` is what tells stt-worker (job `stt-worker`) apart from stt.
  running: 'sum by (job, exported_service, model) (model_running_instances)',
  ratePerMin: 'sum by (job, exported_service, model) (rate(model_inference_latency_seconds_count[5m])) * 60',
  p50Seconds: 'histogram_quantile(0.5, sum by (job, exported_service, model, le) (rate(model_inference_latency_seconds_bucket[5m])))',
  workerResident: 'max by (model, device, state) (model_resident{job="stt-worker"}) == 1',
  workerBytes: 'max by (model, device) (model_resident_bytes{job="stt-worker"})',
} as const;

interface ResidencySettings extends EngineSettings {
  enforce: boolean;
  admissionMaxWaitMs: number;
}

interface LedgerEntry {
  service: ResidencyServiceName;
  instance: string;
  modelRef: string;
  aiModelId: string | null;
  aiModelName: string | null;
  /** Display device: `gpu<N>`, `multi`, `cpu:<service>`, or the service's own id when unmapped. */
  device: string;
  /** Physical devices for the engine and the gate. */
  devices: string[];
  state: ResidencyModelState;
  bytes: number | null;
  bytesSource: ResidencyBytesSource;
  inFlight: number | null;
  requestsPerMin: number | null;
  p50LatencyMs: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  loadSeconds: number | null;
  ttlSeconds: number | null;
  reportedPinned: boolean;
  adminPinned: boolean;
  cache: string;
  instanceId?: string;
}

interface CatalogueIndex {
  byId: Map<string, AiModelEntity>;
  modelFor(service: string, modelRef: string): AiModelEntity | undefined;
}

interface Ledger {
  at: number;
  devices: Omit<ModelResidencyDevice, 'headroomPercent'>[];
  entries: LedgerEntry[];
  staleServices: string[];
  maxAgeSeconds: number;
  policies: ModelResidencyPolicyEntity[];
  livePath: LivePathModel[];
  catalogue: CatalogueIndex;
}

interface Classification {
  class: ResidencyClassName;
  classSource: ResidencyClassSource;
  policy: ModelResidencyPolicyEntity | null;
}

interface LoadJob {
  opId: string;
  action: 'load' | 'replace';
  service: ResidencyControlledService;
  modelRef: string;
  pin: boolean;
  force: boolean;
  reason: string | null;
  loadSpec: Record<string, unknown> | null;
  options: LmStudioLoadOptions;
  aiModelId: string | null;
  /** `operator` = a console action (its pin is the operator's); `policy` = the enforce-mode loop (its pin is the controller's). */
  origin: 'operator' | 'policy';
  recommendation?: ModelResidencyRecommendation;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const parseMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function isControlled(service: string): service is ResidencyControlledService {
  return (RESIDENCY_CONTROLLED_SERVICES as readonly string[]).includes(service);
}

/** Which residency service a per-model Prometheus series belongs to. */
function metricService(metric: Record<string, string>): string {
  if (metric.job === 'stt-worker') return 'stt-worker';
  return metric.exported_service ?? metric.service ?? metric.job ?? 'unknown';
}

@Injectable()
export class ModelResidencyService extends BaseService implements IModelResidencyService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModelResidencyService.name);

  private readonly gate = new PhysicalGpuLoadGate();
  private readonly operations = new ResidencyOperationRegistry();
  private readonly promotion = new PromotionTracker();
  private readonly cooldown = new CooldownTracker();
  private readonly recommendations: ModelResidencyRecommendation[] = [];
  private readonly lastRecorded = new Map<string, number>();
  private readonly background = new Set<Promise<void>>();

  /** Last successful report per commanded service, and when it arrived. */
  private readonly lastReports = new Map<ResidencyControlledService, { report: ServiceResidencyReport; receivedAt: number }>();
  /** Agent GPU → physical card, per reporting instance (a pod never changes card). */
  private readonly instanceGpu = new Map<string, string>();
  /** The cache each (service, model) was last reported in — nlp's reload needs it. */
  private readonly lastSeenCache = new Map<string, string>();
  /** Keys the controller itself pinned (enforce mode), so it only ever unpins its own. */
  private readonly controllerPinned = new Set<string>();

  // LM Studio reports no pin, footprint, timestamps or usage: the controller keeps them.
  private readonly lmsPins = new Map<string, { ttlSeconds: number | null }>();
  private readonly lmsFootprint = new Map<string, { bytes: number; loadSeconds: number | null }>();
  private readonly lmsLoadedAt = new Map<string, number>();
  private readonly lmsLastUsed = new Map<string, number>();
  /** First time this process saw a resident (service, model) — a residency floor when the service reports no load time. */
  private readonly firstSeen = new Map<string, number>();

  private ledger: Ledger | null = null;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** DCGM is scraped, not live: how often, and how long, to wait for a sample newer than a load. */
  protected measurementPollMs = 5_000;
  protected measurementMaxWaitMs = 60_000;

  constructor(
    private readonly policies: ModelResidencyPolicyRepository,
    private readonly aiModels: AiModelRepository,
    private readonly agents: ResidencyAgentClient,
    private readonly lmStudio: LmStudioEngineClient,
    // Symbol token, so the parameter type alone cannot resolve it.
    @Inject(IPrometheusQueryService) private readonly prometheus: IPrometheusQueryService,
    private readonly effectiveSettings: EffectiveSettingsService,
    private readonly livePath: ImplicitLivePathReader,
    private readonly specs: ResidencyLoadSpecBuilder,
    private readonly usage: ModelUsageIndexReader,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ModelResidencyPolicy);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), RESIDENCY_TICK_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Never hold shutdown hostage to a 100 s LM Studio load; its operation record dies with the process anyway.
    await Promise.race([this.drain(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  /** Resolves once every background load this process started has settled. */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ── the decision loop ─────────────────────────────────────────────────────

  /**
   * One pass of §5.3. Never throws and never overlaps itself. In SHADOW mode
   * it sends nothing to any service — the whole point of shadow is that the
   * log it produces is a faithful preview of what enforcement WOULD do.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = await this.readSettings();
      const ledger = await this.observe();
      const now = Date.now();
      const { models, devices } = this.engineInput(ledger, now);

      for (const m of models) {
        if (m.desiredClass === 'WARM') this.promotion.observe(residencyKey(m.service, m.modelRef), m.requestsPerMin ?? 0, settings);
      }

      const decisions = planTick({
        models,
        devices,
        settings,
        promoted: this.promotion.promotedKeys(),
        coolingDown: (key) => this.cooldown.blocks(key, now, settings.reloadCooldownSeconds),
      });
      // The engine never unpins; the controller unpins ONLY what it pinned itself, once the model leaves the live path.
      for (const m of models) {
        const key = residencyKey(m.service, m.modelRef);
        if (m.resident && m.agentPinned && m.desiredClass !== 'PINNED' && this.controllerPinned.has(key)) {
          decisions.push({ action: 'unpin', service: m.service, modelRef: m.modelRef, reason: 'live_path_pin', devices: m.devices, bytes: m.bytes });
        }
      }

      if (!settings.enforce) {
        for (const decision of decisions) this.record(decision, 'shadow', false);
        return;
      }
      await this.enforce(decisions, ledger, settings);
    } catch (error) {
      this.logger.warn({ message: 'residency.tick.failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async enforce(decisions: EngineDecision[], ledger: Ledger, settings: ResidencySettings): Promise<void> {
    const pendingEvictions: EngineDecision[] = [];
    for (const decision of decisions) {
      if (decision.reason === 'admission_rejected') {
        this.record(decision, 'enforce', false);
      } else if (decision.action === 'unload' && decision.reason === 'make_room') {
        // Evicted only once the load it makes room for holds the gate — never for a load that then cannot start.
        pendingEvictions.push(decision);
      } else if (decision.action === 'load') {
        await this.enforceLoad(decision, pendingEvictions.splice(0), ledger, settings);
      } else if (decision.action === 'unload') {
        const applied = await this.policyUnload(decision.service, decision.modelRef);
        this.record(decision, 'enforce', applied);
      } else {
        const applied = await this.policyPin(decision.service, decision.modelRef, decision.action === 'pin');
        this.record(decision, 'enforce', applied);
      }
    }
  }

  private async enforceLoad(decision: EngineDecision, evictions: EngineDecision[], ledger: Ledger, settings: ResidencySettings): Promise<void> {
    const service = decision.service;
    if (!isControlled(service)) return;
    const opId = generateId();
    if (!(await this.gate.waitAcquire(decision.devices, opId, settings.admissionMaxWaitMs))) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'gpu_busy' });
      for (const eviction of evictions) this.record(eviction, 'enforce', false);
      this.record(decision, 'enforce', false);
      return;
    }
    for (const eviction of evictions) this.record(eviction, 'enforce', await this.policyUnload(eviction.service, eviction.modelRef));

    try {
      const loadSpec =
        service === 'lm-studio'
          ? null
          : await this.specs.build(service, decision.modelRef, this.lastSeenCache.get(residencyKey(service, decision.modelRef)));
      const recommendation = this.record(decision, 'enforce', false);
      this.startLoad({
        opId,
        action: 'load',
        service,
        modelRef: decision.modelRef,
        pin: this.classify(service, decision.modelRef, ledger.catalogue.modelFor(service, decision.modelRef)?.id ?? null, ledger).class === 'PINNED',
        force: false,
        reason: `policy:${decision.reason}`,
        loadSpec,
        options: {},
        aiModelId: ledger.catalogue.modelFor(service, decision.modelRef)?.id ?? null,
        origin: 'policy',
        recommendation,
      });
    } catch (error) {
      this.gate.release(opId);
      this.logger.warn({ message: 'residency.enforce.load_not_started', service, modelRef: decision.modelRef, error: String(error) });
      this.record(decision, 'enforce', false);
    }
  }

  private async policyUnload(service: string, modelRef: string): Promise<boolean> {
    if (!isControlled(service)) return false;
    try {
      await this.unloadInternal(service, modelRef, false, 'policy');
      return true;
    } catch (error) {
      this.logger.warn({ message: 'residency.enforce.unload_failed', service, modelRef, error: String(error) });
      return false;
    }
  }

  private async policyPin(service: string, modelRef: string, pinned: boolean): Promise<boolean> {
    if (!isControlled(service)) return false;
    try {
      if (service === 'lm-studio') {
        if (pinned) this.lmsPins.set(modelRef, { ttlSeconds: this.lmsPins.get(modelRef)?.ttlSeconds ?? null });
        else this.lmsPins.delete(modelRef);
      } else {
        await this.agents.setPolicy(service, modelRef, { adminPinned: pinned });
      }
      const key = residencyKey(service, modelRef);
      if (pinned) this.controllerPinned.add(key);
      else this.controllerPinned.delete(key);
      this.ledger = null;
      return true;
    } catch (error) {
      this.logger.warn({ message: 'residency.enforce.pin_failed', service, modelRef, error: String(error) });
      return false;
    }
  }

  /** Append to the recommendation log (newest first) and meter it. A shadow duplicate within the dedupe window is dropped. */
  private record(decision: EngineDecision, mode: ResidencyMode, applied: boolean, now = Date.now()): ModelResidencyRecommendation | undefined {
    if (mode === 'shadow') {
      const dedupeKey = `${decision.action}|${decision.service}|${decision.modelRef}|${decision.reason}`;
      const last = this.lastRecorded.get(dedupeKey);
      if (last !== undefined && now - last < RECOMMENDATION_DEDUPE_MS) return undefined;
      this.lastRecorded.set(dedupeKey, now);
    }
    if (decision.reason === 'admission_rejected') residencyAdmissionRejectionsTotal.inc({ reason: 'insufficient_memory' });
    else residencyDecisionsTotal.inc({ action: decision.action, mode });

    const recommendation: ModelResidencyRecommendation = {
      id: generateId(),
      at: iso(now),
      action: decision.action,
      service: decision.service,
      modelRef: decision.modelRef,
      reason: decision.reason,
      mode,
      applied,
    };
    this.recommendations.unshift(recommendation);
    if (this.recommendations.length > RECOMMENDATION_RING) this.recommendations.length = RECOMMENDATION_RING;
    return recommendation;
  }

  // ── operator surface ──────────────────────────────────────────────────────

  async getView(): Promise<ModelResidencyViewResponse> {
    this.assertPlatformAdmin('read model residency');
    const settings = await this.readSettings();
    const ledger = await this.currentLedger();

    const models = ledger.entries.map((entry) => this.toViewModel(entry, ledger));
    for (const op of this.operations.running()) {
      if (!ledger.entries.some((e) => e.service === op.service && e.modelRef === op.modelRef) && isControlled(op.service)) {
        models.push(this.loadingView(op.service, op.modelRef, ledger, false));
      }
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { surface: 'model-residency', models: models.length } });
    return {
      mode: settings.enforce ? 'enforce' : 'shadow',
      reportedAt: iso(ledger.at),
      freshness: { maxAgeSeconds: ledger.maxAgeSeconds, staleServices: ledger.staleServices },
      devices: ledger.devices.map((device) => ({ ...device, headroomPercent: settings.headroomPercent })),
      models,
      recommendations: this.recommendations.slice(0, 100).map((r) => ({ ...r })),
    };
  }

  /**
   * TASK-1005 §13 — the catalogue-first view: every SELF_HOSTED SYSTEM catalogue
   * model under the workload that runs it, loaded or not, merged with the SAME
   * ledger `getView` reads, the reverse usage index (cached platform-wide,
   * `ModelUsageIndexReader`), the keep policy in plain words, and the
   * recommendations as sentences. Cost over `getView`: ONE catalogue query per
   * call, plus the usage index's four queries at most once per 30 s.
   */
  async getCatalogue(): Promise<ModelResidencyCatalogueResponse> {
    this.assertPlatformAdmin('read the model catalogue');
    const now = Date.now();
    const [settings, ledger, rows] = await Promise.all([
      this.readSettings(),
      this.currentLedger(),
      // The platform catalogue is the SYSTEM tier (rule 00); a tenant's BYO row is served by the tenant's own connection, not these workloads.
      this.aiModels.findAll({
        filters: {
          tenantId: SYSTEM_TENANT_ID,
          deploymentKind: AiDeploymentKind.SELF_HOSTED,
          resourceStatus: { not: ResourceStatusType.DELETED },
        } as never,
      }),
    ]);
    const catalogue = rows.filter((row) => residencyServiceOf(row) !== null);
    const usage = await this.usage.read(
      catalogue.map((row) => row.id),
      now,
    );

    const view = buildResidencyCatalogue({
      now,
      mode: settings.enforce ? 'enforce' : 'shadow',
      reportedAt: iso(ledger.at),
      freshness: { maxAgeSeconds: ledger.maxAgeSeconds, staleServices: ledger.staleServices },
      headroomPercent: settings.headroomPercent,
      devices: ledger.devices,
      staleServices: ledger.staleServices,
      entries: ledger.entries,
      loading: this.operations.running().map((op) => ({ service: op.service, modelRef: op.modelRef })),
      catalogue,
      modelById: (id) => ledger.catalogue.byId.get(id),
      usage,
      classify: (service, modelRef, aiModelId) => this.classify(service, modelRef, aiModelId, ledger),
      observedBytes: (service, modelRef, model) => this.observedBytes(service, modelRef, model),
      observedLoadSeconds: (service, modelRef, model) =>
        (service === 'lm-studio' ? this.lmsFootprint.get(modelRef)?.loadSeconds : undefined) ?? model?.observedLoadSeconds ?? null,
      recommendations: this.recommendations,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { surface: 'model-residency.catalogue', models: view.services.reduce((sum, s) => sum + s.models.length, 0) },
    });
    return view;
  }

  async load(request: LoadModelResidencyRequest): Promise<ModelResidencyLoadResult> {
    this.assertPlatformAdmin('load a model');
    const { service, modelRef } = request;
    const force = request.force === true;
    const reason = request.reason?.trim() || null;
    const replace = request.replace === true;

    if (request.options && service !== 'lm-studio') {
      throw new BadRequestException({
        code: 'OPTIONS_UNSUPPORTED',
        message: `\`options\` are LM Studio REST v1 load keys; service '${service}' takes none.`,
      });
    }

    const settings = await this.readSettings();
    const ledger = await this.currentLedger();
    const resident = ledger.entries.filter((e) => e.service === service && e.modelRef === modelRef);

    if (resident.length > 0 && !replace) {
      return { status: 200, body: { outcome: 'already_loaded', model: this.toViewModel(resident[0], ledger) } };
    }
    if (this.operations.runningFor(service, modelRef)) {
      throw new ConflictException({ code: 'LOAD_IN_PROGRESS', message: `A load of '${modelRef}' on ${service} is already running.` });
    }
    const inFlight = resident.reduce((sum, e) => sum + (e.inFlight ?? 0), 0);
    if (replace && inFlight > 0 && !force) {
      throw new ConflictException({
        code: 'IN_FLIGHT',
        message: `${modelRef} is serving ${inFlight} request(s); pass force=true to replace it anyway`,
        inFlight,
      });
    }

    const aiModel = await this.catalogueModel(service, modelRef, ledger);
    const loadSpec =
      service === 'lm-studio'
        ? null
        : await this.specs
            .build(service, modelRef, resident[0]?.cache ?? this.lastSeenCache.get(residencyKey(service, modelRef)))
            .catch((error: unknown) => {
              throw toHttpException(error);
            });

    // ── budget: MEASURED footprints only (D-2); a never-measured model is admitted against the headroom alone ──
    const devices = resident[0]?.devices ?? this.placementDevices(service, ledger);
    const residentBytes = resident.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
    const needBytes = (replace ? residentBytes : 0) || this.observedBytes(service, modelRef, aiModel) || 0;
    const availableBytes = this.availableBytes(service, devices, ledger, settings) + (replace ? residentBytes : 0);
    const overBudget = needBytes > availableBytes;
    if (overBudget && !(force && reason)) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'over_budget' });
      throw new ConflictException({
        code: 'OVER_BUDGET',
        message:
          `Loading '${modelRef}' needs ${needBytes} bytes but ${availableBytes} are free on ${devices.join(', ')} after the ${settings.headroomPercent}% headroom. ` +
          'The cards are time-sliced and give no memory isolation, so an over-budget load can OOM every workload on them. ' +
          'Re-send with `force: true` AND a non-empty `reason` to proceed anyway (audited).',
        needBytes,
        availableBytes,
        devices,
      });
    }

    const opId = generateId();
    if (!this.gate.tryAcquire(devices, opId)) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'gpu_busy' });
      throw new ConflictException({
        code: 'LOAD_IN_PROGRESS',
        message: `Another model load is in flight on ${devices.join(', ')}; loads are serialised per physical GPU so every footprint is measurable. Retry once it settles.`,
        devices,
      });
    }

    // Re-checked AFTER the (synchronous) claim: the awaits above let a concurrent request for the same
    // model get this far too, and a host-CPU pool is not gated, so the claim alone would not stop it.
    if (this.operations.runningFor(service, modelRef)) {
      this.gate.release(opId);
      throw new ConflictException({ code: 'LOAD_IN_PROGRESS', message: `A load of '${modelRef}' on ${service} is already running.` });
    }

    const action = replace && resident.length > 0 ? 'replace' : 'load';
    this.startLoad({
      opId,
      action,
      service,
      modelRef,
      pin: request.pin === true,
      force,
      reason,
      loadSpec,
      options: lmStudioOptions(request.options),
      aiModelId: aiModel?.id ?? resident[0]?.aiModelId ?? null,
      origin: 'operator',
    });

    // A platform-disruptive action on shared, time-sliced cards stays attributable to the administrator who took it.
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      data: { action: `model-residency.${action}`, operationId: opId, service, modelRef, pin: request.pin === true, force, reason, overBudget },
    });

    return {
      status: 202,
      body: { outcome: 'accepted', operationId: opId, model: this.loadingView(service, modelRef, ledger, request.pin === true) },
    };
  }

  async unload(request: UnloadModelResidencyRequest): Promise<ModelResidencyUnloadResponse> {
    this.assertPlatformAdmin('unload a model');
    const { service, modelRef } = request;
    const force = request.force === true;
    const reason = request.reason?.trim() || null;

    if (this.operations.runningFor(service, modelRef)) {
      throw new ConflictException({
        code: 'LOAD_IN_PROGRESS',
        message: `A load of '${modelRef}' on ${service} is running; unload it once it settles.`,
      });
    }
    if (service === 'lm-studio' && !force) {
      // LM Studio refuses nothing on its own; the in-flight guard is the controller's (from `model_running_instances`).
      const ledger = await this.currentLedger();
      const inFlight = ledger.entries.filter((e) => e.service === service && e.modelRef === modelRef).reduce((sum, e) => sum + (e.inFlight ?? 0), 0);
      if (inFlight > 0) {
        throw new ConflictException({
          code: 'IN_FLIGHT',
          message: `${modelRef} is serving ${inFlight} request(s); pass force=true to unload anyway`,
          inFlight,
        });
      }
    }

    const outcome = await this.unloadInternal(service, modelRef, force, 'admin').catch((error: unknown) => {
      throw toHttpException(error);
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, { data: { action: 'model-residency.unload', service, modelRef, force, reason, outcome } });
    return { outcome, service, modelRef };
  }

  async pin(request: PinModelResidencyRequest): Promise<ModelResidencyPinResponse> {
    this.assertPlatformAdmin('pin a model');
    const { service, modelRef, pinned } = request;
    const key = residencyKey(service, modelRef);

    let reported: ReportedResidentModel | null = null;
    if (service === 'lm-studio') {
      const ledger = await this.currentLedger();
      if (!ledger.entries.some((e) => e.service === service && e.modelRef === modelRef)) {
        throw new NotFoundException({ code: 'MODEL_UNKNOWN', message: `LM Studio holds no loaded instance of '${modelRef}'.` });
      }
      if (pinned)
        this.lmsPins.set(modelRef, {
          ttlSeconds: request.ttlSeconds !== undefined ? request.ttlSeconds : (this.lmsPins.get(modelRef)?.ttlSeconds ?? null),
        });
      else this.lmsPins.delete(modelRef);
    } else {
      reported = await this.agents
        .setPolicy(service, modelRef, { adminPinned: pinned, ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}) })
        .catch((error: unknown) => {
          throw toHttpException(error);
        });
    }
    // An operator's pin is the operator's; the controller must never later "unpin its own" over it.
    this.controllerPinned.delete(key);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      data: { action: pinned ? 'model-residency.pin' : 'model-residency.unpin', service, modelRef, ttlSeconds: request.ttlSeconds ?? null },
    });

    this.ledger = null;
    const ledger = await this.currentLedger();
    const entry = ledger.entries.find((e) => e.service === service && e.modelRef === modelRef);
    if (entry) return { model: this.toViewModel(entry, ledger) };
    return { model: this.toViewModel(this.entryFromReport(service, reported, modelRef, ledger), ledger) };
  }

  async getOperation(operationId: string): Promise<ModelResidencyOperationResponse> {
    this.assertPlatformAdmin('read a residency operation');
    const op = this.operations.get(operationId);
    if (!op)
      throw new NotFoundException(`No residency operation '${operationId}' is known to this gateway (operations are kept in memory, per process).`);
    return op;
  }

  // ── policies (SYSTEM rows only) ───────────────────────────────────────────

  async listPolicies(): Promise<ModelResidencyPolicyResponse[]> {
    this.assertPlatformAdmin('read residency policies');
    const rows = await this.policies.findAll({ filters: { tenantId: SYSTEM_TENANT_ID } as never, sort: [{ createdAt: 'asc' }] as never });
    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: rows.length } });
    return rows.map(toPolicyResponse);
  }

  async createPolicy(request: CreateModelResidencyPolicyRequest): Promise<ModelResidencyPolicyResponse> {
    this.assertPlatformAdmin('create a residency policy');
    await this.aiModels.findById(request.aiModelId).catch((error: unknown) => {
      if (error instanceof DataNotFoundException) throw new NotFoundException(`Model ${request.aiModelId} not found`);
      throw error;
    });
    if (await this.policies.findByModelAndService(SYSTEM_TENANT_ID, request.aiModelId, request.service)) {
      throw new ConflictException({
        code: 'POLICY_EXISTS',
        message: `A residency policy for model ${request.aiModelId} on ${request.service} already exists; update it instead.`,
      });
    }

    const entity = ModelResidencyPolicyFactory.CreateModelResidencyPolicy({
      tenantId: SYSTEM_TENANT_ID,
      aiModelId: request.aiModelId,
      service: request.service,
      class: request.class,
      idleTtlSeconds: request.idleTtlSeconds,
      priority: request.priority,
      maxInstances: request.maxInstances,
      preferredDevice: request.preferredDevice,
      createdBy: this.requestUserId ?? undefined,
    });
    validateOr400(entity);
    const saved = await this.policies.create(entity);
    this.ledger = null;

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { aiModelId: saved.aiModelId, service: saved.service, class: saved.class },
    });
    return toPolicyResponse(saved);
  }

  async updatePolicy(id: string, request: UpdateModelResidencyPolicyRequest): Promise<ModelResidencyPolicyResponse> {
    this.assertPlatformAdmin('update a residency policy');
    const entity = await this.requirePolicy(id);
    const { expectedVersion, ...changes } = request;
    if (expectedVersion === undefined) throw new BadRequestException('expectedVersion (If-Match) is required');

    const previousVersion = entity.version;
    await this.updateEntity(entity, changes);
    if (!entity.hasChanges) throw new ArgumentInvalidException('No changes to write to.');
    validateOr400(entity);

    const updated = await this.policies.updateWithVersion(id, entity, expectedVersion);
    this.ledger = null;
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });
    return toPolicyResponse(updated);
  }

  async deletePolicy(id: string): Promise<ModelResidencyPolicyResponse> {
    this.assertPlatformAdmin('delete a residency policy');
    await this.requirePolicy(id);
    const deleted = await this.policies.softDelete(id, this.requestUserId ?? undefined);
    this.ledger = null;
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { aiModelId: deleted.aiModelId, service: deleted.service },
    });
    return toPolicyResponse(deleted);
  }

  // ── gate ──────────────────────────────────────────────────────────────────

  /**
   * AUTH-NOTE: the routes' `@CanManage('ModelResidencyPolicy')` UNDERSTATES
   * this gate. There is no "super admin" CASL subject, and residency decides how
   * much memory each process holds on cards every tenant's workload shares — so
   * it is platform administration (D-11): SUPER_ADMIN, in a tenant-LESS context
   * (a working tenant selected is itself a 403, the promote-to-system shape).
   * ROW-INDEPENDENT — the same answer for every model and policy id — so it
   * runs FIRST; an unknown id is still a 404 after it.
   */
  private assertPlatformAdmin(action: string): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Only platform administrators may ${action}.`);
    }
    if (this.tenantId) {
      throw new ForbiddenException(`Model residency is platform-wide; clear the working tenant to ${action}.`);
    }
  }

  private async requirePolicy(id: string): Promise<ModelResidencyPolicyEntity> {
    const entity = await this.policies.findById(id).catch((error: unknown) => {
      if (error instanceof DataNotFoundException) return null;
      throw error;
    });
    if (!entity || entity.tenantId !== SYSTEM_TENANT_ID) throw new NotFoundException(`Residency policy ${id} not found`);
    return entity;
  }

  // ── execution ─────────────────────────────────────────────────────────────

  /** Record the operation and run the load in the background; the gate (claimed by the caller) is released when it settles. */
  private startLoad(job: LoadJob): void {
    this.operations.start({ id: job.opId, action: job.action, service: job.service, modelRef: job.modelRef });
    const task: Promise<void> = this.runLoad(job).finally(() => {
      this.gate.release(job.opId);
      this.ledger = null;
      this.background.delete(task);
    });
    this.background.add(task);
  }

  private async runLoad(job: LoadJob): Promise<void> {
    const { service, modelRef } = job;
    try {
      if (job.action === 'replace') await this.unloadInternal(service, modelRef, job.force, 'admin');

      const measured =
        service === 'lm-studio'
          ? await this.loadLmStudio(modelRef, job.options, job.pin)
          : await this.loadViaAgent(service, modelRef, job.loadSpec ?? {}, job.pin);
      if (measured.bytes && job.aiModelId) await this.writeObserved(job.aiModelId, measured.bytes, measured.loadSeconds);

      this.operations.succeed(job.opId);
      if (job.recommendation) job.recommendation.applied = true;
      if (job.pin && job.origin === 'policy') this.controllerPinned.add(residencyKey(service, modelRef));
      else if (job.pin) this.controllerPinned.delete(residencyKey(service, modelRef));
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        data: {
          action: `model-residency.${job.action}.succeeded`,
          operationId: job.opId,
          service,
          modelRef,
          bytes: measured.bytes,
          loadSeconds: measured.loadSeconds,
        },
      });
    } catch (error) {
      const failure = describeError(error);
      this.operations.fail(job.opId, failure);
      this.logger.warn({ message: 'residency.load.failed', operationId: job.opId, service, modelRef, ...failure });
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        data: { action: `model-residency.${job.action}.failed`, operationId: job.opId, service, modelRef, error: failure },
      });
    }
  }

  private async loadViaAgent(
    service: 'stt' | 'nlp',
    modelRef: string,
    loadSpec: Record<string, unknown>,
    pin: boolean,
  ): Promise<{ bytes: number | null; loadSeconds: number | null }> {
    const result = await this.agents.load(service, { modelRef, loadSpec, pin, ttlSeconds: null });
    const model = result.model;
    return { bytes: model.bytesSource === 'measured' ? model.bytes : null, loadSeconds: model.loadSeconds };
  }

  /**
   * LM Studio reports no footprint, so it is MEASURED here: the DCGM used-memory
   * delta per card around this load, summed over both cards (the daemon splits
   * the model). Valid only because the gate holds both cards; a delta that is not
   * positive, or no DCGM sample newer than the load, leaves it unmeasured.
   */
  private async loadLmStudio(
    modelRef: string,
    options: LmStudioLoadOptions,
    pin: boolean,
  ): Promise<{ bytes: number | null; loadSeconds: number | null }> {
    const before = await this.readGpuUsed();
    const started = Date.now();
    const result = await this.lmStudio.load(modelRef, options);
    const finished = Date.now();
    if (pin) this.lmsPins.set(modelRef, { ttlSeconds: this.lmsPins.get(modelRef)?.ttlSeconds ?? null });
    if (result.outcome === 'already_loaded') return { bytes: null, loadSeconds: null };

    this.lmsLoadedAt.set(result.model.instanceId, finished);
    const loadSeconds = result.model.loadSeconds ?? (finished - started) / 1000;
    const after = await this.readGpuUsedAfter(finished);
    let bytes: number | null = null;
    if (before && after) {
      const delta = [...after].reduce((sum, [gpu, used]) => sum + Math.max(0, used - (before.get(gpu) ?? used)), 0);
      bytes = delta > 0 ? delta : null;
    }
    if (bytes) this.lmsFootprint.set(modelRef, { bytes, loadSeconds });
    return { bytes, loadSeconds };
  }

  private async readGpuUsed(): Promise<Map<string, number> | null> {
    const samples = await this.prometheus
      .instantVector(PROMQL.fbUsed)
      .catch(warnAndFallback([] as PrometheusSample[], { logger: this.logger, message: 'GPU used-memory metric read failed' }));
    if (samples.length === 0) return null;
    return new Map(samples.map((s) => [`gpu${s.metric.gpu}`, s.value * MiB]));
  }

  /** Wait (bounded) for a DCGM sample of every card taken after `sinceMs`, then read used memory. */
  private async readGpuUsedAfter(sinceMs: number): Promise<Map<string, number> | null> {
    const deadline = Date.now() + this.measurementMaxWaitMs;
    for (;;) {
      const stamps = await this.prometheus
        .instantVector(PROMQL.fbUsedAt)
        .catch(warnAndFallback([] as PrometheusSample[], { logger: this.logger, message: 'GPU sample-time metric read failed' }));
      if (stamps.length > 0 && stamps.every((s) => s.value * 1000 >= sinceMs)) return this.readGpuUsed();
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.measurementPollMs));
    }
  }

  private async writeObserved(aiModelId: string, bytes: number, loadSeconds: number | null): Promise<void> {
    try {
      const entity = await this.aiModels.findById(aiModelId);
      entity.observedMemoryMb = Math.max(1, Math.round(bytes / MiB));
      entity.observedLoadSeconds = loadSeconds;
      entity.observedAt = new Date();
      await this.aiModels.update(aiModelId, entity);
    } catch (error) {
      // The load itself succeeded; losing the measurement must not fail it.
      this.logger.warn({ message: 'residency.observed.write_failed', aiModelId, error: String(error) });
    }
  }

  private async unloadInternal(
    service: ResidencyControlledService,
    modelRef: string,
    force: boolean,
    reason: 'admin' | 'policy',
  ): Promise<'unloaded' | 'not_loaded'> {
    let outcome: 'unloaded' | 'not_loaded';
    if (service === 'lm-studio') {
      // A fresh listing, not the ledger: every instance of the key must go, including a `:2` created since the last tick.
      const report = await this.lmStudio.report();
      const instances = report.models.filter((m) => m.modelRef === modelRef).map((m) => m.instanceId);
      outcome = 'not_loaded';
      for (const instanceId of instances) {
        if ((await this.lmStudio.unload(instanceId)).outcome === 'unloaded') outcome = 'unloaded';
        this.lmsLoadedAt.delete(instanceId);
      }
      this.lmsPins.delete(modelRef);
    } else {
      outcome = (await this.agents.unload(service, { modelRef, force, reason })).outcome;
    }
    const key = residencyKey(service, modelRef);
    this.cooldown.noteUnloaded(key, Date.now());
    this.controllerPinned.delete(key);
    this.firstSeen.delete(key);
    this.ledger = null;
    return outcome;
  }

  // ── observation ───────────────────────────────────────────────────────────

  private async readSettings(): Promise<ResidencySettings> {
    const read = async (key: ModelResidencySettingKey): Promise<number | boolean> => {
      const fallback: number | boolean = MODEL_RESIDENCY_DEFAULTS[key];
      // SYSTEM explicitly: these keys are `globalOnly` / `maxScope: 'system'` — there is no tenant tier to widen from.
      const resolved = await this.effectiveSettings
        .resolveEffective(key, { tenantId: SYSTEM_TENANT_ID })
        .catch(fallbackOnNotFound(null, { logger: this.logger, message: 'Residency setting read failed', meta: { key } }));
      const value = resolved?.value;
      if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };
    const [enforce, headroomPercent, minResidencySeconds, reloadCooldownSeconds, promotionRateThreshold, promotionWindows, admissionMaxWaitMs] =
      await Promise.all([
        read('residency.enforce'),
        read('residency.headroomPercent'),
        read('residency.minResidencySeconds'),
        read('residency.reloadCooldownSeconds'),
        read('residency.promotion.rateThreshold'),
        read('residency.promotion.windows'),
        read('residency.admission.maxWaitMs'),
      ]);
    return {
      enforce: enforce === true,
      headroomPercent: Number(headroomPercent),
      minResidencySeconds: Number(minResidencySeconds),
      reloadCooldownSeconds: Number(reloadCooldownSeconds),
      promotionRateThreshold: Number(promotionRateThreshold),
      promotionWindows: Number(promotionWindows),
      admissionMaxWaitMs: Number(admissionMaxWaitMs),
    };
  }

  private async currentLedger(): Promise<Ledger> {
    if (this.ledger && Date.now() - this.ledger.at < LEDGER_REUSE_MS) return this.ledger;
    return this.observe();
  }

  /**
   * Step 1 of §5.3: rebuild the ledger. Cost: 2 agent GETs + 1 LM Studio GET +
   * 9 Prometheus instant queries + 2 DB reads (policies, catalogue) — the
   * implicit live path (3 DB reads) is cached for 60 s by its reader.
   */
  private async observe(): Promise<Ledger> {
    const now = Date.now();
    const [gpus, metrics, policies, livePath] = await Promise.all([
      this.readGpus(),
      this.readModelMetrics(),
      this.policies
        .findAll({ filters: { tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatusType.ENABLED } as never })
        .catch(
          warnAndFallback(this.ledger?.policies ?? [], { logger: this.logger, message: 'Residency policy read failed; reusing the previous ledger' }),
        ),
      this.livePath.read(now),
      this.refreshReport('stt', () => this.agents.report('stt'), now),
      this.refreshReport('nlp', () => this.agents.report('nlp'), now),
      this.refreshReport('lm-studio', async () => (await this.lmStudio.report()) as ServiceResidencyReport, now),
    ]);

    const staleServices = RESIDENCY_CONTROLLED_SERVICES.filter((service) => {
      const last = this.lastReports.get(service);
      return !last || now - last.receivedAt > STALE_AFTER_MS;
    });
    const ages = [...this.lastReports.values()].map((r) => (now - r.receivedAt) / 1000);
    const maxAgeSeconds = Math.round(ages.length > 0 ? Math.max(...ages) : 0);

    const reports = [...this.lastReports.values()].map((r) => r.report);
    const workerRefs = metrics.workerResident.map((s) => s.metric.model).filter(Boolean);
    const catalogue = await this.readCatalogue(reports, workerRefs, policies, livePath);

    const gpuIds = gpus.map((g) => g.id);
    const devices: Ledger['devices'] = gpus.map(({ id, name, totalBytes, usedBytes, freeBytes, utilisationPercent }) => ({
      id,
      kind: 'gpu' as const,
      name,
      totalBytes,
      usedBytes,
      freeBytes,
      utilisationPercent,
    }));

    // A service reports its device even with an empty cache: map its card now, so a first load is placed and budgeted on it.
    for (const report of reports) {
      for (const device of report.devices) if (report.service !== 'lm-studio' && device.kind === 'gpu') this.physicalGpu(report, device.id, gpus);
    }

    const usage = indexModelMetrics(metrics);
    const entries: LedgerEntry[] = [];
    for (const report of reports) {
      for (const model of report.models) {
        entries.push(this.entryFrom(report, model, gpus, gpuIds, devices, catalogue, usage, now));
      }
    }
    for (const sample of metrics.workerResident) {
      entries.push(this.workerEntry(sample, metrics.workerBytes, catalogue, usage));
    }

    const ledger: Ledger = { at: now, devices, entries, staleServices, maxAgeSeconds, policies, livePath, catalogue };
    this.ledger = ledger;
    return ledger;
  }

  private async refreshReport(service: ResidencyControlledService, read: () => Promise<ServiceResidencyReport>, now: number): Promise<void> {
    try {
      this.lastReports.set(service, { report: await read(), receivedAt: now });
    } catch (error) {
      this.logger.debug({ message: 'residency.report.unavailable', service, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private entryFrom(
    report: ServiceResidencyReport,
    model: ReportedResidentModel,
    gpus: GpuReading[],
    gpuIds: string[],
    devices: Ledger['devices'],
    catalogue: CatalogueIndex,
    usage: ModelUsageIndex,
    now: number,
  ): LedgerEntry {
    const service = report.service;
    const key = residencyKey(service, model.modelRef);
    if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
    this.lastSeenCache.set(key, model.cache);

    const aiModel = (model.aiModelId ? catalogue.byId.get(model.aiModelId) : undefined) ?? catalogue.modelFor(service, model.modelRef);
    const stats = usage.get(service, model.modelRef);

    let device = model.device;
    let physical: string[];
    if (service === 'lm-studio') {
      device = 'multi';
      physical = gpuIds.length > 0 ? gpuIds : ['gpu?'];
    } else if (model.device.startsWith('cpu')) {
      device = `cpu:${service}`;
      physical = [device];
      this.ensureCpuPool(service, report, devices);
    } else {
      const mapped = this.physicalGpu(report, model.device, gpus);
      device = mapped ?? model.device;
      physical = mapped ? [mapped] : gpuIds.length > 0 ? gpuIds : ['gpu?'];
    }

    let bytes = model.bytes;
    let bytesSource = model.bytesSource;
    let inFlight = model.inFlight;
    let lastUsedAt = model.lastUsedAt;
    let loadedAt = model.loadedAt;
    let loadSeconds = model.loadSeconds;
    let adminPinned = model.adminPinned;
    if (service === 'lm-studio') {
      const footprint = this.lmsFootprint.get(model.modelRef);
      const observed = footprint?.bytes ?? (aiModel?.observedMemoryMb ? aiModel.observedMemoryMb * MiB : null);
      bytes = observed;
      bytesSource = observed ? 'measured' : 'unknown';
      inFlight = stats.inFlight;
      loadSeconds = footprint?.loadSeconds ?? aiModel?.observedLoadSeconds ?? null;
      if ((stats.inFlight ?? 0) > 0 || (stats.requestsPerMin ?? 0) > 0) this.lmsLastUsed.set(model.modelRef, now);
      const used = this.lmsLastUsed.get(model.modelRef);
      lastUsedAt = used ? iso(used) : null;
      const loaded = model.instanceId ? this.lmsLoadedAt.get(model.instanceId) : undefined;
      loadedAt = loaded ? iso(loaded) : null;
      adminPinned = this.lmsPins.has(model.modelRef);
    }

    return {
      service,
      instance: service === 'lm-studio' ? (model.instanceId ?? report.instance) : report.instance,
      modelRef: model.modelRef,
      aiModelId: model.aiModelId ?? aiModel?.id ?? null,
      aiModelName: aiModel?.name ?? null,
      device,
      devices: physical,
      state: model.state,
      bytes,
      bytesSource,
      inFlight,
      requestsPerMin: stats.requestsPerMin,
      p50LatencyMs: stats.p50LatencyMs,
      loadedAt,
      lastUsedAt,
      loadSeconds,
      ttlSeconds: service === 'lm-studio' ? (this.lmsPins.get(model.modelRef)?.ttlSeconds ?? null) : model.ttlSeconds,
      reportedPinned: model.pinned,
      adminPinned,
      cache: model.cache,
      ...(model.instanceId ? { instanceId: model.instanceId } : {}),
    };
  }

  private workerEntry(sample: PrometheusSample, workerBytes: PrometheusSample[], catalogue: CatalogueIndex, usage: ModelUsageIndex): LedgerEntry {
    const modelRef = sample.metric.model ?? 'unknown';
    const measured = workerBytes.find((b) => b.metric.model === modelRef && b.metric.device === sample.metric.device)?.value ?? 0;
    const aiModel = catalogue.modelFor('stt-worker', modelRef);
    const stats = usage.get('stt-worker', modelRef);
    const state = sample.metric.state === 'loading' || sample.metric.state === 'unloading' ? sample.metric.state : 'loaded';
    return {
      service: 'stt-worker',
      instance: 'stt-worker',
      modelRef,
      aiModelId: aiModel?.id ?? null,
      aiModelName: aiModel?.name ?? null,
      device: sample.metric.device ?? 'unknown',
      devices: [],
      state,
      bytes: measured > 0 ? measured : null,
      bytesSource: measured > 0 ? 'measured' : 'unknown',
      inFlight: stats.inFlight,
      requestsPerMin: stats.requestsPerMin,
      p50LatencyMs: stats.p50LatencyMs,
      loadedAt: null,
      lastUsedAt: null,
      loadSeconds: null,
      ttlSeconds: null,
      reportedPinned: false,
      adminPinned: false,
      cache: 'asr',
    };
  }

  /**
   * An agent's `cuda:0` is its OWN card, whose physical index a time-sliced pod
   * cannot know. It is matched to the DCGM card whose free memory is closest to
   * the agent's own reading — accepted only when the match is unambiguous — and
   * remembered per pod (a pod never changes card). Unmatched ⇒ the load gate
   * conservatively claims every card.
   */
  private physicalGpu(report: ServiceResidencyReport, agentDevice: string, gpus: GpuReading[]): string | null {
    const stickyKey = `${report.service}|${report.instance}|${agentDevice}`;
    const sticky = this.instanceGpu.get(stickyKey);
    if (sticky && gpus.some((g) => g.id === sticky)) return sticky;
    if (gpus.length === 1) return gpus[0].id;

    const reading = report.devices.find((d) => d.id === agentDevice && d.kind === 'gpu');
    if (!reading || gpus.length === 0) return null;
    const ranked = gpus.map((g) => ({ id: g.id, diff: Math.abs(g.freeBytes - reading.freeBytes) })).sort((a, b) => a.diff - b.diff);
    const [best, second] = ranked;
    const tolerance = Math.max(1024 * MiB, reading.totalBytes * 0.1);
    if (best.diff > tolerance || (second && second.diff - best.diff < 512 * MiB)) return null;
    this.instanceGpu.set(stickyKey, best.id);
    return best.id;
  }

  private ensureCpuPool(service: string, report: ServiceResidencyReport, devices: Ledger['devices']): void {
    const id = `cpu:${service}`;
    if (devices.some((d) => d.id === id)) return;
    const cpu = report.devices.find((d) => d.kind === 'cpu');
    if (!cpu) return;
    devices.push({
      id,
      kind: 'cpu',
      name: `${service} host memory`,
      totalBytes: cpu.totalBytes,
      usedBytes: Math.max(0, cpu.totalBytes - cpu.freeBytes),
      freeBytes: cpu.freeBytes,
      utilisationPercent: null,
    });
  }

  private async readGpus(): Promise<GpuReading[]> {
    const query = (q: string) =>
      this.prometheus
        .instantVector(q)
        .catch(warnAndFallback([] as PrometheusSample[], { logger: this.logger, message: 'GPU metric read failed', meta: { query: q } }));
    const [used, free, reserved, util] = await Promise.all([
      query(PROMQL.fbUsed),
      query(PROMQL.fbFree),
      query(PROMQL.fbReserved),
      query(PROMQL.gpuUtil),
    ]);
    const byGpu = (samples: PrometheusSample[]) => new Map(samples.map((s) => [s.metric.gpu, s.value]));
    const freeBy = byGpu(free);
    const reservedBy = byGpu(reserved);
    const utilBy = byGpu(util);
    // DCGM_FI_DEV_* is per DEVICE and aggregated `max by (gpu)` — never by `pod`, which under time-slicing is an arbitrary pick.
    return used
      .filter((s) => Number.isInteger(Number(s.metric.gpu)))
      .map((s) => {
        const usedMib = s.value;
        const freeMib = freeBy.get(s.metric.gpu) ?? 0;
        return {
          id: `gpu${s.metric.gpu}`,
          name: s.metric.modelName ?? 'unknown',
          usedBytes: Math.round(usedMib * MiB),
          freeBytes: Math.round(freeMib * MiB),
          // No FB_TOTAL on this exporter: used + free + reserved reproduces the card's capacity.
          totalBytes: Math.round((usedMib + freeMib + (reservedBy.get(s.metric.gpu) ?? 0)) * MiB),
          utilisationPercent: utilBy.get(s.metric.gpu) ?? null,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async readModelMetrics(): Promise<ModelMetrics> {
    const query = (q: string) =>
      this.prometheus
        .instantVector(q)
        .catch(warnAndFallback([] as PrometheusSample[], { logger: this.logger, message: 'Model metric read failed', meta: { query: q } }));
    const [running, rate, p50, workerResident, workerBytes] = await Promise.all([
      query(PROMQL.running),
      query(PROMQL.ratePerMin),
      query(PROMQL.p50Seconds),
      query(PROMQL.workerResident),
      query(PROMQL.workerBytes),
    ]);
    return { running, rate, p50, workerResident, workerBytes };
  }

  private async readCatalogue(
    reports: ServiceResidencyReport[],
    workerRefs: string[],
    policies: ModelResidencyPolicyEntity[],
    livePath: LivePathModel[],
  ): Promise<CatalogueIndex> {
    const refs = { slug: new Set<string>(workerRefs), sourceUri: new Set<string>(), wireModelId: new Set<string>() };
    const ids = new Set<string>([...policies.map((p) => p.aiModelId), ...livePath.map((l) => l.aiModelId)]);
    for (const report of reports) {
      for (const model of report.models) {
        if (model.aiModelId) ids.add(model.aiModelId);
        if (report.service === 'lm-studio') refs.wireModelId.add(model.modelRef);
        else if (report.service === 'nlp') refs.sourceUri.add(model.modelRef);
        else refs.slug.add(model.modelRef);
      }
    }
    const or: Record<string, unknown>[] = [];
    if (refs.slug.size) or.push({ tenantId: SYSTEM_TENANT_ID, slug: { in: [...refs.slug] } });
    if (refs.sourceUri.size) or.push({ tenantId: SYSTEM_TENANT_ID, servedBy: 'nlp', sourceUri: { in: [...refs.sourceUri] } });
    if (refs.wireModelId.size) or.push({ tenantId: SYSTEM_TENANT_ID, wireModelId: { in: [...refs.wireModelId] } });
    if (ids.size) or.push({ id: { in: [...ids] } });

    const rows =
      or.length > 0
        ? await this.aiModels
            .findAll({ filters: { OR: or } as never })
            .catch(warnAndFallback([] as AiModelEntity[], { logger: this.logger, message: 'Residency catalogue read failed' }))
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const system = rows.filter((row) => row.tenantId === SYSTEM_TENANT_ID);
    return {
      byId,
      modelFor(service: string, modelRef: string): AiModelEntity | undefined {
        // Only an LM Studio row: a CLOUD or Ollama row may carry the same wire id and is not what LM Studio holds.
        if (service === 'lm-studio') return system.find((r) => r.wireModelId === modelRef && residencyServiceOf(r) === 'lm-studio');
        if (service === 'nlp') return system.find((r) => r.servedBy === 'nlp' && r.sourceUri === modelRef);
        return system.find((r) => r.slug === modelRef && r.servedBy === 'stt') ?? system.find((r) => r.slug === modelRef);
      },
    };
  }

  // ── engine input ──────────────────────────────────────────────────────────

  private engineInput(ledger: Ledger, now: number): { models: EngineModel[]; devices: EngineDevice[] } {
    const devices: EngineDevice[] = ledger.devices.map(({ id, kind, totalBytes, freeBytes }) => ({ id, kind, totalBytes, freeBytes }));
    const byKey = new Map<string, EngineModel>();

    for (const entry of ledger.entries) {
      if (!isControlled(entry.service)) continue;
      const key = residencyKey(entry.service, entry.modelRef);
      const existing = byKey.get(key);
      if (existing) {
        // A second LM Studio instance of the same key (`<key>:2`) — one pair, two footprints.
        existing.bytes = existing.bytes !== null && entry.bytes !== null ? existing.bytes + entry.bytes : (existing.bytes ?? entry.bytes);
        existing.inFlight += entry.inFlight ?? 0;
        continue;
      }
      const cls = this.classify(entry.service, entry.modelRef, entry.aiModelId, ledger);
      const loadedMs = parseMs(entry.loadedAt) ?? this.firstSeen.get(key) ?? now;
      const usedMs = parseMs(entry.lastUsedAt) ?? loadedMs;
      const lmsTtl = entry.service === 'lm-studio' ? (this.lmsPins.get(entry.modelRef)?.ttlSeconds ?? null) : null;
      byKey.set(key, {
        service: entry.service,
        modelRef: entry.modelRef,
        resident: true,
        devices: entry.devices,
        bytes: entry.bytes,
        inFlight: entry.inFlight ?? 0,
        pinned: cls.class === 'PINNED' || entry.adminPinned,
        agentPinned: entry.adminPinned,
        desiredClass: cls.class,
        classSource: cls.classSource,
        priority: cls.policy?.priority ?? 0,
        idleTtlSeconds: cls.policy?.idleTtlSeconds ?? lmsTtl,
        idleSeconds: Math.max(0, (now - usedMs) / 1000),
        residentSeconds: Math.max(0, (now - loadedMs) / 1000),
        reloadSeconds: entry.loadSeconds ?? ledger.catalogue.modelFor(entry.service, entry.modelRef)?.observedLoadSeconds ?? null,
        loadable: true,
        requestsPerMin: entry.requestsPerMin,
      });
    }

    // Desired but not resident: explicit PINNED/WARM rows and the implicit live path.
    const candidates: Array<{ service: string; modelRef: string | null; aiModelId: string }> = [
      ...ledger.policies
        .filter((p) => p.class !== ModelResidencyClass.ON_DEMAND)
        .map((p) => ({ service: p.service, modelRef: refFor(p.service, ledger.catalogue.byId.get(p.aiModelId)), aiModelId: p.aiModelId })),
      ...ledger.livePath.map((l) => ({ service: l.service, modelRef: l.modelRef, aiModelId: l.aiModelId })),
    ];
    for (const candidate of candidates) {
      const { service, modelRef } = candidate;
      if (!modelRef || !isControlled(service)) continue;
      const key = residencyKey(service, modelRef);
      if (byKey.has(key) || this.operations.runningFor(service, modelRef)) continue;
      const cls = this.classify(service, modelRef, candidate.aiModelId, ledger);
      const model = ledger.catalogue.byId.get(candidate.aiModelId);
      byKey.set(key, {
        service,
        modelRef,
        resident: false,
        devices: this.placementDevices(service, ledger),
        bytes: this.observedBytes(service, modelRef, model) ?? null,
        inFlight: 0,
        pinned: cls.class === 'PINNED',
        agentPinned: false,
        desiredClass: cls.class,
        classSource: cls.classSource,
        priority: cls.policy?.priority ?? 0,
        idleTtlSeconds: cls.policy?.idleTtlSeconds ?? null,
        idleSeconds: 0,
        residentSeconds: 0,
        reloadSeconds: model?.observedLoadSeconds ?? null,
        loadable: true,
        requestsPerMin: 0,
      });
    }
    return { models: [...byKey.values()], devices };
  }

  /** Policy row → implicit live path → default; the policy row wins because it is an explicit operator decision. */
  private classify(service: string, modelRef: string, aiModelId: string | null, ledger: Ledger): Classification {
    const modelId = aiModelId ?? ledger.catalogue.modelFor(service, modelRef)?.id ?? null;
    const policy = modelId ? (ledger.policies.find((p) => p.aiModelId === modelId && p.service === service) ?? null) : null;
    if (policy) return { class: policy.class as ResidencyClassName, classSource: 'policy', policy };
    if (ledger.livePath.some((l) => l.service === service && l.modelRef === modelRef)) {
      return { class: 'PINNED', classSource: 'implicit-live-path', policy: null };
    }
    return { class: 'ON_DEMAND', classSource: 'default', policy: null };
  }

  /**
   * The SYSTEM catalogue row a (service, model) pair maps to — from the ledger
   * when it is there, else by ONE direct read: an operator may load a model no
   * report, policy or live path has named yet, and its measured footprint (and
   * the row it is written back to) must not be missed for that reason.
   */
  private async catalogueModel(service: ResidencyControlledService, modelRef: string, ledger: Ledger): Promise<AiModelEntity | undefined> {
    const known = ledger.catalogue.modelFor(service, modelRef);
    if (known) return known;
    const field = service === 'lm-studio' ? 'wireModelId' : service === 'nlp' ? 'sourceUri' : 'slug';
    const rows = await this.aiModels
      .findAll({ filters: { tenantId: SYSTEM_TENANT_ID, [field]: modelRef } as never })
      .catch(
        warnAndFallback([] as AiModelEntity[], {
          logger: this.logger,
          message: 'Residency catalogue model lookup failed',
          meta: { service, modelRef },
        }),
      );
    return rows.find(
      (row) =>
        row.tenantId === SYSTEM_TENANT_ID &&
        refFor(service, row) === modelRef &&
        (service !== 'lm-studio' || residencyServiceOf(row) === 'lm-studio'),
    );
  }

  /** The devices a not-yet-resident model of `service` would occupy (D-7: within the workload's visible devices). */
  private placementDevices(service: ResidencyControlledService | string, ledger: Ledger): string[] {
    const gpuIds = ledger.devices.filter((d) => d.kind === 'gpu').map((d) => d.id);
    const allGpus = gpuIds.length > 0 ? gpuIds : ['gpu?'];
    if (service === 'nlp') return ['cpu:nlp'];
    if (service === 'stt') {
      const mapped = [...this.instanceGpu].filter(([key]) => key.startsWith('stt|')).map(([, gpu]) => gpu);
      return mapped.length > 0 ? [mapped[0]] : allGpus;
    }
    return allGpus;
  }

  /**
   * Headroom-adjusted free memory for a load on `devices`. LM Studio splits a
   * model over both cards, so its budget is the POOL; any other service holds
   * one card, so when its card is not yet mapped the budget is the SMALLEST
   * candidate card — never the pool, which it could not use.
   */
  private availableBytes(service: string, devices: string[], ledger: Ledger, settings: ResidencySettings): number {
    const usable = ledger.devices.filter((d) => devices.includes(d.id)).map((d) => usableBytes(d, settings));
    if (usable.length === 0) return 0;
    return service === 'lm-studio' ? usable.reduce((sum, bytes) => sum + bytes, 0) : Math.min(...usable);
  }

  /** A MEASURED footprint for a model, or `undefined`: this process's own LM Studio measurement, else the catalogue's observed size. */
  private observedBytes(service: string, modelRef: string, model: { observedMemoryMb?: number | null } | undefined): number | undefined {
    if (service === 'lm-studio') {
      const footprint = this.lmsFootprint.get(modelRef);
      if (footprint) return footprint.bytes;
    }
    return model?.observedMemoryMb ? model.observedMemoryMb * MiB : undefined;
  }

  // ── view mapping ──────────────────────────────────────────────────────────

  private toViewModel(entry: LedgerEntry, ledger: Ledger): ModelResidencyModel {
    const cls = this.classify(entry.service, entry.modelRef, entry.aiModelId, ledger);
    return {
      service: entry.service,
      instance: entry.instance,
      modelRef: entry.modelRef,
      aiModelId: entry.aiModelId,
      aiModelName: entry.aiModelName,
      device: entry.device,
      state: entry.state,
      bytes: entry.bytes,
      bytesSource: entry.bytesSource,
      inFlight: entry.inFlight,
      requestsPerMin: entry.requestsPerMin,
      p50LatencyMs: entry.p50LatencyMs,
      loadedAt: entry.loadedAt,
      lastUsedAt: entry.lastUsedAt,
      loadSeconds: entry.loadSeconds,
      class: cls.class,
      classSource: cls.classSource,
      ttlSeconds: cls.policy?.idleTtlSeconds ?? entry.ttlSeconds,
      pinned: cls.class === 'PINNED' || entry.reportedPinned || entry.adminPinned,
      adminPinned: entry.adminPinned,
      policyId: cls.policy?.id ?? null,
      policyVersion: cls.policy?.version ?? null,
    };
  }

  /** A `state: loading` row for a model an admitted operation is loading. */
  private loadingView(service: ResidencyControlledService, modelRef: string, ledger: Ledger, pin: boolean): ModelResidencyModel {
    const model = ledger.catalogue.modelFor(service, modelRef);
    const devices = this.placementDevices(service, ledger);
    const bytes = this.observedBytes(service, modelRef, model) ?? null;
    const entry: LedgerEntry = {
      service,
      instance: this.lastReports.get(service)?.report.instance ?? service,
      modelRef,
      aiModelId: model?.id ?? null,
      aiModelName: model?.name ?? null,
      device: service === 'lm-studio' ? 'multi' : devices.length === 1 ? devices[0] : 'unknown',
      devices,
      state: 'loading',
      bytes,
      bytesSource: bytes ? 'measured' : 'unknown',
      inFlight: 0,
      requestsPerMin: null,
      p50LatencyMs: null,
      loadedAt: null,
      lastUsedAt: null,
      loadSeconds: null,
      ttlSeconds: null,
      reportedPinned: pin,
      adminPinned: pin,
      cache: 'unknown',
    };
    return this.toViewModel(entry, ledger);
  }

  /** A row for a model the agent just answered about but the ledger did not (yet) list. */
  private entryFromReport(
    service: ResidencyControlledService,
    reported: ReportedResidentModel | null,
    modelRef: string,
    ledger: Ledger,
  ): LedgerEntry {
    const model = ledger.catalogue.modelFor(service, modelRef);
    return {
      service,
      instance: this.lastReports.get(service)?.report.instance ?? service,
      modelRef,
      aiModelId: reported?.aiModelId ?? model?.id ?? null,
      aiModelName: model?.name ?? null,
      device: reported?.device ?? 'unknown',
      devices: [],
      state: reported?.state ?? 'loaded',
      bytes: reported?.bytes ?? null,
      bytesSource: reported?.bytesSource ?? 'unknown',
      inFlight: reported?.inFlight ?? null,
      requestsPerMin: null,
      p50LatencyMs: null,
      loadedAt: reported?.loadedAt ?? null,
      lastUsedAt: reported?.lastUsedAt ?? null,
      loadSeconds: reported?.loadSeconds ?? null,
      ttlSeconds: reported?.ttlSeconds ?? this.lmsPins.get(modelRef)?.ttlSeconds ?? null,
      reportedPinned: reported?.pinned ?? this.lmsPins.has(modelRef),
      adminPinned: reported?.adminPinned ?? this.lmsPins.has(modelRef),
      cache: reported?.cache ?? 'unknown',
    };
  }
}

// ── module-private helpers ──────────────────────────────────────────────────

interface GpuReading {
  id: string;
  name: string;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
  utilisationPercent: number | null;
}

interface ModelMetrics {
  running: PrometheusSample[];
  rate: PrometheusSample[];
  p50: PrometheusSample[];
  workerResident: PrometheusSample[];
  workerBytes: PrometheusSample[];
}

interface ModelUsageIndex {
  get(service: string, modelRef: string): { inFlight: number | null; requestsPerMin: number | null; p50LatencyMs: number | null };
}

/**
 * Per-(service, model) usage from the uniform per-model series. LM Studio has
 * no metrics of its own, so its usage is what the services CALLING it (text,
 * guardrail, harness) report for that model name.
 */
function indexModelMetrics(metrics: ModelMetrics): ModelUsageIndex {
  const sum = (samples: PrometheusSample[]) => {
    const out = new Map<string, number>();
    for (const s of samples) {
      const key = `${metricService(s.metric)}|${s.metric.model}`;
      out.set(key, (out.get(key) ?? 0) + s.value);
    }
    return out;
  };
  const running = sum(metrics.running);
  const rate = sum(metrics.rate);
  const p50 = new Map(metrics.p50.map((s) => [`${metricService(s.metric)}|${s.metric.model}`, s.value]));
  const callerTotal = (map: Map<string, number>, modelRef: string): number | null => {
    let total: number | null = null;
    for (const [key, value] of map) {
      const [service, model] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      if (model === modelRef && !['stt', 'stt-worker', 'nlp'].includes(service)) total = (total ?? 0) + value;
    }
    return total;
  };
  const round = (value: number | null | undefined, digits = 2) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

  return {
    get(service: string, modelRef: string) {
      if (service === 'lm-studio') {
        let p50Seconds: number | null = null;
        for (const [key, value] of p50) if (key.endsWith(`|${modelRef}`) && key.startsWith('text|')) p50Seconds = value;
        return {
          inFlight: callerTotal(running, modelRef),
          requestsPerMin: round(callerTotal(rate, modelRef)),
          p50LatencyMs: p50Seconds === null ? null : Math.round(p50Seconds * 1000),
        };
      }
      const key = `${service}|${modelRef}`;
      const p50Seconds = p50.get(key);
      return {
        inFlight: running.has(key) ? (running.get(key) ?? null) : null,
        requestsPerMin: rate.has(key) ? round(rate.get(key)) : null,
        p50LatencyMs: p50Seconds === undefined ? null : Math.round(p50Seconds * 1000),
      };
    },
  };
}

/** DTO options (nullable) → the adapter's documented REST keys (absent when null). */
function lmStudioOptions(options: LmStudioResidencyLoadOptions | null | undefined): LmStudioLoadOptions {
  const out: LmStudioLoadOptions = {};
  if (!options) return out;
  if (options.contextLength != null) out.contextLength = options.contextLength;
  if (options.evalBatchSize != null) out.evalBatchSize = options.evalBatchSize;
  if (options.flashAttention != null) out.flashAttention = options.flashAttention;
  if (options.numExperts != null) out.numExperts = options.numExperts;
  if (options.offloadKvCacheToGpu != null) out.offloadKvCacheToGpu = options.offloadKvCacheToGpu;
  return out;
}

function toPolicyResponse(entity: ModelResidencyPolicyEntity): ModelResidencyPolicyResponse {
  return {
    id: entity.id,
    aiModelId: entity.aiModelId,
    service: entity.service,
    class: entity.class as ResidencyClassName,
    idleTtlSeconds: entity.idleTtlSeconds ?? null,
    priority: entity.priority,
    maxInstances: entity.maxInstances,
    preferredDevice: entity.preferredDevice ?? null,
    _version: entity.version,
    version: entity.version,
    updatedAt: entity.updatedAt.toISOString(),
    updatedBy: entity.updatedBy ?? null,
  };
}

function validateOr400(entity: ModelResidencyPolicyEntity): void {
  try {
    entity.validate();
  } catch (error) {
    if (error instanceof BusinessException) throw new BadRequestException(error.message);
    throw error;
  }
}

/** `{code, message}` for an operation record — the admin error vocabulary. */
function describeError(error: unknown): { code: string; message: string } {
  const mapped = toHttpException(error);
  if (mapped && typeof mapped === 'object' && 'getResponse' in mapped && typeof mapped.getResponse === 'function') {
    const body = mapped.getResponse() as { code?: string; message?: string } | string;
    if (typeof body === 'object' && body.code) return { code: body.code, message: String(body.message ?? '') };
  }
  return { code: 'LOAD_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * The typed failures of the agents, the LM Studio adapter and the spec builder
 * as HTTP, in the admin fixture's error vocabulary (`{ code, message, … }`).
 */
function toHttpException(error: unknown): unknown {
  if (error instanceof ResidencyAgentError) {
    const body = { code: error.code as string, message: error.message, ...(error.inFlight !== undefined ? { inFlight: error.inFlight } : {}) };
    switch (error.code) {
      case 'IN_FLIGHT':
      case 'LOAD_IN_PROGRESS':
        return new ConflictException(body);
      case 'MODEL_UNKNOWN':
        return new NotFoundException(body);
      case 'INSUFFICIENT_MEMORY':
        return new ConflictException({
          ...body,
          code: 'OVER_BUDGET',
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        });
      case 'LOAD_FAILED':
        return error.status >= 500 ? new BadGatewayException(body) : new BadRequestException(body);
      case 'SERVICE_UNREACHABLE':
        return new ServiceUnavailableException(body);
      default:
        return new BadGatewayException({ ...body, code: 'SERVICE_UNREACHABLE' });
    }
  }
  if (error instanceof LmStudioEngineError) {
    const body = { code: error.code as string, message: error.message };
    switch (error.code) {
      case 'MODEL_UNKNOWN':
        return new NotFoundException(body);
      case 'LOAD_IN_PROGRESS':
        return new ConflictException(body);
      case 'ENGINE_NOT_CONFIGURED':
      case 'ENGINE_UNREACHABLE':
        return new ServiceUnavailableException({ ...body, code: 'SERVICE_UNREACHABLE' });
      default:
        return new BadGatewayException({ ...body, code: 'LOAD_FAILED' });
    }
  }
  if (error instanceof ResidencyLoadSpecError) {
    const body = { code: error.code, message: error.message };
    return error.code === 'MODEL_UNKNOWN' ? new NotFoundException(body) : new BadRequestException(body);
  }
  return error;
}
