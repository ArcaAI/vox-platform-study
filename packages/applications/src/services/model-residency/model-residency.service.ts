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
import { ArgumentInvalidException, BusinessException, DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ClsService } from 'nestjs-cls';
import { fallbackOnNotFound, warnAndFallback } from '../../common/swallow-policy';
import { BaseService } from '../../common/base.service';
import { isSuperAdmin } from '../../common/tenant-guards';
import type { IActiveUserContext } from '../../interfaces';
import { LmStudioEngineClient, LmStudioEngineError, type LmStudioLoadOptions } from '../inference-engine/lmstudio-engine.client';
import { IPrometheusQueryService, type PrometheusSample } from '../platform-metrics/prometheus-query.service';
import {
  MODEL_RESIDENCY_DEFAULTS,
  RESIDENCY_SHADOW_REVIEWED_AT_KEY,
  type ModelResidencySettingKey,
} from '../settings-registry/descriptors/model-residency.descriptors';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import type {
  CreateModelResidencyPolicyRequest,
  DismissModelResidencySuggestionResponse,
  LinkModelResidencyRuntimeKeyRequest,
  LinkModelResidencyRuntimeKeyResponse,
  LmStudioResidencyLoadOptions,
  LoadModelResidencyRequest,
  ModelResidencyCatalogueResponse,
  ModelResidencyDevice,
  ModelResidencyFreshness,
  ModelResidencyLoadPreviewResponse,
  ModelResidencyModel,
  ModelResidencyOperationResponse,
  ModelResidencyPinResponse,
  ModelResidencyPolicyResponse,
  ModelResidencyPreviewModel,
  ModelResidencyReadinessCheck,
  ModelResidencyReadinessResponse,
  ModelResidencyRecommendation,
  ModelResidencyUnloadResponse,
  ModelResidencyUsage,
  ModelResidencyViewResponse,
  PinModelResidencyRequest,
  UnloadModelResidencyRequest,
  UpdateModelResidencyPolicyRequest,
} from './dto';
import { ImplicitLivePathReader, type LivePathModel } from './implicit-live-path';
import type { IModelResidencyService, ModelResidencyLoadResult } from './IModelResidencyService';
import { ModelUsageIndexReader, type ModelResidencyUsageIndex } from './model-usage-index';
import {
  type CatalogueRefFields,
  type ReadinessCheckId,
  type ReportedResidentModel,
  type ResidencyBytesSource,
  type ResidencyClassName,
  type ResidencyClassSource,
  type ResidencyControlledService,
  type ResidencyLoadError,
  type ResidencyMode,
  type ResidencyModelState,
  type ResidencyServiceName,
  type ServiceResidencyReport,
  READINESS_CHECK_IDS,
  RESIDENCY_CONTROLLED_SERVICES,
  refFor,
  residencyKey,
  residencyServiceOf,
} from './model-residency.types';
import { PhysicalGpuLoadGate } from './physical-gpu-load-gate';
import { type ResidencyBudget, budgetFor } from './residency-budget';
import { ResidencyAgentClient, ResidencyAgentError } from './residency-agent.client';
import { type CatalogueFailedEntry, buildResidencyCatalogue } from './residency-catalogue';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError } from './residency-load-spec.builder';
import { residencyAdmissionRejectionsTotal, residencyDecisionsTotal } from './residency-metrics';
import { ResidencyOperationRegistry, ResidencyRecommendationStore } from './residency-operations';
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
import { rankRuntimeKeyCandidates, resolveRuntimeKey, runtimeKeysFor } from './runtime-key';

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
/**
 * The status-only residency read (`ModelResidencyService.getLifecycleStates`):
 * per service, which model it holds and in what state. Identity + state only —
 * it is read on behalf of callers who may not see the full catalogue.
 */
export interface ModelResidencyStateSnapshot {
  reportedAt: string | null;
  services: Array<{ service: string; models: Array<{ aiModelId: string | null; slug: string | null; state: string }> }>;
}

/** The usage index the status-only read passes: it never reads cross-tenant usage. */
const EMPTY_RESIDENCY_USAGE: ModelResidencyUsage = {
  agentCount: 0,
  tenantCount: 0,
  liveConsultation: false,
  uses: [],
  consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
};
const NO_USAGE: ModelResidencyUsageIndex = { get: () => EMPTY_RESIDENCY_USAGE };

export const RESIDENCY_TICK_MS = 10_000;
/** A service whose last good report is older than this is `stale` (admin fixture). */
const STALE_AFTER_MS = 30_000;
/** A read reuses the ledger when it is younger than this. */
const LEDGER_REUSE_MS = 5_000;
/** The enforce-mode recommendation log keeps this many entries, newest first. */
const RECOMMENDATION_RING = 200;
/** TASK-1051 F4 — a standing (shadow) recommendation not re-confirmed for this long is stale and omitted. */
const RECOMMENDATION_STALE_MS = 60_000;
/** The view lists at most this many recommendations. */
const RECOMMENDATION_VIEW_LIMIT = 100;
/** TASK-1051 — the platform setting the readiness checklist reads for the recorded shadow review. */
const SHADOW_REVIEWED_AT_KEY = RESIDENCY_SHADOW_REVIEWED_AT_KEY;
/** TASK-1051 — days of shadow observation the readiness checklist asks for (owner OD-1 of TASK-1005). */
const SHADOW_DAYS_REQUIRED = 7;
/**
 * TASK-1051 review — every `action` a residency command records as a `ResourceUpdated` sys-event on
 * `ResourceType.ModelResidencyPolicy` (the audit trail; the administrator is the event's actor).
 * Every broadcast goes through `audit()`, which only takes these, and the readiness checklist's
 * `actions_audited` lists them — so the check states what the code does, not what it hopes.
 */
export const RESIDENCY_AUDIT_ACTIONS = [
  'model-residency.load',
  'model-residency.replace',
  'model-residency.load.succeeded',
  'model-residency.load.failed',
  'model-residency.replace.succeeded',
  'model-residency.replace.failed',
  'model-residency.unload',
  'model-residency.pin',
  'model-residency.unpin',
  'model-residency.link',
  'model-residency.suggestion.dismiss',
  'model-residency.policy.unload',
  'model-residency.policy.pin',
  'model-residency.policy.unpin',
] as const;
type ResidencyAuditAction = (typeof RESIDENCY_AUDIT_ACTIONS)[number];
/** LM Studio spellings of `AiModel.servedBy` / `provider` (the catalogue read widens to every LM Studio row). */
const LM_STUDIO_SPELLINGS = ['lm-studio', 'lmstudio'];

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
  /** TASK-1051 F1 — the SYSTEM row a service-REPORTED key names (`resolveRuntimeKey`: exact ref → confirmed key → unambiguous normalised). */
  modelFor(service: string, modelRef: string): AiModelEntity | undefined;
  /** The SYSTEM rows read for this ledger (candidates for an unmatched key). */
  rows: AiModelEntity[];
}

interface Ledger {
  at: number;
  devices: Omit<ModelResidencyDevice, 'headroomPercent'>[];
  entries: LedgerEntry[];
  staleServices: string[];
  /** TASK-1051 F7 — the OLDEST report time (the agent's own clock) the ledger is built from; `null` when no service ever reported. */
  oldestReportMs: number | null;
  policies: ModelResidencyPolicyEntity[];
  livePath: LivePathModel[];
  catalogue: CatalogueIndex;
  /** Models whose last load FAILED (TASK-1019): they hold no memory, so they are not `entries`. */
  failures: CatalogueFailedEntry[];
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
  /** The catalogue row (F1: an unload/replace matches the instances the engine reports for it). */
  row?: AiModelEntity;
  /** The SYSTEM rows a reported key is resolved against (review finding 1: never a sibling variant's instance). */
  rows?: readonly AiModelEntity[];
  /** `operator` = a console action (its pin is the operator's); `policy` = the enforce-mode loop (its pin is the controller's). */
  origin: 'operator' | 'policy';
  recommendation?: ModelResidencyRecommendation;
}

/** An instance a replace unloaded, as it was — so a rollback (F9 / OD-5) puts it back with its pin and TTL. */
interface RestorableInstance {
  /** The key to load it under (LM Studio: the reported key without its `:<n>` instance suffix). */
  modelRef: string;
  pinned: boolean;
  ttlSeconds: number | null;
}

/** A reported model that holds memory (anything but `failed`). */
type ResidentReportedModel = ReportedResidentModel & { state: ResidencyModelState };
const isResident = (model: ReportedResidentModel): model is ResidentReportedModel => model.state !== 'failed';

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
  private readonly suggestions = new ResidencyRecommendationStore(RECOMMENDATION_STALE_MS, RECOMMENDATION_RING);
  /** Process start — the window the in-memory shadow counts cover. */
  private readonly startedAt = Date.now();
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
  /** TASK-1019 D-8 — LM Studio's failed loads, kept until the next successful load or unload of that model (in memory; a restart re-observes). */
  private readonly lmsFailures = new Map<string, ResidencyLoadError>();
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
        for (const decision of decisions) this.record(decision, 'shadow', false, ledger);
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
      const outcome = await this.unloadInternal(service, modelRef, false, 'policy');
      this.audit('model-residency.policy.unload', { service, modelRef, outcome });
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
      this.audit(pinned ? 'model-residency.policy.pin' : 'model-residency.policy.unpin', { service, modelRef });
      return true;
    } catch (error) {
      this.logger.warn({ message: 'residency.enforce.pin_failed', service, modelRef, error: String(error) });
      return false;
    }
  }

  /**
   * Record a decision and meter it. SHADOW (TASK-1051 F4): one standing row per
   * conclusion — a repeat refreshes it and is not metered again — and a
   * conclusion the current state already satisfies is not recorded at all.
   * ENFORCE: appended to the bounded log, as before.
   */
  private record(
    decision: EngineDecision,
    mode: ResidencyMode,
    applied: boolean,
    ledger?: Ledger,
    now = Date.now(),
  ): ModelResidencyRecommendation | undefined {
    let recommendation: ModelResidencyRecommendation;
    if (mode === 'shadow') {
      if (ledger && this.alreadySatisfied(decision, ledger)) return undefined;
      const recorded = this.suggestions.recordShadow(decision, generateId(), now);
      if (!recorded.created) return recorded.recommendation;
      recommendation = recorded.recommendation;
    } else {
      recommendation = this.suggestions.recordEnforce(decision, generateId(), applied, now);
    }
    if (decision.reason === 'admission_rejected')
      residencyAdmissionRejectionsTotal.inc({ reason: decision.bytes === null ? 'no_size' : 'insufficient_memory' });
    else residencyDecisionsTotal.inc({ action: decision.action, mode });
    if (ledger && decision.action === 'load' && this.isDuplicateLoad(decision, ledger)) this.suggestions.counts.duplicateLoads += 1;
    return recommendation;
  }

  /**
   * "Already satisfied" (F4): a pin of a model the RUNTIME already holds pinned (review finding 4 — the
   * controller classifying it PINNED is the reason for the pin, not proof of it), or a load of a model
   * with a MATCHED resident instance.
   */
  private alreadySatisfied(decision: EngineDecision, ledger: Ledger): boolean {
    const modelId = ledger.catalogue.modelFor(decision.service, decision.modelRef)?.id ?? null;
    if (decision.action === 'pin') {
      return ledger.entries.some((e) => e.service === decision.service && e.modelRef === decision.modelRef && (e.adminPinned || e.reportedPinned));
    }
    if (decision.action === 'load') {
      return ledger.entries.some(
        (e) => e.service === decision.service && (e.modelRef === decision.modelRef || (modelId !== null && e.aiModelId === modelId)),
      );
    }
    return false;
  }

  /** A load of a model that sat resident under a key nobody matched to it, although a `strong` candidate says it is that model (the pre-F1 double load). */
  private isDuplicateLoad(decision: EngineDecision, ledger: Ledger): boolean {
    const modelId = ledger.catalogue.modelFor(decision.service, decision.modelRef)?.id;
    if (!modelId) return false;
    return ledger.entries.some(
      (e) =>
        e.service === decision.service &&
        e.aiModelId !== modelId &&
        rankRuntimeKeyCandidates(e.service, e.modelRef, ledger.catalogue.rows).some((c) => c.strength === 'strong' && c.aiModelId === modelId),
    );
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
      freshness: this.freshness(ledger),
      devices: ledger.devices.map((device) => ({ ...device, headroomPercent: settings.headroomPercent })),
      models,
      recommendations: this.suggestions.visible(Date.now()).slice(0, RECOMMENDATION_VIEW_LIMIT),
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
    const view = await this.buildCatalogueView({ withUsage: true });
    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { surface: 'model-residency.catalogue', models: view.services.reduce((sum, s) => sum + s.models.length, 0) },
    });
    return view;
  }

  /**
   * Which service holds which SYSTEM model, and in what state — NOTHING else.
   *
   * Deliberately UNGATED: the tenant-visible registry list derives each row's
   * one-word lifecycle status from it, and a tenant admin may read that list.
   * What makes that safe is the projection, not a gate: no placement (device,
   * bytes, in-flight, request rates), no load errors, and no usage — the
   * cross-tenant usage index is never even read on this path. The full view
   * stays behind `getCatalogue` and its platform-admin gate.
   */
  async getLifecycleStates(): Promise<ModelResidencyStateSnapshot> {
    const view = await this.buildCatalogueView({ withUsage: false });
    return {
      reportedAt: view.reportedAt ?? null,
      services: view.services.map((group) => ({
        service: String(group.service),
        models: group.models.map((model) => ({
          aiModelId: model.aiModelId ?? null,
          slug: model.slug ?? null,
          state: String(model.status),
        })),
      })),
    };
  }

  private async buildCatalogueView(opts: { withUsage: boolean }): Promise<ModelResidencyCatalogueResponse> {
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
    const usage = opts.withUsage
      ? await this.usage.read(
          catalogue.map((row) => row.id),
          now,
        )
      : NO_USAGE;

    return buildResidencyCatalogue({
      now,
      mode: settings.enforce ? 'enforce' : 'shadow',
      reportedAt: iso(ledger.at),
      freshness: this.freshness(ledger, now),
      headroomPercent: settings.headroomPercent,
      devices: ledger.devices,
      staleServices: ledger.staleServices,
      entries: ledger.entries,
      failed: ledger.failures,
      loading: this.operations.running().map((op) => ({ service: op.service, modelRef: op.modelRef })),
      catalogue,
      modelById: (id) => ledger.catalogue.byId.get(id),
      usage,
      classify: (service, modelRef, aiModelId) => this.classify(service, modelRef, aiModelId, ledger),
      observedBytes: (service, modelRef, model) => this.observedBytes(service, modelRef, model),
      observedLoadSeconds: (service, modelRef, model) =>
        (service === 'lm-studio' ? this.lmsFootprint.get(modelRef)?.loadSeconds : undefined) ?? model?.observedLoadSeconds ?? null,
      // F4 — only live, non-dismissed standing rows (the builder projects and caps them).
      recommendations: this.suggestions.visible(now),
    });
  }

  async load(request: LoadModelResidencyRequest): Promise<ModelResidencyLoadResult> {
    this.assertPlatformAdmin('load a model');
    const { service, modelRef } = request;
    const force = request.force === true;
    const reason = request.reason?.trim() || null;
    const replace = request.replace === true;
    assertOptionsSupported(request);

    const settings = await this.readSettings();
    const ledger = await this.currentLedger();
    const row = await this.catalogueModel(service, modelRef, ledger);
    const admission = this.assessAdmission(service, modelRef, replace, row, ledger, settings);
    const { resident } = admission;

    if (admission.refusal === 'ALREADY_LOADED') {
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

    const loadSpec =
      service === 'lm-studio'
        ? null
        : await this.specs
            .build(service, modelRef, resident[0]?.cache ?? this.lastSeenCache.get(residencyKey(service, modelRef)))
            .catch((error: unknown) => {
              throw toHttpException(error);
            });

    // ── budget (TASK-1051 F8): measured footprint, else the catalogue size × 1.2; no size at all is refused ──
    const { devices, need, availableBytes } = admission;
    const noSize = admission.refusal === 'NO_SIZE';
    const overBudget = admission.refusal === 'OVER_BUDGET';
    if (noSize && !(force && reason)) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'no_size' });
      throw new ConflictException({
        code: 'NO_SIZE',
        message:
          `'${modelRef}' has never been measured and its catalogue entry has no memory size, so its footprint on ${devices.join(', ')} is unknown. ` +
          'Set the model`s memory size in the catalogue, or re-send with `force: true` AND a non-empty `reason` to load it anyway (audited).',
        devices,
      });
    }
    if (overBudget && !(force && reason)) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'over_budget' });
      throw new ConflictException({
        code: 'OVER_BUDGET',
        message:
          `Loading '${modelRef}' needs ${need.bytes} bytes (${need.source}) but ${availableBytes} are free on ${devices.join(', ')} after the ${settings.headroomPercent}% headroom. ` +
          'The cards are time-sliced and give no memory isolation, so an over-budget load can OOM every workload on them. ' +
          'Re-send with `force: true` AND a non-empty `reason` to proceed anyway (audited).',
        needBytes: need.bytes,
        needSource: need.source,
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
      aiModelId: row?.id ?? resident[0]?.aiModelId ?? null,
      row,
      rows: catalogueRows(ledger, row),
      origin: 'operator',
    });

    // A platform-disruptive action on shared, time-sliced cards stays attributable to the administrator who took it.
    this.audit(`model-residency.${action}`, {
      operationId: opId,
      service,
      modelRef,
      pin: request.pin === true,
      force,
      reason,
      overBudget,
      noSize,
      needBytes: need.bytes,
      needSource: need.source,
    });

    return {
      status: 202,
      body: { outcome: 'accepted', operationId: opId, model: this.loadingView(service, modelRef, ledger, request.pin === true) },
    };
  }

  /**
   * TASK-1051 — what `load(request)` would decide, with NO side effects: no
   * command, no operation, no recommendation, no audit. The arithmetic is
   * `assessAdmission`, the same call `load` makes, so the two cannot disagree.
   */
  async previewLoad(request: LoadModelResidencyRequest): Promise<ModelResidencyLoadPreviewResponse> {
    this.assertPlatformAdmin('preview a model load');
    const { service, modelRef } = request;
    assertOptionsSupported(request);

    const settings = await this.readSettings();
    const ledger = await this.currentLedger();
    const row = await this.catalogueModel(service, modelRef, ledger);
    const admission = this.assessAdmission(service, modelRef, request.replace === true, row, ledger, settings);
    const inFlight = admission.resident.reduce((sum, e) => sum + (e.inFlight ?? 0), 0);
    const blocked: 'LOAD_IN_PROGRESS' | 'IN_FLIGHT' | null =
      this.operations.runningFor(service, modelRef) || admission.devices.some((d) => this.gate.holderOf(d) !== undefined)
        ? 'LOAD_IN_PROGRESS'
        : request.replace === true && inFlight > 0
          ? 'IN_FLIGHT'
          : null;

    const now = Date.now();
    const targets = new Set(admission.resident);
    const neighbours = ledger.entries.filter((e) => !targets.has(e) && e.devices.some((d) => admission.scope.includes(d)));
    const evictable: Array<ModelResidencyPreviewModel & { sortBytes: number }> = [];
    const pinned: ModelResidencyPreviewModel[] = [];
    for (const entry of neighbours) {
      const cls = this.classify(entry.service, entry.modelRef, entry.aiModelId, ledger);
      const base = { service: entry.service, modelRef: entry.modelRef, name: entry.aiModelName ?? entry.modelRef, bytes: entry.bytes };
      if (cls.class === 'PINNED' || entry.adminPinned || entry.reportedPinned) {
        pinned.push({ ...base, reason: pinReason(cls.classSource, cls.class === 'PINNED') });
      } else if (cls.class === 'ON_DEMAND' && (entry.inFlight ?? 0) === 0) {
        const idleSince = parseMs(entry.lastUsedAt) ?? parseMs(entry.loadedAt) ?? this.firstSeen.get(residencyKey(entry.service, entry.modelRef));
        evictable.push({
          ...base,
          reason: idleSince === undefined || idleSince === null ? 'On demand · never used' : `On demand · idle ${humanDuration(now - idleSince)}`,
          sortBytes: entry.bytes ?? -1,
        });
      }
    }

    return {
      service,
      modelRef,
      device: admission.device,
      needBytes: admission.need.bytes,
      needSource: admission.need.source,
      freeBytes: admission.freeBytes,
      headroomBytes: admission.headroomBytes,
      unattributedBytes: admission.unattributedBytes,
      shortfallBytes: admission.shortfallBytes,
      // Review finding 5 — `fits` is what an un-forced load() would answer: besides the budget, a running load of the
      // same model and a card another load holds are LOAD_IN_PROGRESS, and a replace of a serving model is IN_FLIGHT.
      // `refusal` names the FIRST reason an un-forced load would be refused: the budget answer, else the blocker.
      fits: admission.refusal === null && blocked === null,
      refusal: admission.refusal ?? blocked,
      evictable: evictable.sort((a, b) => b.sortBytes - a.sortBytes).map(({ sortBytes: _sortBytes, ...model }) => model),
      pinned,
      // TASK-1055 wave-0 contract placeholders — filled by the gateway lane (per-device candidates + suggestion).
      candidates: [],
      suggestedDevice: null,
      suggestionReason: null,
    };
  }

  /**
   * The ONE admission computation (`load` and `previewLoad`). Need =
   * `budgetFor(measured, memorySizeMb)` — on a replace, the measured footprint is
   * the resident one, and those bytes come back before the new load. A service
   * that holds one card is budgeted against its mapped card, or (unmapped) the
   * TIGHTEST candidate card; LM Studio against the pool of every card.
   */
  private assessAdmission(
    service: ResidencyControlledService,
    modelRef: string,
    replace: boolean,
    row: AiModelEntity | undefined,
    ledger: Ledger,
    settings: ResidencySettings,
  ): Admission {
    const resident = this.residentFor(service, modelRef, row, ledger);
    const devices = resident[0]?.devices ?? this.placementDevices(service, ledger);
    const residentBytes = resident.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
    const credit = replace ? residentBytes : 0;
    const need = budgetFor(replace && residentBytes > 0 ? residentBytes : this.observedBytes(service, modelRef, row), row?.memorySizeMb);

    const readings = devices.map((id) => this.deviceReading(id, ledger)).filter((d): d is DeviceReading => d !== undefined);
    const headroomOf = (d: DeviceReading) => d.totalBytes * (settings.headroomPercent / 100);
    let scope: DeviceReading[];
    if (service === 'lm-studio') scope = readings;
    else {
      const tightest = [...readings].sort((a, b) => usableBytes(a, settings) - usableBytes(b, settings))[0];
      scope = tightest ? [tightest] : [];
    }
    const sum = (f: (d: DeviceReading) => number) => scope.reduce((total, d) => total + f(d), 0);
    const freeBytes = scope.length > 0 ? sum((d) => d.freeBytes) : null;
    const headroomBytes = scope.length > 0 ? sum(headroomOf) : null;
    const availableBytes = sum((d) => usableBytes(d, settings)) + credit;

    const ids = scope.map((d) => d.id);
    const attributed = ledger.entries
      .filter((e) => e.bytesSource === 'measured' && e.bytes && e.devices.length > 0)
      .reduce((total, e) => total + ((e.bytes ?? 0) / e.devices.length) * e.devices.filter((d) => ids.includes(d)).length, 0);
    const unattributedBytes = scope.length > 0 ? Math.max(0, Math.round(sum((d) => d.usedBytes) - attributed)) : null;

    // Review finding 5 — the SAME per-card clamped availability `refusal` is decided on (a card below its headroom offers 0, never a negative).
    const shortfallBytes = need.bytes === null ? 0 : Math.max(0, Math.round(need.bytes - availableBytes));
    let refusal: Admission['refusal'] = null;
    if (resident.length > 0 && !replace) refusal = 'ALREADY_LOADED';
    else if (need.bytes === null) refusal = 'NO_SIZE';
    else if (need.bytes > availableBytes) refusal = 'OVER_BUDGET';

    const device = service === 'lm-studio' ? 'multi' : (resident[0]?.device ?? (devices.length === 1 ? devices[0] : null));
    return { resident, devices, device, scope: ids, need, freeBytes, headroomBytes, unattributedBytes, availableBytes, shortfallBytes, refusal };
  }

  /** A device's memory reading: a DCGM card or a listed host pool, else the host pool a service reports even with nothing loaded. */
  private deviceReading(id: string, ledger: Ledger): DeviceReading | undefined {
    const listed = ledger.devices.find((d) => d.id === id);
    if (listed) return listed;
    if (!id.startsWith('cpu:')) return undefined;
    const service = id.slice('cpu:'.length);
    const cpu = isControlled(service) ? this.lastReports.get(service)?.report.devices.find((d) => d.kind === 'cpu') : undefined;
    return cpu
      ? { id, kind: 'cpu', totalBytes: cpu.totalBytes, freeBytes: cpu.freeBytes, usedBytes: Math.max(0, cpu.totalBytes - cpu.freeBytes) }
      : undefined;
  }

  /**
   * The resident instances of a (service, model): the exact key when the service holds it; otherwise (F1) the
   * instances RESOLVED to the same catalogue row (`aiModelId`, set through `resolveRuntimeKey`). Never a sibling
   * variant's instance (review finding 6): `foo@q8_0` resolves to its own row, and an ambiguous key to none.
   */
  private residentFor(service: string, modelRef: string, row: (CatalogueRefFields & { id: string }) | undefined, ledger: Ledger): LedgerEntry[] {
    const mine = ledger.entries.filter((e) => e.service === service);
    const exact = mine.filter((e) => e.modelRef === modelRef);
    if (exact.length > 0 || !row) return exact;
    return mine.filter((e) => e.aiModelId === row.id);
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
    const ledger = await this.currentLedger();
    const row = await this.catalogueModel(service, modelRef, ledger);
    if (service === 'lm-studio' && !force) {
      // LM Studio refuses nothing on its own; the in-flight guard is the controller's (from `model_running_instances`).
      const inFlight = this.residentFor(service, modelRef, row, ledger).reduce((sum, e) => sum + (e.inFlight ?? 0), 0);
      if (inFlight > 0) {
        throw new ConflictException({
          code: 'IN_FLIGHT',
          message: `${modelRef} is serving ${inFlight} request(s); pass force=true to unload anyway`,
          inFlight,
        });
      }
    }

    const outcome = await this.unloadInternal(service, modelRef, force, 'admin', row, catalogueRows(ledger, row)).catch((error: unknown) => {
      throw toHttpException(error);
    });

    // F10 — the operator's reason is on the audit event whether or not the unload was forced (the agent wire keeps its `admin` verb).
    this.audit('model-residency.unload', { service, modelRef, force, reason, outcome });
    return { outcome, service, modelRef };
  }

  async pin(request: PinModelResidencyRequest): Promise<ModelResidencyPinResponse> {
    this.assertPlatformAdmin('pin a model');
    const { service, modelRef, pinned } = request;
    const key = residencyKey(service, modelRef);

    let reported: ReportedResidentModel | null = null;
    if (service === 'lm-studio') {
      const ledger = await this.currentLedger();
      if (this.residentFor(service, modelRef, ledger.catalogue.modelFor(service, modelRef), ledger).length === 0) {
        throw new NotFoundException({ code: 'MODEL_UNKNOWN', message: `LM Studio holds no loaded instance of '${modelRef}'.` });
      }
      if (pinned)
        this.lmsPins.set(modelRef, {
          ttlSeconds: request.ttlSeconds !== undefined ? request.ttlSeconds : (this.lmsPins.get(modelRef)?.ttlSeconds ?? null),
        });
      else {
        // F1 — a pin may have been taken under the engine's key or the catalogue ref; an unpin clears both.
        this.lmsPins.delete(modelRef);
        for (const e of this.residentFor(service, modelRef, ledger.catalogue.modelFor(service, modelRef), ledger)) this.lmsPins.delete(e.modelRef);
      }
    } else {
      reported = await this.agents
        .setPolicy(service, modelRef, { adminPinned: pinned, ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}) })
        .catch((error: unknown) => {
          throw toHttpException(error);
        });
    }
    // An operator's pin is the operator's; the controller must never later "unpin its own" over it.
    this.controllerPinned.delete(key);

    this.audit(pinned ? 'model-residency.pin' : 'model-residency.unpin', { service, modelRef, ttlSeconds: request.ttlSeconds ?? null });

    this.ledger = null;
    const ledger = await this.currentLedger();
    const entry = this.residentFor(service, modelRef, ledger.catalogue.modelFor(service, modelRef), ledger)[0];
    if (entry) return { model: this.toViewModel(entry, ledger) };
    return { model: this.toViewModel(this.entryFromReport(service, reported, modelRef, ledger), ledger) };
  }

  /**
   * TASK-1051 F1 / D-1 — the operator confirms that a key the service REPORTS is
   * this catalogue row. Stored as `AiModel._metadata.residency.runtimeKeys` (no
   * schema change), matched exactly (ahead of any normalised match) by `resolveRuntimeKey` from the next read on.
   */
  async linkRuntimeKey(request: LinkModelResidencyRuntimeKeyRequest): Promise<LinkModelResidencyRuntimeKeyResponse> {
    this.assertPlatformAdmin('link a runtime key to a model');
    const { service, runtimeKey, aiModelId } = request;
    const entity = await this.aiModels.findById(aiModelId).catch((error: unknown) => {
      if (error instanceof DataNotFoundException) return null;
      throw error;
    });
    if (!entity || entity.tenantId !== SYSTEM_TENANT_ID || entity.resourceStatus === ResourceStatusType.DELETED) {
      throw new NotFoundException({ code: 'MODEL_UNKNOWN', message: `Catalogue model ${aiModelId} not found` });
    }
    const servedBy = residencyServiceOf(entity);
    if (servedBy !== service) {
      throw new BadRequestException({
        code: 'SERVICE_MISMATCH',
        message: `Model '${entity.slug}' is served by ${servedBy ?? 'no residency service'}, not ${service}; link the key to a model that service runs.`,
      });
    }

    // Review finding 1 — a key another row already answers to (its own catalogue ref, or a key confirmed on it) resolves
    // there first, so linking it here would never take effect; refuse rather than store a dead link.
    const siblings = (await this.aiModels.findAll({ filters: serviceRowsFilter(service) as never })).filter(
      (row) => row.id !== entity.id && row.tenantId === SYSTEM_TENANT_ID && residencyServiceOf(row) === service,
    );
    const owner = resolveRuntimeKey(service, runtimeKey, siblings);
    if (owner && owner.via !== 'normalised') {
      throw new ConflictException({
        code: 'RUNTIME_KEY_TAKEN',
        message: `'${runtimeKey}' already names catalogue model '${owner.row.slug}' on ${service} (${owner.via === 'exact' ? 'its catalogue key' : 'a confirmed link'}); unlink it there first.`,
        aiModelId: owner.row.id,
      });
    }

    // Review finding 9 — a versioned write (`_version` bumps, a concurrent edit is detected) merged into the row's
    // LATEST `_metadata`; one drift re-reads and retries, a second propagates.
    const write = async (current: AiModelEntity): Promise<{ updated: AiModelEntity; alreadyLinked: boolean }> => {
      const metaData: Record<string, unknown> = { ...((current.metaData as Record<string, unknown> | null | undefined) ?? {}) };
      const residency: Record<string, unknown> = { ...((metaData.residency as Record<string, unknown> | null | undefined) ?? {}) };
      const existing = Array.isArray(residency.runtimeKeys) ? residency.runtimeKeys.filter((k): k is string => typeof k === 'string') : [];
      if (existing.includes(runtimeKey)) return { updated: current, alreadyLinked: true };
      // The setter tracks the change; the versioned update persists exactly the tracked fields.
      current.metaData = { ...metaData, residency: { ...residency, runtimeKeys: [...existing, runtimeKey] } };
      if (this.requestUserId) current.updatedBy = this.requestUserId;
      return { updated: await this.aiModels.updateWithVersion(current.id, current, current.version), alreadyLinked: false };
    };
    let result: { updated: AiModelEntity; alreadyLinked: boolean };
    try {
      result = await write(entity);
    } catch (error) {
      if (!(error instanceof OptimisticConcurrencyException)) throw error;
      result = await write(await this.aiModels.findById(aiModelId));
    }
    // The next read must see the key: drop the ledger (its catalogue index is rebuilt with it).
    if (!result.alreadyLinked) this.ledger = null;

    this.audit('model-residency.link', {
      aiModelId: entity.id,
      service,
      runtimeKey,
      surface: 'model-residency.link',
      alreadyLinked: result.alreadyLinked,
    });
    return { aiModelId: entity.id, service, runtimeKeys: runtimeKeysFor(service, result.updated) };
  }

  /** TASK-1051 F4 — hide a standing recommendation until the controller reaches a different conclusion for that model. */
  async dismissSuggestion(id: string): Promise<DismissModelResidencySuggestionResponse> {
    this.assertPlatformAdmin('dismiss a residency recommendation');
    if (!this.suggestions.dismiss(id, Date.now())) {
      throw new NotFoundException({
        code: 'SUGGESTION_UNKNOWN',
        message: `No standing residency recommendation '${id}' (recommendations are kept in memory, per gateway process; enforce-mode events are history and cannot be dismissed).`,
      });
    }
    this.audit('model-residency.suggestion.dismiss', { suggestionId: id });
    return { id, dismissed: true };
  }

  /**
   * TASK-1051 (artboard 05) — the enforce-readiness checklist. READ-ONLY: the
   * switch stays the `residency.enforce` setting (D-5). Every check states its
   * evidence in plain words; the shadow counts cover this process only.
   */
  async getReadiness(): Promise<ModelResidencyReadinessResponse> {
    this.assertPlatformAdmin('read enforce readiness');
    const [settings, ledger, reviewedAt] = await Promise.all([this.readSettings(), this.currentLedger(), this.readShadowReviewedAt()]);
    const now = Date.now();
    const since = iso(this.startedAt);

    const unmatched = ledger.entries.filter((e) => !e.aiModelId).map((e) => `${e.service}: ${e.modelRef}`);
    const overHeadroom = ledger.devices
      .filter((d) => d.kind === 'gpu')
      .filter((d) => d.freeBytes < d.totalBytes * (settings.headroomPercent / 100))
      .map(
        (d) =>
          `${d.id} has ${formatBytes(d.freeBytes)} free, below the ${settings.headroomPercent}% headroom (${formatBytes(d.totalBytes * (settings.headroomPercent / 100))})`,
      );
    // Review finding 8 — observation days run from process start (the log is in memory): a quiet fleet still accrues them.
    const shadowDays = Math.max(0, (now - this.startedAt) / 86_400_000);
    const consumers = this.livePath.status();
    const usageProblem =
      consumers.error !== null
        ? `The consumer snapshot failed to refresh (${consumers.error}); usage and the live path may be stale or empty.`
        : consumers.at === null
          ? 'No consumer snapshot has been read yet.'
          : consumers.liveAssignments > 0 && consumers.consumers === 0
            ? `The snapshot saw ${consumers.liveAssignments} live assignment(s) but counted no consumer of any model.`
            : null;
    const unbudgeted = ledger.livePath
      .filter((l) => {
        const model = ledger.catalogue.byId.get(l.aiModelId);
        return budgetFor(this.observedBytes(l.service, l.modelRef, model), model?.memorySizeMb).bytes === null;
      })
      .map((l) => `${l.service}: ${ledger.catalogue.byId.get(l.aiModelId)?.name ?? l.modelRef}`);

    const checks: Record<ReadinessCheckId, Omit<ModelResidencyReadinessCheck, 'id'>> = {
      shadow_review_recorded: {
        title: 'Shadow review recorded',
        passed: reviewedAt !== null,
        detail: reviewedAt
          ? `Shadow log reviewed on ${reviewedAt} (setting ${SHADOW_REVIEWED_AT_KEY}).`
          : `No review on file (setting ${SHADOW_REVIEWED_AT_KEY} is not set).`,
      },
      instances_matched: {
        title: 'Every resident instance is matched to a catalogue model',
        passed: unmatched.length === 0,
        detail: unmatched.length === 0 ? 'Every resident instance is tied to a catalogue model.' : `Not matched: ${unmatched.join('; ')}.`,
      },
      gpus_inside_headroom: {
        title: 'Every GPU is inside its headroom',
        passed: overHeadroom.length === 0,
        detail: overHeadroom.length === 0 ? `Every GPU has at least ${settings.headroomPercent}% of its memory free.` : `${overHeadroom.join('; ')}.`,
      },
      shared_decision_state: {
        title: 'Decision state shared across gateway replicas',
        passed: false,
        detail: 'Ledger, gate and cool-downs are held per gateway process; a shared lock is required before enforce.',
      },
      shadow_days: {
        title: `At least ${SHADOW_DAYS_REQUIRED} days of shadow observation`,
        passed: shadowDays >= SHADOW_DAYS_REQUIRED,
        detail: `${shadowDays.toFixed(1)} day(s) of observation since this gateway process started (${since}); the log is in memory, so a restart resets the count.`,
      },
      usage_complete: {
        title: 'Usage counts every live-path consumer',
        passed: usageProblem === null,
        detail:
          usageProblem ??
          `Snapshot of ${iso(consumers.at ?? now)}: agents, fallbacks, routing policies, ASR pipeline stages and workflow agent nodes counted for ${consumers.consumers} model(s) across ${consumers.liveAssignments} live assignment(s).`,
      },
      unmeasured_budgeted: {
        title: 'Never-measured models are budgeted',
        passed: unbudgeted.length === 0,
        detail:
          unbudgeted.length === 0
            ? 'Every live-path model has a budget: its measured footprint, else its catalogue size × 1.2.'
            : `No measurement and no catalogue size (a load is refused NO_SIZE, and the controller never places it): ${unbudgeted.join('; ')}.`,
      },
      actions_audited: {
        title: 'Every residency action is audited',
        passed: true,
        detail:
          `Every residency command records a ResourceUpdated event on ${ResourceType.ModelResidencyPolicy} naming the administrator: ${RESIDENCY_AUDIT_ACTIONS.join(', ')}. ` +
          'Policy create / update / delete record ResourceCreated / ResourceUpdated / ResourceDeleted on the policy row.',
      },
    };
    const list = READINESS_CHECK_IDS.map((id) => ({ id, ...checks[id] }));
    const counts = this.suggestions.counts;

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { surface: 'model-residency.readiness' } });
    return {
      mode: settings.enforce ? 'enforce' : 'shadow',
      passed: list.filter((c) => c.passed).length,
      total: list.length,
      checks: list,
      shadow: {
        since,
        loads: counts.loads,
        unloads: counts.unloads,
        refusedOverBudget: counts.refusedOverBudget,
        duplicateLoads: counts.duplicateLoads,
      },
    };
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

  /** One audited residency command (`RESIDENCY_AUDIT_ACTIONS`). */
  private audit(action: ResidencyAuditAction, data: Record<string, unknown>): void {
    this.broadcastSysEvent(SysEventType.ResourceUpdated, { data: { action, ...data } });
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
    // Every instance the replace has unloaded so far — filled as it goes, so a part-way failure knows what to restore.
    const unloaded: RestorableInstance[] = [];
    let unloadFinished = false;
    try {
      if (job.action === 'replace') {
        await this.unloadInternal(service, modelRef, job.force, 'admin', job.row, job.rows, unloaded);
        unloadFinished = true;
      }

      const measured = await this.loadOnce(service, modelRef, job.options, job.loadSpec, job.pin);
      if (measured.bytes && job.aiModelId) await this.writeObserved(job.aiModelId, measured.bytes, measured.loadSeconds);

      if (service === 'lm-studio') this.lmsFailures.delete(modelRef);
      this.operations.succeed(job.opId);
      if (job.recommendation) job.recommendation.applied = true;
      if (job.pin && job.origin === 'policy') this.controllerPinned.add(residencyKey(service, modelRef));
      else if (job.pin) this.controllerPinned.delete(residencyKey(service, modelRef));
      this.audit(`model-residency.${job.action}.succeeded`, {
        operationId: job.opId,
        service,
        modelRef,
        bytes: measured.bytes,
        loadSeconds: measured.loadSeconds,
      });
    } catch (error) {
      let failure = describeError(error);
      // F9 (owner default OD-5) — a replace that unloaded the old instance(s) and then failed — to load the new one,
      // or part-way through unloading several — puts back what it unloaded (same model, default load settings, its
      // previous pin and TTL), so "Apply & reload" never leaves the model gone.
      let restored: boolean | null = null;
      const toRestore = [...new Map(unloaded.map((instance) => [instance.modelRef, instance])).values()];
      if (toRestore.length > 0) {
        const errors: string[] = [];
        for (const instance of toRestore) {
          await this.loadOnce(service, instance.modelRef, {}, job.loadSpec, instance.pinned, instance.ttlSeconds).catch((restoreError: unknown) => {
            this.logger.warn({
              message: 'residency.replace.restore_failed',
              operationId: job.opId,
              service,
              modelRef: instance.modelRef,
              ...describeError(restoreError),
            });
            errors.push(describeError(restoreError).message);
          });
        }
        restored = errors.length === 0;
        const what = unloadFinished ? 'the replacement failed to load' : 'the replace failed part-way through unloading';
        failure = {
          ...failure,
          message: restored
            ? `${failure.message} — ${what}; the previous instance was restored with its default settings.`
            : `${failure.message} — ${what} and the previous instance was NOT restored (${errors.join('; ')}); load it again.`,
        };
      }
      if (service === 'lm-studio' && !restored) {
        this.lmsFailures.set(modelRef, { ...failure, message: failure.message.slice(0, 500), at: iso(Date.now()) });
      }
      this.operations.fail(job.opId, failure);
      this.logger.warn({ message: 'residency.load.failed', operationId: job.opId, service, modelRef, ...failure });
      this.audit(`model-residency.${job.action}.failed`, { operationId: job.opId, service, modelRef, error: failure, restored });
    }
  }

  /** One load on the serving process (no bookkeeping beyond what the adapters keep). */
  private loadOnce(
    service: ResidencyControlledService,
    modelRef: string,
    options: LmStudioLoadOptions,
    loadSpec: Record<string, unknown> | null,
    pin: boolean,
    ttlSeconds: number | null = null,
  ): Promise<{ bytes: number | null; loadSeconds: number | null }> {
    return service === 'lm-studio'
      ? this.loadLmStudio(modelRef, options, pin, ttlSeconds)
      : this.loadViaAgent(service, modelRef, loadSpec ?? {}, pin, ttlSeconds);
  }

  private async loadViaAgent(
    service: 'stt' | 'nlp',
    modelRef: string,
    loadSpec: Record<string, unknown>,
    pin: boolean,
    ttlSeconds: number | null = null,
  ): Promise<{ bytes: number | null; loadSeconds: number | null }> {
    const result = await this.agents.load(service, { modelRef, loadSpec, pin, ttlSeconds });
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
    ttlSeconds: number | null = null,
  ): Promise<{ bytes: number | null; loadSeconds: number | null }> {
    const before = await this.readGpuUsed();
    const started = Date.now();
    const result = await this.lmStudio.load(modelRef, options);
    const finished = Date.now();
    if (pin) this.lmsPins.set(modelRef, { ttlSeconds: ttlSeconds ?? this.lmsPins.get(modelRef)?.ttlSeconds ?? null });
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

  /**
   * Unload every instance of (service, model). F1: `modelRef` may be the
   * catalogue ref while the service holds the model under its own key — the
   * command always goes out with the key the SERVICE reports (exact match first,
   * else every instance tied to `row`).
   */
  private async unloadInternal(
    service: ResidencyControlledService,
    modelRef: string,
    force: boolean,
    reason: 'admin' | 'policy',
    row?: AiModelEntity,
    rows: readonly AiModelEntity[] = [],
    /** Filled with each instance as it is unloaded (pin + TTL as they were), so a failed replace can restore them. */
    unloaded?: RestorableInstance[],
  ): Promise<'unloaded' | 'not_loaded'> {
    let outcome: 'unloaded' | 'not_loaded' = 'not_loaded';
    const keys = new Set<string>([modelRef]);
    if (service === 'lm-studio') {
      // A fresh listing, not the ledger: every instance of the key must go, including a `:2` created since the last tick.
      const report = await this.lmStudio.report();
      const instances = reportedInstances(service, report.models, modelRef, row, rows);
      for (const instance of instances) {
        keys.add(instance.modelRef);
        const instanceId = instance.instanceId;
        const pin = this.lmsPins.get(instance.modelRef) ?? this.lmsPins.get(modelRef);
        if ((await this.lmStudio.unload(instanceId)).outcome === 'unloaded') {
          outcome = 'unloaded';
          unloaded?.push({ modelRef: instance.modelRef.replace(/:\d+$/, ''), pinned: pin !== undefined, ttlSeconds: pin?.ttlSeconds ?? null });
        }
        this.lmsLoadedAt.delete(instanceId);
      }
      for (const key of keys) {
        this.lmsPins.delete(key);
        this.lmsFailures.delete(key);
      }
    } else {
      const reported = this.lastReports.get(service)?.report.models.filter(isResident) ?? [];
      const instances = reportedInstances(service, reported, modelRef, row, rows);
      const refs = [...new Set(instances.map((m) => m.modelRef))];
      for (const ref of refs.length > 0 ? refs : [modelRef]) {
        keys.add(ref);
        if ((await this.agents.unload(service, { modelRef: ref, force, reason })).outcome === 'unloaded') {
          outcome = 'unloaded';
          const was = instances.find((m) => m.modelRef === ref);
          unloaded?.push({ modelRef: ref, pinned: was?.adminPinned ?? false, ttlSeconds: was?.ttlSeconds ?? null });
        }
      }
    }
    for (const key of keys) {
      const ledgerKey = residencyKey(service, key);
      this.cooldown.noteUnloaded(ledgerKey, Date.now());
      this.controllerPinned.delete(ledgerKey);
      this.firstSeen.delete(ledgerKey);
    }
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

  /** `residency.shadowReviewedAt` (SYSTEM tier only): an ISO date, or null when no review is on file. */
  private async readShadowReviewedAt(): Promise<string | null> {
    const resolved = await this.effectiveSettings
      .resolveEffective(SHADOW_REVIEWED_AT_KEY, { tenantId: SYSTEM_TENANT_ID })
      .catch(fallbackOnNotFound(null, { logger: this.logger, message: 'Residency setting read failed', meta: { key: SHADOW_REVIEWED_AT_KEY } }));
    const value = resolved?.value;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  /** F7 — freshness from the agents' own report times: the oldest report, and its age now. */
  private freshness(ledger: Ledger, now = Date.now()): ModelResidencyFreshness {
    const oldest = ledger.oldestReportMs;
    return {
      maxAgeSeconds: oldest === null ? 0 : Math.max(0, Math.round((now - oldest) / 1000)),
      staleServices: ledger.staleServices,
      oldestReportAt: oldest === null ? null : iso(oldest),
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
    // F7 — the age of the data is the age of the OLDEST report, by the reporting agent's own clock (its fetch time when it gave none).
    const reportTimes = [...this.lastReports.values()].map((r) => parseMs(r.report.reportedAt) ?? r.receivedAt);
    const oldestReportMs = reportTimes.length > 0 ? Math.min(...reportTimes) : null;

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
    const failures: CatalogueFailedEntry[] = [];
    for (const report of reports) {
      for (const model of report.models) {
        if (!isResident(model)) {
          failures.push(this.failureFrom(report.service, model, catalogue));
          continue;
        }
        entries.push(this.entryFrom(report, model, gpus, gpuIds, devices, catalogue, usage, now));
      }
    }
    for (const sample of metrics.workerResident) {
      if (sample.metric.state === 'failed') {
        failures.push(this.workerFailure(sample, catalogue));
        continue;
      }
      entries.push(this.workerEntry(sample, metrics.workerBytes, catalogue, usage));
    }
    // LM Studio reports no failures of its own: the gateway's record of a failed load stands until it loads, unloads, or is seen resident.
    for (const [modelRef, error] of this.lmsFailures) {
      if (entries.some((e) => e.service === 'lm-studio' && e.modelRef === modelRef)) continue;
      const aiModel = catalogue.modelFor('lm-studio', modelRef);
      failures.push({ service: 'lm-studio', modelRef, aiModelId: aiModel?.id ?? null, aiModelName: aiModel?.name ?? null, error });
    }

    const ledger: Ledger = { at: now, devices, entries, staleServices, oldestReportMs, policies, livePath, catalogue, failures };
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
    model: ResidentReportedModel,
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
    // F1 — LM Studio's callers (text, guardrail, harness) name the model by its catalogue wire id, and the console pins and the
    // controller measures under the key a load was sent with; the engine reports its own key. Both name this instance.
    const catalogueRef = service === 'lm-studio' ? refFor(service, aiModel) : null;
    const lmsKey = <T>(map: Map<string, T>): T | undefined => map.get(model.modelRef) ?? (catalogueRef ? map.get(catalogueRef) : undefined);
    let stats = usage.get(service, model.modelRef);
    if (catalogueRef && catalogueRef !== model.modelRef && stats.inFlight === null && stats.requestsPerMin === null)
      stats = usage.get(service, catalogueRef);

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
      const footprint = lmsKey(this.lmsFootprint);
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
      adminPinned = lmsKey(this.lmsPins) !== undefined;
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
      ttlSeconds: service === 'lm-studio' ? (lmsKey(this.lmsPins)?.ttlSeconds ?? null) : model.ttlSeconds,
      reportedPinned: model.pinned,
      adminPinned,
      cache: model.cache,
      ...(model.instanceId ? { instanceId: model.instanceId } : {}),
    };
  }

  /** A model an agent reports `failed`: it is not resident, but its cache name is remembered so a retry can rebuild its load spec. */
  private failureFrom(service: ResidencyServiceName, model: ReportedResidentModel, catalogue: CatalogueIndex): CatalogueFailedEntry {
    this.lastSeenCache.set(residencyKey(service, model.modelRef), model.cache);
    const aiModel = (model.aiModelId ? catalogue.byId.get(model.aiModelId) : undefined) ?? catalogue.modelFor(service, model.modelRef);
    return {
      service,
      modelRef: model.modelRef,
      aiModelId: model.aiModelId ?? aiModel?.id ?? null,
      aiModelName: aiModel?.name ?? null,
      error: model.error ?? { code: 'LOAD_FAILED', message: '', at: null },
    };
  }

  /** The stt-worker has no report route: `model_resident{state="failed"} == 1` is all it says, so there is no code, message or time. */
  private workerFailure(sample: PrometheusSample, catalogue: CatalogueIndex): CatalogueFailedEntry {
    const modelRef = sample.metric.model ?? 'unknown';
    const aiModel = catalogue.modelFor('stt-worker', modelRef);
    return {
      service: 'stt-worker',
      modelRef,
      aiModelId: aiModel?.id ?? null,
      aiModelName: aiModel?.name ?? null,
      error: {
        code: 'LOAD_FAILED',
        message: 'The stt-worker reports that the last load of this model failed (model_load_failures_total has the error code; its logs the cause).',
        at: null,
      },
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
    const ids = new Set<string>([...policies.map((p) => p.aiModelId), ...livePath.flatMap((l) => [l.aiModelId, ...(l.aiModelIds ?? [])])]);
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
    // F1 — a reported key need not equal the catalogue ref (LM Studio's `@<quant>` / `:<n>`, operator-confirmed keys), so every
    // row of a REPORTING service is read and matched in memory. Bounded by the catalogue, once per 10 s tick.
    for (const service of new Set(reports.filter((r) => r.models.length > 0).map((r) => r.service))) {
      or.push(serviceRowsFilter(service));
    }
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
      rows: system,
      modelFor: (service: string, modelRef: string) => catalogueRowFor(service, system, modelRef),
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
      const lmsTtl = entry.service === 'lm-studio' ? entry.ttlSeconds : null;
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

    // F1 — a model resident under the engine's own key (`<wire>@q4_0`) IS resident: never a second load of it.
    const residentModels = new Set(ledger.entries.filter((e) => e.aiModelId).map((e) => `${e.service}|${e.aiModelId}`));

    // Desired but not resident: explicit PINNED/WARM rows and the implicit live path.
    // A model pinned ONLY as an ASR pipeline stage (VAD, denoise, …) loads with its ASR agent, never on its own (lane B3):
    // it stays PINNED (never idle-unloaded) but is not a load candidate.
    const stageOnly = (aiModelId: string) => ledger.livePath.filter((l) => onLivePathEntry(l, aiModelId)).every((l) => l.role === 'pipeline_stage');
    const candidates: Array<{ service: string; modelRef: string | null; aiModelId: string; loadable: boolean }> = [
      ...ledger.policies
        .filter((p) => p.class !== ModelResidencyClass.ON_DEMAND)
        .map((p) => ({
          service: p.service,
          modelRef: refFor(p.service, ledger.catalogue.byId.get(p.aiModelId)),
          aiModelId: p.aiModelId,
          loadable: true,
        })),
      ...ledger.livePath.map((l) => ({ service: l.service, modelRef: l.modelRef, aiModelId: l.aiModelId, loadable: !stageOnly(l.aiModelId) })),
    ];
    for (const candidate of candidates) {
      const { service, modelRef } = candidate;
      if (!modelRef || !isControlled(service)) continue;
      const key = residencyKey(service, modelRef);
      if (byKey.has(key) || residentModels.has(`${service}|${candidate.aiModelId}`) || this.operations.runningFor(service, modelRef)) continue;
      const cls = this.classify(service, modelRef, candidate.aiModelId, ledger);
      const model = ledger.catalogue.byId.get(candidate.aiModelId);
      byKey.set(key, {
        service,
        modelRef,
        resident: false,
        devices: this.placementDevices(service, ledger),
        // F8 — a never-measured model is placed at its catalogue size × 1.2, not at 0 bytes.
        bytes: budgetFor(this.observedBytes(service, modelRef, model), model?.memorySizeMb).bytes,
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
        loadable: candidate.loadable,
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
    // F1 / lane B3 — the live path names catalogue ROWS: match on the row when it is known, on the (service, key) pair only when it is not.
    // Review finding 2 — every id the pin entry holds (the SAME membership `usage.liveConsultation` is computed from).
    const onLivePath =
      modelId !== null
        ? ledger.livePath.some((l) => onLivePathEntry(l, modelId))
        : ledger.livePath.some((l) => l.service === service && l.modelRef === modelRef);
    if (onLivePath) {
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
      .findAll({ filters: { OR: [{ tenantId: SYSTEM_TENANT_ID, [field]: modelRef }, serviceRowsFilter(service)] } as never })
      .catch(
        warnAndFallback([] as AiModelEntity[], {
          logger: this.logger,
          message: 'Residency catalogue model lookup failed',
          meta: { service, modelRef },
        }),
      );
    return catalogueRowFor(
      service,
      rows.filter((row) => row.tenantId === SYSTEM_TENANT_ID),
      modelRef,
    );
  }

  /** The devices a not-yet-resident model of `service` would occupy (D-7: within the workload's visible devices). */
  private placementDevices(service: ResidencyControlledService | string, ledger: Ledger): string[] {
    const gpuIds = ledger.devices.filter((d) => d.kind === 'gpu').map((d) => d.id);
    const allGpus = gpuIds.length > 0 ? gpuIds : ['gpu?'];
    if (service === 'stt' || service === 'nlp') {
      // The card the service's pod was matched to (TASK-1031: nlp may hold a GPU); nlp without one loads into host memory.
      const mapped = [...this.instanceGpu].filter(([key]) => key.startsWith(`${service}|`)).map(([, gpu]) => gpu);
      if (mapped.length > 0) return [mapped[0]];
      return service === 'nlp' ? ['cpu:nlp'] : allGpus;
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
      state: reported?.state && reported.state !== 'failed' ? reported.state : 'loaded',
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

/** A device's memory, as admission reads it (a DCGM card or a host pool). */
interface DeviceReading {
  id: string;
  kind: 'gpu' | 'cpu';
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

/** The ONE admission computation `load` and `previewLoad` share (TASK-1051). */
interface Admission {
  /** The resident instances of the model (F1: matched by catalogue row, not only by key). */
  resident: LedgerEntry[];
  /** Physical devices the load gate claims. */
  devices: string[];
  /** Display device: `gpu<N>`, `multi`, `cpu:<service>`, or null when the card is not known. */
  device: string | null;
  /** The device ids whose memory the numbers below describe. */
  scope: string[];
  need: ResidencyBudget;
  freeBytes: number | null;
  headroomBytes: number | null;
  unattributedBytes: number | null;
  /** Headroom-adjusted free memory (+ the resident bytes a replace returns). */
  availableBytes: number;
  shortfallBytes: number;
  refusal: 'NO_SIZE' | 'OVER_BUDGET' | 'ALREADY_LOADED' | null;
}

/** `options` are LM Studio REST v1 load keys only. */
function assertOptionsSupported(request: LoadModelResidencyRequest): void {
  if (request.options && request.service !== 'lm-studio') {
    throw new BadRequestException({
      code: 'OPTIONS_UNSUPPORTED',
      message: `\`options\` are LM Studio REST v1 load keys; service '${request.service}' takes none.`,
    });
  }
}

/** The catalogue read for every row a residency service may run (F1 matches reported keys against them in memory). */
function serviceRowsFilter(service: string): Record<string, unknown> {
  if (service === 'lm-studio') {
    return { tenantId: SYSTEM_TENANT_ID, OR: [{ servedBy: { in: LM_STUDIO_SPELLINGS } }, { provider: { in: LM_STUDIO_SPELLINGS } }] };
  }
  return { tenantId: SYSTEM_TENANT_ID, servedBy: service };
}

/**
 * TASK-1051 F1 — the SYSTEM row a key names on a service: the row whose catalogue
 * ref IS the key first, then a confirmed key, then an UNAMBIGUOUS normalised match (LM Studio's
 * `@<quant>` / `:<n>` suffixes, operator-confirmed keys). LM Studio considers only
 * LM Studio rows (a CLOUD or Ollama row may carry the same wire id); stt prefers
 * an stt row, as before.
 */
function catalogueRowFor<T extends AiModelEntity>(service: string, rows: readonly T[], key: string): T | undefined {
  // Review finding 1 — exact catalogue ref → operator-confirmed key → an UNAMBIGUOUS normalised match (`resolveRuntimeKey`).
  const match = (pool: readonly T[]) => resolveRuntimeKey(service, key, pool)?.row;
  if (service === 'lm-studio') return match(rows.filter((r) => residencyServiceOf(r) === 'lm-studio'));
  if (service === 'nlp') return match(rows.filter((r) => r.servedBy === 'nlp'));
  return match(rows.filter((r) => r.servedBy === 'stt')) ?? match(rows);
}

/**
 * The reported instances an unload of `modelRef` targets: the exact key if the service holds it, else every
 * instance whose key RESOLVES to `row` (review finding 6 — never a sibling variant's instance, never an ambiguous one).
 */
function reportedInstances<M extends { modelRef: string; aiModelId?: string | null }>(
  service: string,
  models: readonly M[],
  modelRef: string,
  row: AiModelEntity | undefined,
  rows: readonly AiModelEntity[],
): M[] {
  const exact = models.filter((m) => m.modelRef === modelRef);
  if (exact.length > 0 || !row) return exact;
  const pool = rows.some((r) => r.id === row.id) ? rows : [...rows, row];
  return models.filter((m) => (m.aiModelId ?? catalogueRowFor(service, pool, m.modelRef)?.id) === row.id);
}

/** The SYSTEM rows a reported key is resolved against: the ledger's, plus the row an operator named (it may have been read directly). */
function catalogueRows(ledger: Ledger, row: AiModelEntity | undefined): AiModelEntity[] {
  const rows = [...ledger.catalogue.rows];
  if (row && !rows.some((r) => r.id === row.id)) rows.push(row);
  return rows;
}

/** Does this pin entry hold `aiModelId` (its first id, or any id sharing its key)? */
function onLivePathEntry(entry: LivePathModel, aiModelId: string): boolean {
  return entry.aiModelId === aiModelId || (entry.aiModelIds?.includes(aiModelId) ?? false);
}

/** Why a resident model is not offered for eviction, in the catalogue's words. */
function pinReason(source: ResidencyClassSource, pinnedClass: boolean): string {
  if (pinnedClass && source === 'implicit-live-path') return 'Used by a live-consultation agent';
  if (pinnedClass && source === 'policy') return 'Kept loaded by its residency policy';
  return 'Pinned by an operator';
}

/** `30 min`, `5 h`, `2 d` — the idle time on an eviction candidate. */
function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * MiB ? `${(bytes / (1024 * MiB)).toFixed(1)} GiB` : `${Math.round(bytes / MiB)} MiB`;
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
