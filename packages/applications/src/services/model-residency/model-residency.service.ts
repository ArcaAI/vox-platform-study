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
import { declaredContextLengthOf } from '../ai-model/serving-profile.util';
import type { IActiveUserContext } from '../../interfaces';
import { lmStudioPreloadEntryFor, lmStudioServingContextFrom } from '../effective-config/effective-config.service';
import type { EffectiveLmStudioPreload } from '../effective-config/IEffectiveConfigService';
import { IPrometheusQueryService, type PrometheusSample } from '../platform-metrics/prometheus-query.service';
import { LM_STUDIO_SERVING_DEFAULTS, type LmStudioServingKey } from '../settings-registry/descriptors/lmstudio-serving.descriptors';
import {
  MODEL_RESIDENCY_DEFAULTS,
  RESIDENCY_SHADOW_REVIEWED_AT_KEY,
  type ModelResidencySettingKey,
} from '../settings-registry/descriptors/model-residency.descriptors';
import { ActionConfirmationService } from '../settings-registry/action-confirmation.service';
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
  ModelResidencyDeviceShare,
  ModelResidencyFreshness,
  ModelResidencyLoadConfig,
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
  type ReportedLoadConfig,
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
import { type CatalogueFailedEntry, attributeDevice, buildResidencyCatalogue, footprintFor } from './residency-catalogue';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError } from './residency-load-spec.builder';
import {
  residencyAdmissionRejectionsTotal,
  residencyDecisionsTotal,
  residencyLivePathModelLoaded,
  residencyServiceReachable,
} from './residency-metrics';
import {
  type JudgedPlacement,
  type LmStudioPlacement,
  type LmStudioProfileOverrides,
  type PlacementOption,
  type PlacementReading,
  judgePlacement,
  lmStudioDefaultSplit,
  lmStudioLoadSpec,
  lmStudioProfileIndices,
  rankPlacements,
  shortLabel,
  suggestionReasonFor,
} from './residency-placement';
import { ResidencyOperationRegistry, ResidencyRecommendationStore } from './residency-operations';
import {
  CooldownTracker,
  type EngineDecision,
  type EngineDevice,
  type EngineModel,
  type EngineSettings,
  PromotionTracker,
  planTick,
} from './residency-policy-engine';
import { rankRuntimeKeyCandidates, resolveRuntimeKey, runtimeKeysFor } from './runtime-key';

/**
 * TASK-1005 — the gateway ModelResidencyController: the ONE control plane that
 * decides and executes model load / unload / pin across `stt`, `nlp` and LM
 * Studio (Triton's explicit model-control mode, plan D-1). `stt-worker` has no
 * control API and is observed through Prometheus only.
 *
 * TASK-1055 — ONE control path for every service: the residency AGENT. LM
 * Studio's is an in-pod sidecar (`LMSTUDIO_AGENT_URL`) that loads over the SDK
 * channel with the model's FULL serving profile, built here with the boot
 * plan's own resolution (`lmStudioPreloadEntryFor`). A load names a DEVICE
 * (`gpu<N>` / `multi` / `cpu`, mapped onto the agent's `cuda:<n>` by card UUID);
 * admission judges every device the service can use and names the best one
 * (`residency-placement.ts`), and a refusal carries that advice too.
 *
 * ── THE LOOP (every 10 s, plan §5.3) ─────────────────────────────────────────
 *
 *   observe  → the LEDGER: each agent's `GET /internal/residency` (stt, nlp,
 *              LM Studio's sidecar), DCGM per-device memory, per-model request
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
 * The agents measure a load's footprint themselves (parameter bytes, or a
 * serialised per-device delta) and say how they know it (`bytesSource`). A
 * `measured` footprint is written back to `AiModel.observedMemoryMb /
 * observedLoadSeconds / observedAt` — unless it is under half the stored value
 * (TASK-1055 E7: a polluted remeasure), which is warned about and kept out —
 * and the admission check and the eviction score read those values.
 *
 * ── PER PROCESS ──────────────────────────────────────────────────────────────
 *
 * The gate, the operation registry and the recommendation log live in this
 * process. The gateway runs one replica
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
  'model-residency.default-device',
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
  // TASK-1055 — `UUID` kept: it is how an agent's `cuda:<n>` is matched to DCGM's `gpu<N>`.
  fbUsed: 'max by (gpu, modelName, UUID) (DCGM_FI_DEV_FB_USED)',
  fbFree: 'max by (gpu) (DCGM_FI_DEV_FB_FREE)',
  fbReserved: 'max by (gpu) (DCGM_FI_DEV_FB_RESERVED)',
  gpuUtil: 'max by (gpu) (DCGM_FI_DEV_GPU_UTIL)',
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
  /** TASK-1055 — the bytes this instance holds per card (`gpu<N>`), from the agent's own per-device measurement. */
  deviceBytes?: ModelResidencyDeviceShare[];
  /** TASK-1055 — LM Studio: the config the agent read back after the load. */
  loadConfig?: ModelResidencyLoadConfig | null;
  /** TASK-1055 — the REPORTING service's own device id (`cuda:<n>`), for a device-scoped unload. */
  agentDevice: string;
}

/** TASK-1055 — one device a commanded service can place a model on, in both vocabularies. */
interface ServiceDevice {
  /** The agent's id: `cuda:<n>`, `cpu`. */
  agentId: string;
  /** The ledger's id: `gpu<N>` (DCGM), `cpu:<service>`. */
  id: string;
  kind: 'gpu' | 'cpu';
  /** The CUDA index the process sees (LM Studio: the engine's GPU index). */
  index: number;
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
  /** TASK-1055 — the devices each commanded service can place a model on (agent ↔ ledger ids). */
  serviceDevices: Map<ResidencyControlledService, ServiceDevice[]>;
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
  loadSpec: Record<string, unknown>;
  /** The spec a failed replace restores the previous instance with (LM Studio: the profile WITHOUT the request's overrides). */
  restoreSpec: Record<string, unknown>;
  /** TASK-1055 — the agent device to send (`cuda:<n>`, `cpu`); `null` = the service's own placement. */
  agentDevice: string | null;
  /** The ledger device id(s) for the log / audit (`gpu1`, `multi`). */
  device: string | null;
  aiModelId: string | null;
  /** The catalogue row (F1: an unload/replace matches the instances the engine reports for it). */
  row?: AiModelEntity;
  /** The SYSTEM rows a reported key is resolved against (review finding 1: never a sibling variant's instance). */
  rows?: readonly AiModelEntity[];
  /** `operator` = a console action (its pin is the operator's); `policy` = the enforce-mode loop (its pin is the controller's). */
  origin: 'operator' | 'policy';
  recommendation?: ModelResidencyRecommendation;
  /** TASK-1055 review R1-F3 — a stt / nlp replace unloads only the copy on this device (LM Studio: every instance of the identifier). */
  unloadScope?: PlacementOption;
  /** TASK-1055 review R2-F7 — "make this the default placement", written only once the load has succeeded. */
  makeDefault?: { plan: LoadPlan };
  /** The physical devices the gate claimed for it (held past a gateway timeout, R1-F5). */
  gateDevices: string[];
}

/** An instance a replace unloaded, as it was — so a rollback (F9 / OD-5) puts it back with its pin and TTL. */
interface RestorableInstance {
  /** The key to load it under (LM Studio: the reported key without its `:<n>` instance suffix). */
  modelRef: string;
  pinned: boolean;
  ttlSeconds: number | null;
  /** TASK-1055 review R1-F4 — the AGENT device it sat on (`cuda:<n>`, `cpu`, `multi`), so it goes back where it was. */
  agentDevice: string | null;
  /** LM Studio — the config the agent read back for it, so it comes back with ITS context / parallel / KV / split. */
  loadConfig?: ReportedLoadConfig;
}

/** TASK-1055 review R1-F5 — a load the GATEWAY stopped waiting for: its card stays claimed until a report settles it. */
interface TimedOutLoad {
  service: ResidencyControlledService;
  modelRef: string;
  agentDevice: string | null;
  since: number;
  deadline: number;
}

/** How long a card stays claimed after a gateway load timeout when no report ever settles the load. */
const TIMED_OUT_GATE_CAP_MS = 15 * 60_000;

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
  /** The cache each (service, model) was last reported in — nlp's reload needs it. */
  private readonly lastSeenCache = new Map<string, string>();
  /** Keys the controller itself pinned (enforce mode), so it only ever unpins its own. */
  private readonly controllerPinned = new Set<string>();

  /** TASK-1019 D-8 — LM Studio's failed loads, kept until the next successful load or unload of that model (in memory; a restart re-observes). */
  private readonly lmsFailures = new Map<string, ResidencyLoadError>();
  /** LM Studio's agent reports no usage: its last use is when its callers' series last showed traffic. */
  private readonly lmsLastUsed = new Map<string, number>();
  /** TASK-1055 — the DCGM cards (with their UUIDs) of the last observation, for mapping agent devices outside it. */
  private lastGpus: GpuReading[] = [];
  /** TASK-1055 — services whose report read is failing, so an outage is logged once at warn (then debug) rather than every tick. */
  private readonly reportFailing = new Set<ResidencyControlledService>();
  /** First time this process saw a resident (service, model) — a residency floor when the service reports no load time. */
  private readonly firstSeen = new Map<string, number>();
  /** TASK-1055 review R1-F5 — loads the gateway timed out on, by operation id; their gate claim outlives the call. */
  private readonly timedOutLoads = new Map<string, TimedOutLoad>();

  private ledger: Ledger | null = null;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly policies: ModelResidencyPolicyRepository,
    private readonly aiModels: AiModelRepository,
    private readonly agents: ResidencyAgentClient,
    // Symbol token, so the parameter type alone cannot resolve it.
    @Inject(IPrometheusQueryService) private readonly prometheus: IPrometheusQueryService,
    private readonly effectiveSettings: EffectiveSettingsService,
    private readonly livePath: ImplicitLivePathReader,
    private readonly specs: ResidencyLoadSpecBuilder,
    private readonly usage: ModelUsageIndexReader,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly confirmations: ActionConfirmationService,
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
      this.publishGauges(ledger);
      const { models, devices } = this.engineInput(ledger, now);

      // One EWMA sample per (service, model) and tick — stt / nlp may hold a copy per device (R1-F9).
      const observed = new Set<string>();
      for (const m of models) {
        const key = residencyKey(m.service, m.modelRef);
        if (m.desiredClass !== 'WARM' || observed.has(key)) continue;
        observed.add(key);
        this.promotion.observe(key, m.requestsPerMin ?? 0, settings);
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
      // A pin is the agent's per-MODEL policy: one per (service, model), however many device copies asked for it.
      const pins = new Set<string>();
      for (let i = decisions.length - 1; i >= 0; i -= 1) {
        const d = decisions[i];
        if (d.action !== 'pin' && d.action !== 'unpin') continue;
        const key = `${d.action}|${residencyKey(d.service, d.modelRef)}`;
        if (pins.has(key)) decisions.splice(i, 1);
        else pins.add(key);
      }

      if (!settings.enforce) {
        // E11 — a standing row the state now satisfies (the agent reports the pin, the model is resident) goes at once.
        this.suggestions.withdraw((conclusion) => this.alreadySatisfied(conclusion, ledger));
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
        const applied = await this.policyUnload(decision.service, decision.modelRef, decision.devices, ledger);
        this.record(decision, 'enforce', applied);
      } else {
        const applied = await this.policyPin(decision.service, decision.modelRef, decision.action === 'pin');
        this.record(decision, 'enforce', applied);
      }
    }
  }

  /**
   * TASK-1055 review R1-F2 — the load PLAN comes first (where the load really goes: the model's default
   * device, its profile, else the service's own placement), and its target's physical devices are what
   * the gate claims and what any make-room eviction must free. The engine judged the decision on
   * `decision.devices` (`placementDevices`, which honours the same default); when the plan lands on a
   * device outside them, the engine's arithmetic says nothing about it and the load is not started.
   * When the engine pooled MORE cards than the load uses (LM Studio with no per-model placement is
   * budgeted conservatively on every card), the target is admitted on its own with `assessAdmission`.
   */
  private async enforceLoad(decision: EngineDecision, evictions: EngineDecision[], ledger: Ledger, settings: ResidencySettings): Promise<void> {
    const service = decision.service;
    if (!isControlled(service)) return;
    const skip = (why: string, extra: Record<string, unknown> = {}) => {
      this.logger.warn({ message: why, service, modelRef: decision.modelRef, ...extra });
      for (const eviction of evictions) this.record(eviction, 'enforce', false);
      this.record(decision, 'enforce', false);
    };
    const row = ledger.catalogue.modelFor(service, decision.modelRef);
    let plan: LoadPlan;
    try {
      // The controller places a model where its profile / default says — it never picks a GPU of its own (D-2).
      plan = await this.loadPlan(service, decision.modelRef, row, ledger, {});
    } catch (error) {
      skip('residency.enforce.load_not_started', { error: String(error) });
      return;
    }
    const devices = plan.target.physical;
    if (!devices.every((d) => decision.devices.includes(d))) {
      skip('residency.enforce.placement_mismatch', { planned: devices, judged: decision.devices });
      return;
    }
    let evict = evictions.filter((e) => e.devices.some((d) => devices.includes(d)));
    if (devices.length < decision.devices.length) {
      const admission = this.assessAdmission(service, plan.modelRef, false, row, ledger, settings, plan);
      if (admission.refusal !== null) {
        if (admission.refusal !== 'ALREADY_LOADED') residencyAdmissionRejectionsTotal.inc({ reason: 'insufficient_memory' });
        skip('residency.enforce.target_over_budget', { device: plan.target.device, refusal: admission.refusal });
        return;
      }
      evict = [];
    }
    for (const eviction of evictions) if (!evict.includes(eviction)) this.record(eviction, 'enforce', false);

    const opId = generateId();
    if (!(await this.gate.waitAcquire(devices, opId, settings.admissionMaxWaitMs))) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'gpu_busy' });
      for (const eviction of evict) this.record(eviction, 'enforce', false);
      this.record(decision, 'enforce', false);
      return;
    }
    for (const eviction of evict)
      this.record(eviction, 'enforce', await this.policyUnload(eviction.service, eviction.modelRef, eviction.devices, ledger));

    try {
      const loadSpec = await this.loadSpecFor(service, plan.modelRef, [], plan);
      const recommendation = this.record(decision, 'enforce', false);
      this.startLoad({
        opId,
        action: 'load',
        service,
        modelRef: plan.modelRef,
        pin: this.classify(service, decision.modelRef, row?.id ?? null, ledger).class === 'PINNED',
        force: false,
        reason: `policy:${decision.reason}`,
        loadSpec,
        restoreSpec: plan.restoreSpec ?? loadSpec,
        agentDevice: plan.target.agentDevice,
        device: plan.target.device,
        aiModelId: row?.id ?? null,
        origin: 'policy',
        recommendation,
        gateDevices: devices,
      });
    } catch (error) {
      this.gate.release(opId);
      this.logger.warn({ message: 'residency.enforce.load_not_started', service, modelRef: decision.modelRef, error: String(error) });
      this.record(decision, 'enforce', false);
    }
  }

  /** A policy unload — of the COPY on `devices` for stt / nlp (R1-F9); LM Studio unloads by identifier. */
  private async policyUnload(service: string, modelRef: string, devices: readonly string[], ledger: Ledger): Promise<boolean> {
    if (!isControlled(service)) return false;
    try {
      const scope = service === 'lm-studio' ? undefined : this.optionCovering(service, devices, ledger);
      const outcome = await this.unloadInternal(service, modelRef, false, 'policy', undefined, [], undefined, scope);
      this.audit('model-residency.policy.unload', { service, modelRef, device: scope?.device ?? null, outcome });
      return true;
    } catch (error) {
      this.logger.warn({ message: 'residency.enforce.unload_failed', service, modelRef, error: String(error) });
      return false;
    }
  }

  /** The placement option whose physical devices are exactly `devices` (a resident copy's), if the service has one. */
  private optionCovering(service: ResidencyControlledService, devices: readonly string[], ledger: Ledger): PlacementOption | undefined {
    if (devices.length === 0) return undefined;
    const options = this.placementOptions(service, ledger);
    return [...options, ...this.extraDevices(service, ledger, options)].find(
      (o) => o.physical.length === devices.length && o.physical.every((d) => devices.includes(d)),
    );
  }

  private async policyPin(service: string, modelRef: string, pinned: boolean): Promise<boolean> {
    if (!isControlled(service)) return false;
    try {
      await this.agents.setPolicy(service, modelRef, { adminPinned: pinned });
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
  private alreadySatisfied(decision: Pick<EngineDecision, 'action' | 'service' | 'modelRef'>, ledger: Ledger): boolean {
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

    this.suggestions.withdraw((conclusion) => this.alreadySatisfied(conclusion, ledger));
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
    // E11 — a standing row the state now satisfies is not shown, even between ticks.
    this.suggestions.withdraw((conclusion) => this.alreadySatisfied(conclusion, ledger));
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
      observedLoadSeconds: (_service, _modelRef, model) => model?.observedLoadSeconds ?? null,
      // F4 — only live, non-dismissed standing rows (the builder projects and caps them).
      recommendations: this.suggestions.visible(now),
    });
  }

  async load(request: LoadModelResidencyRequest): Promise<ModelResidencyLoadResult> {
    this.assertPlatformAdmin('load a model');
    const { service } = request;
    const force = request.force === true;
    const reason = request.reason?.trim() || null;
    const replace = request.replace === true;
    const makeDefault = request.makeDefault === true;
    assertOptionsSupported(request);
    if (makeDefault && !request.device) {
      throw new BadRequestException({
        code: 'DEVICE_UNAVAILABLE',
        message: '`makeDefault` makes the chosen `device` this model`s default placement; name the device.',
        device: null,
      });
    }

    const settings = await this.readSettings();
    const ledger = await this.currentLedger();
    const row = await this.catalogueModel(service, request.modelRef, ledger);
    if (makeDefault && !row) {
      throw new NotFoundException({ code: 'MODEL_UNKNOWN', message: `No catalogue model to make ${request.device} the default placement of.` });
    }
    const plan = await this.loadPlan(service, request.modelRef, row, ledger, {
      device: request.device ?? null,
      replace,
      overrides: lmStudioOverrides(request.options),
    });
    const { modelRef } = plan;
    const admission = this.assessAdmission(service, modelRef, replace, row, ledger, settings, plan);
    const { resident } = admission;
    const advice = { device: plan.target.device, suggestedDevice: admission.suggestedDevice, candidates: admission.candidates };

    if (admission.refusal === 'ALREADY_LOADED') {
      if (makeDefault) {
        // R2-F7 — judged before anything is written: "already loaded" makes the default only where it is loaded.
        if (!resident.some((e) => requestDevice(e.device) === plan.target.device)) {
          const loadedOn = requestDevice(resident[0].device);
          throw new ConflictException({
            code: 'ALREADY_LOADED_ELSEWHERE',
            message:
              `'${modelRef}' is already loaded on ${shortLabel(loadedOn)}; nothing was written. ` +
              `Reload it (\`replace\`) on ${shortLabel(plan.target.device)} to move it there and make that its default.`,
            device: plan.target.device,
            loadedOn,
          });
        }
        await this.makeDefault(service, row, plan);
      }
      return { status: 200, body: { outcome: 'already_loaded', model: this.toViewModel(resident[0], ledger) } };
    }
    if (this.operations.runningFor(service, modelRef)) {
      throw new ConflictException({ code: 'LOAD_IN_PROGRESS', message: `A load of '${modelRef}' on ${service} is already running.` });
    }
    const action = replace && resident.length > 0 ? 'replace' : 'load';
    // TASK-1057 — the reason rule is the platform's action-confirmation policy; `when-risky` (the default) is the
    // rule below: a live-path replace, a load forced past the budget, or (LM Studio "Apply & reload") any forced apply.
    const cls = action === 'replace' ? this.classify(service, modelRef, row?.id ?? resident[0].aiModelId, ledger) : null;
    const livePathReplace = cls?.class === 'PINNED';
    const forcedPastBudget = force && (admission.refusal === 'NO_SIZE' || admission.refusal === 'OVER_BUDGET');
    const confirmationId = service === 'lm-studio' && replace ? 'lmStudioServing.apply' : action === 'replace' ? 'modelResidency.reload' : 'modelResidency.load';
    const confirmationInput = { value: reason, risky: livePathReplace || forcedPastBudget || (confirmationId === 'lmStudioServing.apply' && force) };
    const confirmation = this.confirmations.decide(confirmationId, confirmationInput);
    const reasonMissing = confirmation.required && !confirmation.provided;
    // R2-F8 — a replace unloads first, so a live-path model needs a reason exactly as an unload does (OD-2), audited.
    if (livePathReplace && reasonMissing && cls) {
      const name = row?.name ?? modelRef;
      throw new ConflictException({
        code: 'LIVE_PATH_REASON_REQUIRED',
        message:
          cls.classSource === 'policy'
            ? `${name} is kept always loaded by its residency policy; give a reason to reload it`
            : `${name} is on the live consultation path; give a reason to reload it`,
        consumers: await this.consumersOf(row, cls),
      });
    }
    // Any other missing reason is the uniform 400 — except a forced over-budget load, which keeps its own 409 below.
    if (!forcedPastBudget) this.confirmations.assert(confirmationId, confirmationInput);
    const inFlight = resident.reduce((sum, e) => sum + (e.inFlight ?? 0), 0);
    if (replace && inFlight > 0 && !force) {
      throw new ConflictException({
        code: 'IN_FLIGHT',
        message: `${modelRef} is serving ${inFlight} request(s); pass force=true to replace it anyway`,
        inFlight,
      });
    }

    const loadSpec = await this.loadSpecFor(service, modelRef, resident, plan).catch((error: unknown) => {
      throw toHttpException(error);
    });

    // ── budget (TASK-1051 F8 + TASK-1055): judged on the CHOSEN device; the refusal carries the best alternative ──
    const { devices, need, availableBytes, chosen } = admission;
    const noSize = admission.refusal === 'NO_SIZE';
    const overBudget = admission.refusal === 'OVER_BUDGET';
    if (noSize && !(force && !reasonMissing)) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'no_size' });
      throw new ConflictException({
        code: 'NO_SIZE',
        message:
          `'${modelRef}' has never been measured and its catalogue entry has no memory size, so its footprint on ${devices.join(', ')} is unknown. ` +
          'Set the model`s memory size in the catalogue, or re-send with `force: true` AND a non-empty `reason` to load it anyway (audited).',
        devices,
        ...advice,
      });
    }
    if (admission.refusal === 'EXCEEDS_DEVICE') {
      // OD-5 — not even a forced load: the need is larger than the card's free memory outright.
      residencyAdmissionRejectionsTotal.inc({ reason: 'exceeds_device' });
      throw new ConflictException({
        code: 'EXCEEDS_DEVICE',
        message:
          `'${modelRef}' needs ${formatBytes(need.bytes ?? 0)} — more than ${shortLabel(plan.target.device)} has free at all (${formatBytes(chosen.freeBytes ?? 0)}); ` +
          `a forced load would OOM its card-mates, so it is refused even with \`force\`.${alternative(admission)}`,
        needBytes: need.bytes,
        shortfallBytes: chosen.shortfallBytes,
        ...advice,
      });
    }
    if (overBudget && !(force && !reasonMissing)) {
      residencyAdmissionRejectionsTotal.inc({ reason: 'over_budget' });
      throw new ConflictException({
        code: 'OVER_BUDGET',
        message:
          `${shortLabel(plan.target.device)} cannot hold '${modelRef}': it needs ${formatBytes(need.bytes ?? 0)} (${need.source}) and ${formatBytes(Math.max(0, availableBytes))} ` +
          `is free above the ${settings.headroomPercent}% headroom (short ${formatBytes(chosen.shortfallBytes)}).${alternative(admission)} ` +
          'The cards are time-sliced and give no memory isolation, so an over-budget load can OOM every workload on them; ' +
          're-send with `force: true` AND a non-empty `reason` to proceed anyway (audited).',
        needBytes: need.bytes,
        needSource: need.source,
        availableBytes,
        devices,
        shortfallBytes: chosen.shortfallBytes,
        ...advice,
      });
    }

    if (makeDefault && (overBudget || noSize)) {
      // R2-F7 — a load forced past the budget is a one-off; it is never written as the model's default placement.
      throw new ConflictException({
        code: 'MAKE_DEFAULT_OVER_BUDGET',
        message:
          `A forced load is never made a model's default placement: ${shortLabel(plan.target.device)} cannot hold '${modelRef}' ` +
          `within its headroom${noSize ? ' (its size is unknown)' : ` (short ${formatBytes(chosen.shortfallBytes)})`}. ` +
          `Load it without "make default", or pick a device that fits.${alternative(admission)}`,
        shortfallBytes: chosen.shortfallBytes,
        ...advice,
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

    this.startLoad({
      opId,
      action,
      service,
      modelRef,
      pin: request.pin === true,
      force,
      reason,
      loadSpec,
      restoreSpec: plan.restoreSpec ?? loadSpec,
      agentDevice: plan.target.agentDevice,
      device: plan.target.device,
      aiModelId: row?.id ?? resident[0]?.aiModelId ?? null,
      row,
      rows: catalogueRows(ledger, row),
      origin: 'operator',
      // R1-F3 — stt / nlp keep a copy per device: a replace reloads the copy on the target, never the others.
      ...(action === 'replace' && service !== 'lm-studio' ? { unloadScope: plan.target } : {}),
      // R2-F7 — the default is written once the load has landed, never before.
      ...(makeDefault ? { makeDefault: { plan } } : {}),
      gateDevices: devices,
    });

    // A platform-disruptive action on shared, time-sliced cards stays attributable to the administrator who took it.
    this.audit(`model-residency.${action}`, {
      operationId: opId,
      service,
      modelRef,
      device: plan.target.device,
      makeDefault,
      pin: request.pin === true,
      force,
      reason,
      overBudget,
      noSize,
      needBytes: need.bytes,
      needSource: need.source,
      confirmation,
    });

    return {
      status: 202,
      body: { outcome: 'accepted', operationId: opId, model: this.loadingView(service, modelRef, ledger, request.pin === true, plan.target) },
    };
  }

  /**
   * TASK-1051 — what `load(request)` would decide, with NO side effects: no
   * command, no operation, no recommendation, no audit. The arithmetic is
   * `assessAdmission`, the same call `load` makes, so the two cannot disagree.
   * TASK-1055 — judged on the chosen (or default) device, with every other
   * device the service can use as a ranked `candidates` list and a suggestion.
   */
  async previewLoad(request: LoadModelResidencyRequest): Promise<ModelResidencyLoadPreviewResponse> {
    this.assertPlatformAdmin('preview a model load');
    const { service } = request;
    assertOptionsSupported(request);

    const settings = await this.readSettings();
    const ledger = await this.currentLedger();
    const row = await this.catalogueModel(service, request.modelRef, ledger);
    const plan = await this.loadPlan(service, request.modelRef, row, ledger, {
      device: request.device ?? null,
      replace: request.replace === true,
      overrides: lmStudioOverrides(request.options),
    });
    const { modelRef } = plan;
    const admission = this.assessAdmission(service, modelRef, request.replace === true, row, ledger, settings, plan);
    const inFlight = admission.resident.reduce((sum, e) => sum + (e.inFlight ?? 0), 0);
    const blocked: 'LOAD_IN_PROGRESS' | 'IN_FLIGHT' | null =
      this.operations.runningFor(service, modelRef) || admission.devices.some((d) => this.gate.holderOf(d) !== undefined)
        ? 'LOAD_IN_PROGRESS'
        : request.replace === true && inFlight > 0
          ? 'IN_FLIGHT'
          : null;

    const targets = new Set(admission.resident);
    const { evictable, pinned } = this.neighbours(admission.scope, targets, ledger);

    const { chosen } = admission;
    // EXCEEDS_DEVICE is an over-budget answer the preview spells through the chosen candidate's `exceedsDevice`.
    const refusal = admission.refusal === 'EXCEEDS_DEVICE' ? 'OVER_BUDGET' : admission.refusal;
    return {
      service,
      modelRef,
      device: admission.device,
      needBytes: admission.need.bytes,
      needSource: admission.need.source,
      freeBytes: chosen.freeBytes,
      headroomBytes: chosen.headroomBytes,
      unattributedBytes: admission.unattributedBytes,
      shortfallBytes: chosen.shortfallBytes,
      // Review finding 5 — `fits` is what an un-forced load() would answer: besides the budget, a running load of the
      // same model and a card another load holds are LOAD_IN_PROGRESS, and a replace of a serving model is IN_FLIGHT.
      // `refusal` names the FIRST reason an un-forced load would be refused: the budget answer, else the blocker.
      fits: admission.refusal === null && blocked === null,
      refusal: refusal ?? blocked,
      evictable,
      pinned,
      candidates: admission.candidates,
      suggestedDevice: admission.suggestedDevice,
      suggestionReason: admission.suggestionReason,
    };
  }

  /** The resident models on `scope` (the target's own instances excepted): ON_DEMAND idle ones offered for eviction, largest first; pinned ones listed with why. */
  private neighbours(
    scope: readonly string[],
    targets: ReadonlySet<LedgerEntry>,
    ledger: Ledger,
  ): { evictable: ModelResidencyPreviewModel[]; pinned: ModelResidencyPreviewModel[]; livePath: number } {
    const now = Date.now();
    const evictable: Array<ModelResidencyPreviewModel & { sortBytes: number }> = [];
    const pinned: ModelResidencyPreviewModel[] = [];
    let livePath = 0;
    for (const entry of ledger.entries) {
      if (targets.has(entry) || !entry.devices.some((d) => scope.includes(d))) continue;
      const cls = this.classify(entry.service, entry.modelRef, entry.aiModelId, ledger);
      if (cls.class === 'PINNED') livePath += 1;
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
      evictable: evictable.sort((a, b) => b.sortBytes - a.sortBytes).map(({ sortBytes: _sortBytes, ...model }) => model),
      pinned,
      livePath,
    };
  }

  /**
   * The ONE admission computation (`load` and `previewLoad`). Need =
   * `budgetFor(measured, memorySizeMb)` — on a replace, the measured footprint is
   * the resident one, and those bytes come back before the new load.
   *
   * TASK-1055 — judged on the plan's TARGET device (the admin's pick, the
   * model's default, else the service's default) with `judgePlacement`, and on
   * every other device the service can place it on, ranked into `candidates`
   * and a `suggestedDevice` (the fixture's `$suggestionRule`). `EXCEEDS_DEVICE`
   * (need > the target's free memory outright) is the refusal force cannot lift.
   */
  private assessAdmission(
    service: ResidencyControlledService,
    modelRef: string,
    replace: boolean,
    row: AiModelEntity | undefined,
    ledger: Ledger,
    settings: ResidencySettings,
    plan: LoadPlan,
  ): Admission {
    const allResident = this.residentFor(service, modelRef, row, ledger);
    const { target } = plan;
    // stt / nlp keep one copy PER DEVICE: a device the ADMIN named (or the copy a replace reloads) without a copy on it is a
    // new load, not "already loaded". A device that only comes from the model's stored default does not (R1-F10).
    const resident =
      (plan.source === 'request' || plan.source === 'replace') && service !== 'lm-studio'
        ? allResident.filter((e) => e.devices.some((d) => target.physical.includes(d)))
        : allResident;
    const residentBytes = resident.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
    const measuredOnResident = replace && residentBytes > 0;
    const need = this.contextScaled(
      budgetFor(measuredOnResident ? residentBytes : this.observedBytes(service, modelRef, row), row?.memorySizeMb),
      plan,
      measuredOnResident ? resident : [],
      row,
    );

    const judge = (option: PlacementOption): JudgedPlacement => {
      const readings = option.physical.map((id) => this.deviceReading(id, ledger)).filter((d): d is PlacementReading => d !== undefined);
      const credit = replace ? residentBytesOn(resident, option.physical) : 0;
      const creditByDevice =
        replace && option.physical.length > 1 ? Object.fromEntries(option.physical.map((id) => [id, residentBytesOn(resident, [id])])) : undefined;
      const { evictable, livePath } = this.neighbours(option.physical, new Set(resident), ledger);
      return judgePlacement({
        option,
        readings,
        needBytes: need.bytes,
        creditBytes: credit,
        ...(creditByDevice ? { creditByDevice } : {}),
        headroomPercent: settings.headroomPercent,
        livePathModels: livePath,
        evictable,
      });
    };
    const chosen = judge(target);
    // R1-F1 — the place the load goes with no device named leads the suggestion whenever it fits.
    const ranked = rankPlacements(
      plan.options.map((option) => (option.device === target.device ? chosen : judge(option))),
      plan.preferred,
    );
    const candidates = ranked.map(({ order: _order, ...candidate }) => candidate);

    const devices = target.physical;
    const scope = devices.filter((id) => this.deviceReading(id, ledger) !== undefined);
    const gpuDevices = ledger.devices.filter((d) => d.kind === 'gpu');
    const footprintOf = (e: LedgerEntry) => {
      const model = e.aiModelId ? ledger.catalogue.byId.get(e.aiModelId) : ledger.catalogue.modelFor(e.service, e.modelRef);
      return footprintFor(e, this.observedBytes(e.service, e.modelRef, model), model?.memorySizeMb);
    };
    const unattributedBytes =
      scope.length > 0
        ? scope.reduce((sum, id) => {
            const reading = this.deviceReading(id, ledger)!;
            return sum + attributeDevice(reading, ledger.entries, gpuDevices, footprintOf).unattributedBytes;
          }, 0)
        : null;

    let refusal: Admission['refusal'] = null;
    if (resident.length > 0 && !replace) refusal = 'ALREADY_LOADED';
    else if (need.bytes === null) refusal = 'NO_SIZE';
    else if (chosen.exceedsDevice) refusal = 'EXCEEDS_DEVICE';
    else if (!chosen.fits) refusal = 'OVER_BUDGET';

    const availableBytes = need.bytes === null || chosen.remainingBytes === null ? 0 : chosen.remainingBytes + need.bytes;
    // R1-F8 — the request vocabulary (`gpu<N>`, `multi`, `cpu`), so it can be sent back as `device`.
    const device = refusal === 'ALREADY_LOADED' && resident[0] ? requestDevice(resident[0].device) : (target.device ?? null);
    return {
      resident,
      devices,
      device,
      scope,
      need,
      chosen,
      unattributedBytes,
      availableBytes,
      refusal,
      candidates,
      suggestedDevice: ranked[0]?.device ?? null,
      suggestionReason: suggestionReasonFor(ranked),
    };
  }

  /**
   * TASK-1055 review R2-F6 — an LM Studio load at a LONGER context than the one its footprint was measured
   * at needs more memory (the KV cache grows with it). The whole need is scaled by the ratio — conservative:
   * the weights do not grow, but the measured footprint does not say how it splits. The measurement's
   * context is, in order: the resident instance's read-back config (a replace budgets on its bytes), the
   * context recorded with the catalogue measurement (`_metadata.residency.observedContextLength`), else
   * the model's profile (what the boot plan loads, and so what the last measurement most likely saw).
   */
  private contextScaled(need: ResidencyBudget, plan: LoadPlan, measuredOn: readonly LedgerEntry[], row: AiModelEntity | undefined): ResidencyBudget {
    if (need.bytes === null || !plan.context) return need;
    const base = measuredOn.find((e) => e.loadConfig?.contextLength)?.loadConfig?.contextLength ?? observedContextOf(row) ?? plan.context.profile;
    if (!base || plan.context.requested <= base) return need;
    return { ...need, bytes: Math.ceil((need.bytes * plan.context.requested) / base) };
  }

  // ── TASK-1055 — placement ────────────────────────────────────────────────

  /**
   * Where a load goes and what it sends. `modelRef` comes back CANONICAL for
   * LM Studio (an engine key `<ref>@<quant>` resolving to a row is loaded under
   * the row's catalogue ref, which is the identifier the agent loads it as).
   * The target is, in order: the admin's `device` (400 DEVICE_UNAVAILABLE when
   * the service has no such device); on a replace, where the instance is now;
   * the row's `_metadata.residency.defaultDevice`; the service's default
   * (LM Studio: the profile's own placement; stt / nlp: their first device,
   * with no device SENT so the agent's own placement stands).
   */
  private async loadPlan(
    service: ResidencyControlledService,
    requestedRef: string,
    row: AiModelEntity | undefined,
    ledger: Ledger,
    request: { device?: string | null; replace?: boolean; overrides?: LmStudioProfileOverrides },
  ): Promise<LoadPlan> {
    const modelRef = service === 'lm-studio' ? (refFor(service, row) ?? requestedRef) : requestedRef;
    const lms = service === 'lm-studio' ? await this.lmStudioEntryFor(modelRef, row) : undefined;
    const options = this.placementOptions(service, ledger);
    const allowed = [...options, ...this.extraDevices(service, ledger, options)];
    const find = (device: string) => allowed.find((o) => o.device === device);

    // Where the load goes with NO device named (R1-F1: the suggestion keeps it there while it fits) — and where the target
    // came from decides what is SENT: only the service's own default leaves the agent to place it.
    let fallback: PlacementOption | undefined;
    let fallbackSource: LoadPlan['source'] = 'service';
    if (request.replace) {
      // A reload stays where the instance is now.
      const current = this.residentFor(service, modelRef, row, ledger)[0];
      // LM Studio split across cards reloads as its PROFILE places it (AC-2); one card stays that card.
      const keepsProfile = service === 'lm-studio' && current?.device === 'multi';
      const device = keepsProfile ? undefined : current ? requestDevice(current.device) : undefined;
      fallback = device ? find(device) : undefined;
      if (fallback) fallbackSource = 'replace';
    }
    if (!fallback) {
      const preferred = defaultDeviceOf(row);
      fallback = preferred ? find(preferred) : undefined;
      if (preferred && !fallback) this.logger.warn({ message: 'residency.default_device.unavailable', service, modelRef, device: preferred });
      if (fallback) fallbackSource = 'default';
    }
    if (!fallback) fallback = this.serviceDefault(service, options, lms, ledger);

    let target = fallback;
    let source: LoadPlan['source'] = fallbackSource;
    if (request.device) {
      const requested = find(request.device);
      if (!requested) {
        throw new BadRequestException({ code: 'DEVICE_UNAVAILABLE', message: `${service} has no device ${request.device}`, device: request.device });
      }
      target = requested;
      source = 'request';
    }
    const send = source !== 'service';

    const gpuCount =
      options.filter((o) => o.device !== 'multi' && o.device !== 'cpu').length || ledger.devices.filter((d) => d.kind === 'gpu').length;
    let loadSpec: Record<string, unknown> | undefined;
    let restoreSpec: Record<string, unknown> | undefined;
    let context: LoadPlan['context'];
    if (lms) {
      const requestedContext = request.overrides?.contextLength;
      const declared = row ? declaredContextLengthOf(row) : null;
      if (requestedContext !== undefined && declared !== null && requestedContext > declared) {
        throw new BadRequestException({
          code: 'CONTEXT_LENGTH_UNSUPPORTED',
          message: `'${modelRef}' declares a maximum context of ${declared} tokens; ${requestedContext} was asked for.`,
          contextLength: requestedContext,
          maxContextLength: declared,
        });
      }
      context = { requested: requestedContext ?? lms.contextLength, profile: lms.contextLength };
      const placement: LmStudioPlacement = !send
        ? { kind: 'profile' }
        : target.device === 'multi'
          ? { kind: 'multi' }
          : { kind: 'gpu', index: target.lmsIndices?.[0] ?? 0 };
      loadSpec = lmStudioLoadSpec(lms, modelRef, gpuCount, request.overrides ?? {}, placement);
      restoreSpec = lmStudioLoadSpec(lms, modelRef, gpuCount, {}, placement);
    }
    // `multi` sends no device (the split in the spec is the instruction); the service default sends none at all.
    if (!send || target.device === 'multi') target = { ...target, agentDevice: null };
    return { modelRef, target, options, source, preferred: fallback.device, loadSpec, restoreSpec, gpuCount, ...(context ? { context } : {}) };
  }

  /** The stt / nlp `load_spec` (the builder), or LM Studio's resolved-profile spec from the plan. */
  private async loadSpecFor(
    service: ResidencyControlledService,
    modelRef: string,
    resident: LedgerEntry[],
    plan: LoadPlan,
  ): Promise<Record<string, unknown>> {
    if (service === 'lm-studio') return plan.loadSpec ?? {};
    return this.specs.build(service, modelRef, resident[0]?.cache ?? this.lastSeenCache.get(residencyKey(service, modelRef)));
  }

  /**
   * Every device a service can place a model on (the candidates): the GPUs its
   * agent reports, mapped to DCGM's ids; a service with no GPU offers its host
   * memory; LM Studio adds `multi` (split across every card). A service that has
   * not reported yet falls back to DCGM's cards (index mapping), and nlp / tts to host memory
   * (TASK-1055 wave 3: tts is CPU only — it never offers a GPU).
   */
  private placementOptions(service: ResidencyControlledService, ledger: Ledger): PlacementOption[] {
    let gpus = (ledger.serviceDevices.get(service) ?? []).filter((d) => d.kind === 'gpu' && /^gpu\d+$/.test(d.id));
    if (service === 'tts') gpus = [];
    if (gpus.length === 0 && !HOST_MEMORY_DEFAULT.has(service)) {
      gpus = ledger.devices
        .filter((d) => d.kind === 'gpu')
        .map((d) => ({ agentId: `cuda:${d.id.slice(3)}`, id: d.id, kind: 'gpu' as const, index: Number(d.id.slice(3)) }));
    }
    const options: PlacementOption[] = gpus.map((d) => ({
      device: d.id,
      physical: [d.id],
      agentDevice: d.agentId,
      order: Number(d.id.slice(3)),
      ...(service === 'lm-studio' ? { lmsIndices: [d.index] } : {}),
    }));
    if (service === 'lm-studio') {
      if (options.length > 1) {
        options.push({
          device: 'multi',
          physical: options.map((o) => o.device),
          agentDevice: null,
          order: 1_000,
          lmsIndices: gpus.map((d) => d.index),
        });
      }
      return options;
    }
    if (options.length === 0) {
      const cpu = (ledger.serviceDevices.get(service) ?? []).find((d) => d.kind === 'cpu');
      if (cpu || HOST_MEMORY_DEFAULT.has(service)) options.push({ device: 'cpu', physical: [`cpu:${service}`], agentDevice: cpu?.agentId ?? 'cpu', order: 2_000 });
    }
    return options;
  }

  /** Devices a service accepts on request without offering them (stt / nlp host memory beside their GPUs). */
  private extraDevices(service: ResidencyControlledService, ledger: Ledger, options: PlacementOption[]): PlacementOption[] {
    if (service === 'lm-studio' || options.some((o) => o.device === 'cpu')) return [];
    const cpu = (ledger.serviceDevices.get(service) ?? []).find((d) => d.kind === 'cpu');
    return cpu ? [{ device: 'cpu', physical: [`cpu:${service}`], agentDevice: cpu.agentId, order: 2_000 }] : [];
  }

  /** The service's own placement: LM Studio's profile (one card, or `multi` when the split spans several); stt / nlp their first device. */
  private serviceDefault(
    service: ResidencyControlledService,
    options: PlacementOption[],
    lms: EffectiveLmStudioPreload | undefined,
    ledger: Ledger,
  ): PlacementOption {
    if (service === 'lm-studio' && lms) {
      const gpuOptions = options.filter((o) => o.device !== 'multi');
      const indices = lmStudioProfileIndices(lms, gpuOptions.length || ledger.devices.filter((d) => d.kind === 'gpu').length);
      const cards = gpuOptions.filter((o) => indices.includes(o.lmsIndices?.[0] ?? -1));
      if (cards.length === 1) return cards[0];
      if (cards.length > 1) {
        // R2-F5 — a `custom` profile split is judged per card by its ratio (index-aligned with the visible devices).
        const ratio = lms.gpuSplit?.strategy === 'custom' ? lms.gpuSplit.customRatio : undefined;
        const weights = ratio ? Object.fromEntries(cards.map((c) => [c.device, ratio[c.lmsIndices?.[0] ?? -1] ?? 0])) : undefined;
        return {
          device: 'multi',
          physical: cards.map((c) => c.device),
          agentDevice: null,
          order: 1_000,
          lmsIndices: indices,
          ...(weights && Object.values(weights).some((w) => w > 0) ? { weights } : {}),
        };
      }
    }
    const [first] = [...options].sort((a, b) => a.order - b.order);
    if (first) return first;
    // Nothing known about this service's devices at all: budget against every card (the gate stays conservative).
    const gpus = ledger.devices.filter((d) => d.kind === 'gpu').map((d) => d.id);
    return { device: 'multi', physical: gpus.length > 0 ? gpus : ['gpu?'], agentDevice: null, order: 1_000 };
  }

  /** The LM Studio boot-plan entry for a model: its row's profile resolved against the platform `lmStudio.serving.*` (no row = platform defaults). */
  private async lmStudioEntryFor(modelRef: string, row: AiModelEntity | undefined): Promise<EffectiveLmStudioPreload> {
    const keys = Object.keys(LM_STUDIO_SERVING_DEFAULTS).filter((key) => key.startsWith('lmStudio.serving.')) as LmStudioServingKey[];
    const values = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await this.lmStudioServingValue(key)] as const)));
    const { entry, problems } = lmStudioPreloadEntryFor(row ?? { metaData: {}, sourceUri: modelRef }, lmStudioServingContextFrom(values));
    if (problems.length > 0) this.logger.warn({ message: 'residency.lmstudio.profile_incoherent', modelRef, problems });
    return entry;
  }

  /** One `lmStudio.serving.*` key on the SYSTEM tier; an unresolved or mistyped value is the declared default (the boot plan's `open-to-default`). */
  private async lmStudioServingValue(key: LmStudioServingKey): Promise<unknown> {
    const fallback: unknown = LM_STUDIO_SERVING_DEFAULTS[key];
    const resolved = await this.effectiveSettings
      .resolveEffective(key, { tenantId: SYSTEM_TENANT_ID })
      .catch(fallbackOnNotFound(null, { logger: this.logger, message: 'LM Studio serving setting read failed', meta: { key } }));
    const value = resolved?.value;
    const sameShape = Array.isArray(fallback) ? Array.isArray(value) : value !== null && value !== undefined && typeof value === typeof fallback;
    if (sameShape) return value;
    return Array.isArray(fallback) ? [...fallback] : fallback;
  }

  /**
   * OD-4 — "make this the model's default placement": `_metadata.residency.defaultDevice`
   * (and, for LM Studio, `_metadata.serving.gpuSplit`, so the boot plan follows), as a
   * versioned write merged into the row's LATEST `_metadata` (one drift re-reads and retries).
   * Called only once placement has been judged — after the load landed, or for a model already
   * loaded on that device (R2-F7) — and every write is audited with what it replaced.
   */
  private async makeDefault(service: ResidencyControlledService, row: AiModelEntity | undefined, plan: LoadPlan): Promise<void> {
    if (!row) throw new NotFoundException({ code: 'MODEL_UNKNOWN', message: `No catalogue model to make ${plan.target.device} the default of.` });
    const device = plan.target.device;
    const split =
      service === 'lm-studio' && device !== 'cpu'
        ? lmStudioDefaultSplit(device === 'multi' ? { kind: 'multi' } : { kind: 'gpu', index: plan.target.lmsIndices?.[0] ?? 0 }, plan.gpuCount)
        : null;
    let previousDevice: unknown = null;
    let previousGpuSplit: unknown = null;
    const write = async (current: AiModelEntity): Promise<void> => {
      const metaData: Record<string, unknown> = { ...((current.metaData as Record<string, unknown> | null | undefined) ?? {}) };
      previousDevice = (metaData.residency as Record<string, unknown> | null | undefined)?.defaultDevice ?? null;
      previousGpuSplit = (metaData.serving as Record<string, unknown> | null | undefined)?.gpuSplit ?? null;
      const residency: Record<string, unknown> = {
        ...((metaData.residency as Record<string, unknown> | null | undefined) ?? {}),
        defaultDevice: device,
      };
      const next: Record<string, unknown> = { ...metaData, residency };
      if (split) next.serving = { ...((metaData.serving as Record<string, unknown> | null | undefined) ?? {}), gpuSplit: split };
      current.metaData = next;
      if (this.requestUserId) current.updatedBy = this.requestUserId;
      await this.aiModels.updateWithVersion(current.id, current, current.version);
    };
    try {
      await write(await this.aiModels.findById(row.id));
    } catch (error) {
      if (!(error instanceof OptimisticConcurrencyException)) throw error;
      await write(await this.aiModels.findById(row.id));
    }
    this.ledger = null;
    this.audit('model-residency.default-device', {
      service,
      aiModelId: row.id,
      modelRef: plan.modelRef,
      device,
      previousDevice,
      ...(split ? { gpuSplit: split, previousGpuSplit } : {}),
    });
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

    // TASK-1055 — `device` scopes the unload to the copy on that card.
    let scope: PlacementOption | undefined;
    if (request.device) {
      const options = this.placementOptions(service, ledger);
      scope = [...options, ...this.extraDevices(service, ledger, options)].find((o) => o.device === request.device);
      if (!scope) {
        throw new BadRequestException({ code: 'DEVICE_UNAVAILABLE', message: `${service} has no device ${request.device}`, device: request.device });
      }
    }

    // OD-2 — a live-path model (implicit, or a PINNED policy) MAY be unloaded, but only with a reason, which is audited.
    // The unload never touches the policy: the model stays PINNED and an enforcing controller loads it back.
    const cls = this.classify(service, modelRef, row?.id ?? null, ledger);
    const livePath = cls.class === 'PINNED';
    // TASK-1057 — `when-risky` (the default) is this rule; `not-required` lifts it, `required` asks on every unload (400).
    const confirmation = this.confirmations.decide('modelResidency.unload', { value: reason, risky: livePath });
    if (livePath && confirmation.required && !confirmation.provided) {
      const name = row?.name ?? modelRef;
      throw new ConflictException({
        code: 'LIVE_PATH_REASON_REQUIRED',
        message:
          cls.classSource === 'policy'
            ? `${name} is kept always loaded by its residency policy; give a reason to unload it`
            : `${name} is on the live consultation path; give a reason to unload it`,
        consumers: await this.consumersOf(row, cls),
      });
    }
    this.confirmations.assert('modelResidency.unload', { value: reason, risky: livePath });

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

    const outcome = await this.unloadInternal(service, modelRef, force, 'admin', row, catalogueRows(ledger, row), undefined, scope).catch(
      (error: unknown) => {
        this.logger.warn({ message: 'residency.unload.failed', service, modelRef, device: request.device ?? null, ...failureFields(error) });
        throw toHttpException(error);
      },
    );

    // F10 — the operator's reason is on the audit event whether or not the unload was forced (the agent wire keeps its `admin` verb).
    this.audit('model-residency.unload', { service, modelRef, device: request.device ?? null, force, reason, livePath, outcome, confirmation });
    return { outcome, service, modelRef };
  }

  /** Who uses a live-path model, in plain words (the 409's `consumers`), from the cross-tenant usage index. */
  private async consumersOf(row: AiModelEntity | undefined, cls: Classification): Promise<string[]> {
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const words: string[] = [];
    const usage = row
      ? await this.usage
          .read([row.id], Date.now())
          .then((index) => index.get(row.id))
          .catch(warnAndFallback(undefined, { logger: this.logger, message: 'Residency usage read failed' }))
      : undefined;
    if (usage) {
      if (usage.agentCount > 0) {
        words.push(
          `${plural(usage.agentCount, 'agent')} · ${plural(usage.tenantCount, 'tenant')}${usage.liveConsultation ? ' (live consultations)' : ''}`,
        );
      }
      const { routingPolicies, pipelineStages, workflowNodes } = usage.consumers;
      if (routingPolicies > 0) words.push(plural(routingPolicies, 'routing policy', 'routing policies'));
      if (pipelineStages > 0) words.push(plural(pipelineStages, 'speech-to-text pipeline stage'));
      if (workflowNodes > 0) words.push(plural(workflowNodes, 'workflow node'));
    }
    if (cls.classSource === 'policy') words.push('its PINNED residency policy');
    return words.length > 0 ? words : ['the live consultation path'];
  }

  async pin(request: PinModelResidencyRequest): Promise<ModelResidencyPinResponse> {
    this.assertPlatformAdmin('pin a model');
    const { service, modelRef, pinned } = request;
    const key = residencyKey(service, modelRef);

    let target = modelRef;
    if (service === 'lm-studio') {
      // The agent pins an INSTANCE under the key it reports (F1: the request may name the catalogue ref or the engine key).
      const ledger = await this.currentLedger();
      const instance = this.residentFor(service, modelRef, ledger.catalogue.modelFor(service, modelRef), ledger)[0];
      if (!instance) throw new NotFoundException({ code: 'MODEL_UNKNOWN', message: `LM Studio holds no loaded instance of '${modelRef}'.` });
      target = instance.modelRef;
    }
    const reported = await this.agents
      .setPolicy(service, target, { adminPinned: pinned, ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}) })
      .catch((error: unknown) => {
        this.logger.warn({ message: 'residency.pin.failed', service, modelRef, ...failureFields(error) });
        throw toHttpException(error);
      });
    // An operator's pin is the operator's; the controller must never later "unpin its own" over it.
    this.controllerPinned.delete(key);
    this.controllerPinned.delete(residencyKey(service, target));

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
      // R1-F5 — a load the gateway stopped waiting for may still be running on the card: its claim stays until a report settles it.
      if (!this.timedOutLoads.has(job.opId)) this.gate.release(job.opId);
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
        await this.unloadInternal(service, modelRef, job.force, 'admin', job.row, job.rows, unloaded, job.unloadScope);
        unloadFinished = true;
      }

      const measured = await this.loadOnce(service, modelRef, job.loadSpec, job.pin, null, job.agentDevice).catch((error: unknown) => {
        if (error instanceof ResidencyAgentError && error.timedOut) {
          const now = Date.now();
          this.timedOutLoads.set(job.opId, {
            service,
            modelRef,
            agentDevice: job.agentDevice,
            since: now,
            deadline: now + TIMED_OUT_GATE_CAP_MS,
          });
        }
        throw error;
      });
      if (measured.bytes && job.aiModelId) await this.writeObserved(job.aiModelId, measured.bytes, measured.loadSeconds, measured.contextLength);
      let defaultWritten = false;
      if (job.makeDefault) {
        // R2-F7 — the load landed on the judged device: only now does it become the model's default placement.
        defaultWritten = await this.makeDefault(service, job.row, job.makeDefault.plan).then(
          () => true,
          (error: unknown) => {
            this.logger.warn({ message: 'residency.default_device.write_failed', operationId: job.opId, service, modelRef, error: String(error) });
            return false;
          },
        );
      }

      if (service === 'lm-studio') this.lmsFailures.delete(modelRef);
      this.operations.succeed(job.opId);
      if (job.recommendation) job.recommendation.applied = true;
      if (job.pin && job.origin === 'policy') this.controllerPinned.add(residencyKey(service, modelRef));
      else if (job.pin) this.controllerPinned.delete(residencyKey(service, modelRef));
      this.audit(`model-residency.${job.action}.succeeded`, {
        operationId: job.opId,
        service,
        modelRef,
        device: job.device,
        bytes: measured.bytes,
        loadSeconds: measured.loadSeconds,
        ...(job.makeDefault ? { defaultWritten } : {}),
      });
    } catch (error) {
      let failure = describeError(error);
      const timedOut = this.timedOutLoads.has(job.opId);
      // F9 (owner default OD-5) — a replace that unloaded the old instance(s) and then failed — to load the new one,
      // or part-way through unloading several — puts back what it unloaded (same model, its profile / spec, its
      // previous pin and TTL), so "Apply & reload" never leaves the model gone.
      let restored: boolean | null = null;
      // R1-F4 — every copy goes back on ITS OWN device (stt / nlp keep one per device), with its own pin and TTL.
      let toRestore = [...new Map(unloaded.map((instance) => [`${instance.modelRef}|${instance.agentDevice ?? ''}`, instance])).values()];
      // LM Studio: the MODEL comes back once, under its catalogue ref (the identifier the profile loads it as), with
      // the pin / TTL any of its instances had and the load config it ran with — never one load per `<key>:<n>` duplicate.
      if (service === 'lm-studio' && toRestore.length > 0) {
        const pinned = toRestore.find((instance) => instance.pinned);
        const was = pinned ?? toRestore[0];
        const config = toRestore.find((instance) => instance.loadConfig)?.loadConfig;
        toRestore = [
          {
            modelRef,
            pinned: pinned !== undefined,
            ttlSeconds: was.ttlSeconds,
            agentDevice: was.agentDevice,
            ...(config ? { loadConfig: config } : {}),
          },
        ];
      }
      // A timed-out load may still land: restoring over it would race the agent's own load (it stays claimed instead).
      if (timedOut) toRestore = [];
      if (toRestore.length > 0) {
        const errors: string[] = [];
        for (const instance of toRestore) {
          const restore = restoreTarget(service, instance, job.restoreSpec);
          await this.loadOnce(service, instance.modelRef, restore.loadSpec, instance.pinned, instance.ttlSeconds, restore.agentDevice).catch(
            (restoreError: unknown) => {
              this.logger.warn({
                message: 'residency.replace.restore_failed',
                operationId: job.opId,
                service,
                modelRef: instance.modelRef,
                code: describeError(restoreError).code,
                reason: describeError(restoreError).message,
              });
              errors.push(describeError(restoreError).message);
            },
          );
        }
        restored = errors.length === 0;
        const what = unloadFinished ? 'the replacement failed to load' : 'the replace failed part-way through unloading';
        failure = {
          ...failure,
          message: restored
            ? `${failure.message} — ${what}; the previous instance was restored as it was.`
            : `${failure.message} — ${what} and the previous instance was NOT restored (${errors.join('; ')}); load it again.`,
        };
      }
      if (timedOut) {
        failure = {
          ...failure,
          message: `${failure.message} — the agent may still be loading it; its device stays claimed until the agent reports the load settled.`,
        };
      }
      if (service === 'lm-studio' && !restored) {
        this.lmsFailures.set(modelRef, { ...failure, message: failure.message.slice(0, 500), at: iso(Date.now()) });
      }
      this.operations.fail(job.opId, failure);
      // AC-6 — the engine's own reason, at warn, with what was asked and where.
      this.logger.warn({
        message: 'residency.load.failed',
        operationId: job.opId,
        service,
        modelRef,
        device: job.device,
        code: failure.code,
        reason: failure.message,
      });
      this.audit(`model-residency.${job.action}.failed`, { operationId: job.opId, service, modelRef, device: job.device, error: failure, restored });
    }
  }

  /**
   * One load through the service's residency agent (stt, nlp and LM Studio alike). The footprint is the
   * agent's own, and it counts as a measurement only when the agent says it is one (`measured`).
   */
  private async loadOnce(
    service: ResidencyControlledService,
    modelRef: string,
    loadSpec: Record<string, unknown>,
    pin: boolean,
    ttlSeconds: number | null = null,
    agentDevice: string | null = null,
  ): Promise<{ bytes: number | null; loadSeconds: number | null; contextLength: number | null }> {
    const result = await this.agents.load(service, { modelRef, loadSpec, pin, ttlSeconds, ...(agentDevice ? { device: agentDevice } : {}) });
    const model = result.model;
    if (result.outcome === 'already_loaded') return { bytes: null, loadSeconds: null, contextLength: null };
    // LM Studio — the context the footprint was measured at (the agent's read-back, else what was asked), R2-F6.
    const asked = loadSpec.context_length;
    const contextLength = model.loadConfig?.contextLength ?? (typeof asked === 'number' ? asked : null);
    return {
      bytes: model.bytesSource === 'measured' ? model.bytes : null,
      loadSeconds: model.loadSeconds,
      contextLength: service === 'lm-studio' ? contextLength : null,
    };
  }

  /**
   * Write a MEASURED footprint back to the catalogue — unless it is under half the stored measurement
   * (TASK-1055 E7: a remeasure polluted by the caching allocator, a card-mate or a not-yet-freed baseline
   * shrank GLiGuard 947 → 376 MB and Granite 4.9 GB → 178 MB, and admission then under-budgeted them).
   * Such a reading is warned about and the stored value kept.
   */
  private async writeObserved(aiModelId: string, bytes: number, loadSeconds: number | null, contextLength: number | null = null): Promise<void> {
    try {
      const entity = await this.aiModels.findById(aiModelId);
      const measuredMb = Math.max(1, Math.round(bytes / MiB));
      const storedMb = entity.observedMemoryMb ?? null;
      if (storedMb !== null && storedMb > 0 && measuredMb < storedMb * MEASUREMENT_FLOOR_RATIO) {
        this.logger.warn({ message: 'residency.observed.implausible', aiModelId, measuredMb, storedMb, kept: storedMb });
        return;
      }
      entity.observedMemoryMb = measuredMb;
      entity.observedLoadSeconds = loadSeconds;
      entity.observedAt = new Date();
      if (contextLength !== null) {
        // R2-F6 — the context this footprint was measured at, so a longer one is budgeted larger.
        const metaData = { ...((entity.metaData as Record<string, unknown> | null | undefined) ?? {}) };
        metaData.residency = { ...((metaData.residency as Record<string, unknown> | null | undefined) ?? {}), observedContextLength: contextLength };
        entity.metaData = metaData;
      }
      await this.aiModels.update(aiModelId, entity);
    } catch (error) {
      // The load itself succeeded; losing the measurement must not fail it.
      this.logger.warn({ message: 'residency.observed.write_failed', aiModelId, error: String(error) });
    }
  }

  /**
   * Unload every instance of (service, model) — or, with `scope`, only the copy on that device. F1:
   * `modelRef` may be the catalogue ref while the service holds the model under its own key — the
   * command always goes out with the key the SERVICE reports (exact match first, else every instance tied to `row`).
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
    scope?: PlacementOption,
  ): Promise<'unloaded' | 'not_loaded'> {
    let outcome: 'unloaded' | 'not_loaded' = 'not_loaded';
    const keys = new Set<string>([modelRef]);
    // LM Studio: a fresh report, not the ledger — every instance of the key must go, including a `:2` created since the last tick.
    const report =
      service === 'lm-studio'
        ? await this.agents.report('lm-studio').catch(() => this.lastReports.get(service)?.report)
        : this.lastReports.get(service)?.report;
    const reported = report?.models.filter(isResident) ?? [];
    let instances = reportedInstances(service, reported, modelRef, row, rows);
    if (scope && report) {
      const onScope = (m: ReportedResidentModel) => {
        const mapped = this.reportDeviceMap(report).get(m.device);
        return m.device === scope.agentDevice || (mapped !== undefined && scope.physical.includes(mapped));
      };
      instances = instances.filter(onScope);
    }
    const refs = [...new Set(instances.map((m) => m.modelRef))];
    for (const ref of refs.length > 0 ? refs : [modelRef]) {
      keys.add(ref);
      const was = instances.find((m) => m.modelRef === ref);
      // Scoped: the copy's OWN agent device (R1-F3) — the scope's id when no reported copy names one.
      const agentDevice = scope ? (was?.device ?? scope.agentDevice ?? undefined) : undefined;
      if (
        (await this.agents.unload(service, { modelRef: ref, force, reason, ...(agentDevice ? { device: agentDevice } : {}) })).outcome === 'unloaded'
      ) {
        outcome = 'unloaded';
        unloaded?.push({
          modelRef: ref,
          pinned: was?.adminPinned ?? false,
          ttlSeconds: was?.ttlSeconds ?? null,
          agentDevice: was?.device ?? agentDevice ?? null,
          ...(was?.loadConfig ? { loadConfig: was.loadConfig } : {}),
        });
      }
    }
    if (service === 'lm-studio') for (const key of keys) this.lmsFailures.delete(key);
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
   * Step 1 of §5.3: rebuild the ledger. Cost: 3 agent GETs (stt, nlp, tts) + 1 LM Studio GET +
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
      this.refreshReport('lm-studio', () => this.agents.report('lm-studio'), now),
      this.refreshReport('tts', () => this.agents.report('tts'), now),
    ]);

    this.settleTimedOutLoads(now);

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
    this.lastGpus = gpus;
    const devices: Ledger['devices'] = gpus.map(({ id, name, totalBytes, usedBytes, freeBytes, utilisationPercent }) => ({
      id,
      kind: 'gpu' as const,
      name,
      totalBytes,
      usedBytes,
      freeBytes,
      utilisationPercent,
    }));

    // TASK-1055 — every device each commanded service reports, in both vocabularies (a service reports its devices even
    // with an empty cache, so a first load is placed and budgeted on the right card).
    const serviceDevices = new Map<ResidencyControlledService, ServiceDevice[]>();
    for (const report of reports) {
      if (!isControlled(report.service)) continue;
      const mapping = this.reportDeviceMap(report, gpus);
      serviceDevices.set(
        report.service,
        report.devices.flatMap((d, i): ServiceDevice[] => {
          if (d.kind === 'cpu') return [{ agentId: d.id, id: `cpu:${report.service}`, kind: 'cpu' as const, index: d.index ?? i }];
          const id = mapping.get(d.id);
          return id ? [{ agentId: d.id, id, kind: 'gpu' as const, index: d.index ?? agentIndex(d.id) ?? i }] : [];
        }),
      );
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

    const ledger: Ledger = { at: now, devices, entries, staleServices, oldestReportMs, policies, livePath, catalogue, failures, serviceDevices };
    this.ledger = ledger;
    return ledger;
  }

  /**
   * R1-F5 — release the gate claim of a load the gateway timed out on, once a report received AFTER the timeout
   * shows that model loaded or failed (on its device, when one was sent) — or once the hard cap passes.
   */
  private settleTimedOutLoads(now: number): void {
    for (const [opId, pending] of this.timedOutLoads) {
      const last = this.lastReports.get(pending.service);
      const settled =
        last !== undefined &&
        last.receivedAt >= pending.since &&
        last.report.models.some(
          (m) =>
            m.modelRef === pending.modelRef &&
            (m.state === 'loaded' || m.state === 'failed') &&
            (pending.agentDevice === null || m.device === pending.agentDevice),
        );
      if (!settled && now < pending.deadline) continue;
      if (!settled)
        this.logger.warn({
          message: 'residency.load.timeout_gate_released',
          operationId: opId,
          service: pending.service,
          modelRef: pending.modelRef,
        });
      this.timedOutLoads.delete(opId);
      this.gate.release(opId);
    }
  }

  /** R2-F4 — the two gauges the deployment alerts on, rebuilt from this tick's ledger. */
  private publishGauges(ledger: Ledger): void {
    for (const service of RESIDENCY_CONTROLLED_SERVICES) {
      residencyServiceReachable.set({ service }, this.lastReports.has(service) && !this.reportFailing.has(service) ? 1 : 0);
    }
    residencyLivePathModelLoaded.reset();
    const seen = new Set<string>();
    for (const entry of ledger.livePath) {
      const key = residencyKey(entry.service, entry.modelRef);
      if (!isControlled(entry.service) || seen.has(key)) continue;
      // A model on the live path ONLY as an ASR pipeline stage loads with its ASR agent, never on its own (lane B3).
      const roles = ledger.livePath.filter((l) => l.service === entry.service && l.modelRef === entry.modelRef).map((l) => l.role);
      if (roles.every((role) => role === 'pipeline_stage')) continue;
      seen.add(key);
      const loaded = ledger.entries.some(
        (e) =>
          e.service === entry.service &&
          e.state === 'loaded' &&
          (e.modelRef === entry.modelRef || (e.aiModelId !== null && onLivePathEntry(entry, e.aiModelId))),
      );
      residencyLivePathModelLoaded.set({ service: entry.service, model_ref: entry.modelRef }, loaded ? 1 : 0);
    }
  }

  private async refreshReport(service: ResidencyControlledService, read: () => Promise<ServiceResidencyReport>, now: number): Promise<void> {
    try {
      this.lastReports.set(service, { report: await read(), receivedAt: now });
      this.reportFailing.delete(service);
    } catch (error) {
      // AC-6 — an outage is a warn ONCE (with the agent's code and reason), then debug per tick until it recovers.
      const entry = { message: 'residency.report.unavailable', service, ...failureFields(error) };
      if (this.reportFailing.has(service)) this.logger.debug(entry);
      else this.logger.warn(entry);
      this.reportFailing.add(service);
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
    // F1 — LM Studio's callers (text, guardrail, harness) name the model by its catalogue wire id; the agent may report an
    // engine key (a JIT load). Both name this instance.
    const catalogueRef = service === 'lm-studio' ? refFor(service, aiModel) : null;
    let stats = usage.get(service, model.modelRef);
    if (catalogueRef && catalogueRef !== model.modelRef && stats.inFlight === null && stats.requestsPerMin === null)
      stats = usage.get(service, catalogueRef);

    // TASK-1055 — the agent's `cuda:<n>` → DCGM's `gpu<N>` (card UUID, else index); `multi` = the cards its per-device bytes name.
    const mapping = this.reportDeviceMap(report, gpus);
    const deviceBytes = model.deviceBytes
      ? Object.entries(model.deviceBytes).flatMap(([agentId, bytes]) => {
          const id = mapping.get(agentId);
          return id ? [{ device: id, bytes }] : [];
        })
      : undefined;
    let device = model.device;
    let physical: string[];
    if (model.device.startsWith('cpu')) {
      device = `cpu:${service}`;
      physical = [device];
      this.ensureCpuPool(service, report, devices);
    } else if (model.device === 'multi') {
      device = 'multi';
      physical = deviceBytes && deviceBytes.length > 0 ? deviceBytes.map((d) => d.device) : gpuIds.length > 0 ? gpuIds : ['gpu?'];
    } else {
      const mapped = mapping.get(model.device) ?? null;
      device = mapped ?? model.device;
      physical = mapped ? [mapped] : gpuIds.length > 0 ? gpuIds : ['gpu?'];
    }

    let inFlight = model.inFlight;
    let lastUsedAt = model.lastUsedAt;
    if (service === 'lm-studio') {
      // LM Studio's agent counts no requests: its callers' series do.
      inFlight = model.inFlight ?? stats.inFlight;
      if ((stats.inFlight ?? 0) > 0 || (stats.requestsPerMin ?? 0) > 0) this.lmsLastUsed.set(model.modelRef, now);
      const used = this.lmsLastUsed.get(model.modelRef);
      lastUsedAt = model.lastUsedAt ?? (used ? iso(used) : null);
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
      bytes: model.bytes,
      bytesSource: model.bytesSource,
      inFlight,
      requestsPerMin: stats.requestsPerMin,
      p50LatencyMs: stats.p50LatencyMs,
      loadedAt: model.loadedAt,
      lastUsedAt,
      loadSeconds: model.loadSeconds,
      ttlSeconds: model.ttlSeconds,
      reportedPinned: model.pinned,
      adminPinned: model.adminPinned,
      cache: model.cache,
      agentDevice: model.device,
      ...(model.instanceId ? { instanceId: model.instanceId } : {}),
      ...(deviceBytes ? { deviceBytes } : {}),
      ...(model.loadConfig ? { loadConfig: this.loadConfigView(model.loadConfig, device, mapping, report) } : {}),
    };
  }

  /** The agent's read-back load config in the console's shape; its `device` is where the split actually puts it. */
  private loadConfigView(
    config: ReportedLoadConfig,
    device: string,
    mapping: Map<string, string>,
    report: ServiceResidencyReport,
  ): ModelResidencyLoadConfig {
    let placed: string | null = device.startsWith('gpu') || device === 'multi' ? device : null;
    const split = config.gpuSplit;
    if (split) {
      const count = report.devices.filter((d) => d.kind === 'gpu').length || 1;
      const indices = lmStudioProfileIndices(
        {
          gpuSplit: {
            strategy: split.strategy ?? 'evenly',
            priority: split.priority,
            disabledGpus: split.disabledGpus,
            customRatio: split.customRatio,
          },
          gpu: null,
        },
        count,
      );
      placed = indices.length === 1 ? (mapping.get(`cuda:${indices[0]}`) ?? `gpu${indices[0]}`) : 'multi';
    }
    return {
      contextLength: config.contextLength ?? null,
      parallel: config.parallel ?? null,
      flashAttention: config.flashAttention ?? null,
      kvCacheQuantK: config.kvCacheQuant?.k ?? null,
      kvCacheQuantV: config.kvCacheQuant?.v ?? null,
      device: placed,
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
      agentDevice: sample.metric.device ?? 'unknown',
    };
  }

  /**
   * TASK-1055 — an agent's `cuda:<n>` → DCGM's `gpu<N>` (fixture `deviceIds`): the card whose DCGM `UUID` is
   * the agent device's `uuid`; only when no uuid comparison is possible, index `n` → `gpu<n>`, else with ONE card, that card.
   * Unmatched ⇒ absent (the gate then conservatively claims every card).
   */
  private reportDeviceMap(report: ServiceResidencyReport, gpus: ReadonlyArray<Pick<GpuReading, 'id' | 'uuid'>> = this.lastGpus): Map<string, string> {
    const cards = gpus;
    const mapping = new Map<string, string>();
    const ids = new Set(cards.map((g) => g.id));
    const agentIds = new Set([...report.devices.map((d) => d.id), ...report.models.flatMap((m) => [m.device, ...Object.keys(m.deviceBytes ?? {})])]);
    for (const agentId of agentIds) {
      if (!agentId.startsWith('cuda')) continue;
      const reading = report.devices.find((d) => d.id === agentId);
      let mapped: string | undefined;
      if (reading?.uuid) mapped = cards.find((g) => g.uuid !== undefined && g.uuid === reading.uuid)?.id;
      // Index (and one-card) fallback only when there is no uuid to match on (the agent sent none, or DCGM carries
      // none) — a uuid that matches no card is a card DCGM does not see, never "the only card" (R1-F7).
      if (!mapped && (!reading?.uuid || !cards.some((g) => g.uuid))) {
        const index = reading?.index ?? agentIndex(agentId);
        if (index !== null && ids.has(`gpu${index}`)) mapped = `gpu${index}`;
        if (!mapped && cards.length === 1) mapped = cards[0].id;
      }
      if (mapped) mapping.set(agentId, mapped);
    }
    return mapping;
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
          ...(s.metric.UUID ? { uuid: s.metric.UUID } : {}),
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

    // R1-F9 — one engine model per resident COPY (service, model, device): stt / nlp keep one per device, and an
    // idle copy on one card is unloaded (scoped to that card) while the busy one on the other stays.
    const resident = new Set<string>();
    for (const entry of ledger.entries) {
      if (!isControlled(entry.service)) continue;
      const key = residencyKey(entry.service, entry.modelRef);
      resident.add(key);
      const copy = `${key}|${entry.device}`;
      const existing = byKey.get(copy);
      if (existing) {
        // A second LM Studio instance of the same key (`<key>:2`) on the same device — one copy, two footprints.
        existing.bytes = existing.bytes !== null && entry.bytes !== null ? existing.bytes + entry.bytes : (existing.bytes ?? entry.bytes);
        existing.inFlight += entry.inFlight ?? 0;
        continue;
      }
      const cls = this.classify(entry.service, entry.modelRef, entry.aiModelId, ledger);
      const loadedMs = parseMs(entry.loadedAt) ?? this.firstSeen.get(key) ?? now;
      const usedMs = parseMs(entry.lastUsedAt) ?? loadedMs;
      const lmsTtl = entry.service === 'lm-studio' ? entry.ttlSeconds : null;
      byKey.set(copy, {
        service: entry.service,
        modelRef: entry.modelRef,
        resident: true,
        devices: entry.devices,
        bytes: entry.bytes,
        inFlight: entry.inFlight ?? 0,
        pinned: cls.class === 'PINNED' || entry.adminPinned,
        // E11 — the runtime's own pin (`pinned`, e.g. a live-path pin the agent holds) satisfies "pin" exactly like an admin pin.
        agentPinned: entry.adminPinned || entry.reportedPinned,
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
      if (
        resident.has(key) ||
        byKey.has(key) ||
        residentModels.has(`${service}|${candidate.aiModelId}`) ||
        this.operations.runningFor(service, modelRef)
      )
        continue;
      const cls = this.classify(service, modelRef, candidate.aiModelId, ledger);
      const model = ledger.catalogue.byId.get(candidate.aiModelId);
      byKey.set(key, {
        service,
        modelRef,
        resident: false,
        devices: this.placementDevices(service, ledger, model),
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

  /**
   * The devices a not-yet-resident model of `service` would occupy for the POLICY loop (D-7: within the
   * workload's visible devices) — the SAME place `loadPlan` puts it (R1-F2), so the engine budgets and
   * makes room where the load will really go: the model's stored `defaultDevice`; for LM Studio its own
   * profile split's cards; else the service's default — stt / nlp their first card (nlp without one: host
   * memory); LM Studio with no per-model placement (the platform GPU is a settings read the sync loop
   * does not make) conservatively every card, admitted on its target by `enforceLoad`.
   */
  private placementDevices(service: ResidencyControlledService | string, ledger: Ledger, row?: AiModelEntity): string[] {
    const gpuIds = ledger.devices.filter((d) => d.kind === 'gpu').map((d) => d.id);
    const allGpus = gpuIds.length > 0 ? gpuIds : ['gpu?'];
    if (!isControlled(service)) return allGpus;
    const options = this.placementOptions(service, ledger);
    const preferred = defaultDeviceOf(row);
    const stored = preferred ? [...options, ...this.extraDevices(service, ledger, options)].find((o) => o.device === preferred) : undefined;
    if (stored) return stored.physical;
    if (service === 'lm-studio') {
      const split = (row?.metaData as { serving?: { gpuSplit?: EffectiveLmStudioPreload['gpuSplit'] } } | null | undefined)?.serving?.gpuSplit;
      const cards = options.filter((o) => o.device !== 'multi');
      if (split && cards.length > 0) {
        const indices = lmStudioProfileIndices({ gpuSplit: { ...split, strategy: split.strategy ?? 'evenly' }, gpu: null }, cards.length);
        const placed = cards.filter((o) => indices.includes(o.lmsIndices?.[0] ?? -1)).map((o) => o.device);
        if (placed.length > 0) return placed;
      }
      return allGpus;
    }
    const [first] = options.sort((a, b) => a.order - b.order);
    if (first) return first.physical;
    return HOST_MEMORY_DEFAULT.has(service) ? [`cpu:${service}`] : allGpus;
  }

  /** A MEASURED footprint for a model, or `undefined`: the catalogue's observed size (every agent measures its own loads). */
  private observedBytes(_service: string, _modelRef: string, model: { observedMemoryMb?: number | null } | undefined): number | undefined {
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
  private loadingView(
    service: ResidencyControlledService,
    modelRef: string,
    ledger: Ledger,
    pin: boolean,
    target?: Pick<PlacementOption, 'device' | 'physical'>,
  ): ModelResidencyModel {
    const model = ledger.catalogue.modelFor(service, modelRef);
    const devices = target?.physical ?? this.placementDevices(service, ledger);
    const bytes = this.observedBytes(service, modelRef, model) ?? null;
    const entry: LedgerEntry = {
      service,
      instance: this.lastReports.get(service)?.report.instance ?? service,
      modelRef,
      aiModelId: model?.id ?? null,
      aiModelName: model?.name ?? null,
      device: target ? (target.device === 'cpu' ? `cpu:${service}` : target.device) : devices.length === 1 ? devices[0] : 'multi',
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
      agentDevice: 'unknown',
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
      ttlSeconds: reported?.ttlSeconds ?? null,
      reportedPinned: reported?.pinned ?? false,
      adminPinned: reported?.adminPinned ?? false,
      cache: reported?.cache ?? 'unknown',
      agentDevice: reported?.device ?? 'unknown',
    };
  }
}

// ── module-private helpers ──────────────────────────────────────────────────

interface GpuReading {
  id: string;
  /** DCGM's `UUID` label — what an agent device's `uuid` is matched against (TASK-1055). */
  uuid?: string;
  name: string;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
  utilisationPercent: number | null;
}

/** A device's memory, as admission reads it (a DCGM card or a host pool). */
type DeviceReading = PlacementReading;

/** TASK-1055 — where a load goes, and what is sent for it. */
interface LoadPlan {
  /** Canonical: LM Studio loads under the catalogue ref (the agent's identifier). */
  modelRef: string;
  /** The chosen device — the admin's, the model's default, or the service's. `agentDevice: null` = send no device. */
  target: PlacementOption;
  /** Every device the service can place it on (the preview's candidates). */
  options: PlacementOption[];
  /**
   * Where the target came from: the admin's `device`, the instance a replace reloads, the model's stored
   * default, or the service's own placement. Only `request` / `replace` scope "already loaded" to the device (R1-F10).
   */
  source: 'request' | 'replace' | 'default' | 'service';
  /** The device the load takes with NO device named — the suggestion keeps it while it fits (R1-F1). */
  preferred: string;
  /** LM Studio — the context this load asks for, and its profile's (R2-F6: a longer one scales the need). */
  context?: { requested: number; profile: number };
  /** LM Studio only — the resolved-profile spec (with the request's overrides), and the one a failed replace restores with. */
  loadSpec?: Record<string, unknown>;
  restoreSpec?: Record<string, unknown>;
  gpuCount: number;
}

/** The ONE admission computation `load` and `previewLoad` share (TASK-1051, device-aware since TASK-1055). */
interface Admission {
  /** The resident instances of the model (F1: matched by catalogue row, not only by key) — on the target device when one was named. */
  resident: LedgerEntry[];
  /** Physical devices the load gate claims (the target's). */
  devices: string[];
  /** Display device: `gpu<N>`, `multi`, `cpu:<service>`, or null when the card is not known. */
  device: string | null;
  /** The device ids whose memory the numbers below describe. */
  scope: string[];
  need: ResidencyBudget;
  /** The target judged with the placement arithmetic (free, headroom, remaining, shortfall, exceeds). */
  chosen: JudgedPlacement;
  unattributedBytes: number | null;
  /** Free memory above headroom on the target (+ the resident bytes a replace returns). */
  availableBytes: number;
  refusal: 'NO_SIZE' | 'OVER_BUDGET' | 'EXCEEDS_DEVICE' | 'ALREADY_LOADED' | null;
  candidates: ModelResidencyLoadPreviewResponse['candidates'];
  suggestedDevice: string | null;
  suggestionReason: string | null;
}

/** A remeasure under this share of the stored measurement is implausible and is not written (TASK-1055 E7). */
const MEASUREMENT_FLOOR_RATIO = 0.5;

/** `cuda:<n>` → n. */
function agentIndex(agentId: string): number | null {
  const match = /^cuda:(\d+)$/.exec(agentId);
  return match ? Number(match[1]) : null;
}

/** `AiModel._metadata.residency.defaultDevice` (OD-4), when it is a device id at all. */
function defaultDeviceOf(row: { metaData?: unknown } | undefined): string | null {
  const meta = row?.metaData as { residency?: { defaultDevice?: unknown } } | null | undefined;
  const device = meta?.residency?.defaultDevice;
  return typeof device === 'string' && /^(gpu\d+|multi|cpu)$/.test(device) ? device : null;
}

/** `_metadata.residency.observedContextLength` — the context the stored footprint was measured at (R2-F6). */
function observedContextOf(row: { metaData?: unknown } | undefined): number | null {
  const meta = row?.metaData as { residency?: { observedContextLength?: unknown } } | null | undefined;
  const value = meta?.residency?.observedContextLength;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** A ledger device in the request vocabulary (R1-F8): `cpu:<service>` → `cpu`; `gpu<N>` / `multi` as they are. */
function requestDevice(device: string): string {
  return device.startsWith('cpu') ? 'cpu' : device;
}

/** The bytes the given resident instances hold on `devices` (per-device bytes when the agent sent them). */
function residentBytesOn(resident: readonly LedgerEntry[], devices: readonly string[]): number {
  return resident.reduce((sum, e) => {
    if (e.deviceBytes?.length) return sum + e.deviceBytes.filter((d) => devices.includes(d.device)).reduce((t, d) => t + d.bytes, 0);
    const overlap = e.devices.filter((d) => devices.includes(d)).length;
    return sum + (e.devices.length > 0 ? ((e.bytes ?? 0) / e.devices.length) * overlap : 0);
  }, 0);
}

/** ` GPU 1 can hold it.` — the alternative a refusal names, when there is one. */
function alternative(admission: Admission): string {
  const best = admission.candidates[0];
  if (!best || best.device === admission.chosen.device) return '';
  return best.fits
    ? ` ${shortLabel(best.device)} can hold it (${formatBytes(best.remainingBytes ?? 0)} to spare).`
    : ` ${shortLabel(best.device)} is the closest.`;
}

/**
 * Where a replace puts an unloaded instance back (R1-F4): stt / nlp on the agent device it sat on, with the
 * builder's spec; LM Studio with the config the agent read back for it (context, parallel, flash attention,
 * KV quant, GPU split — the split in the spec is the placement, so no device is sent), else the profile
 * spec on the card it sat on.
 */
function restoreTarget(
  service: ResidencyControlledService,
  instance: RestorableInstance,
  restoreSpec: Record<string, unknown>,
): { loadSpec: Record<string, unknown>; agentDevice: string | null } {
  const device = instance.agentDevice;
  if (service !== 'lm-studio') return { loadSpec: restoreSpec, agentDevice: device && /^(cuda:\d+|cpu)$/.test(device) ? device : null };
  const config = instance.loadConfig;
  if (!config) return { loadSpec: restoreSpec, agentDevice: device && /^cuda:\d+$/.test(device) ? device : null };
  const spec: Record<string, unknown> = { ...restoreSpec };
  if (config.contextLength !== undefined) spec.context_length = config.contextLength;
  if (config.parallel !== undefined) spec.parallel = config.parallel;
  if (config.flashAttention !== undefined) spec.flash_attention = config.flashAttention;
  if (config.kvCacheQuant) spec.kv_cache_quant = { ...config.kvCacheQuant };
  if (config.gpuSplit) {
    spec.gpu_split = {
      strategy: config.gpuSplit.strategy ?? 'evenly',
      priority: config.gpuSplit.priority ?? [],
      disabled_gpus: config.gpuSplit.disabledGpus ?? [],
      custom_ratio: config.gpuSplit.customRatio ?? [],
    };
  }
  return { loadSpec: spec, agentDevice: null };
}

/** `{code, reason}` of an agent / engine failure, for a warn line (AC-6). */
function failureFields(error: unknown): { code: string; reason: string; status?: number } {
  if (error instanceof ResidencyAgentError) return { code: error.code, reason: error.message, status: error.status };
  const described = describeError(error);
  return { code: described.code, reason: described.message };
}

/**
 * `options` are LM Studio's, and since TASK-1055 only what the agent's profile `load_spec` carries
 * (`contextLength`, `flashAttention`); the REST-only keys have no place on the SDK load path.
 */
function assertOptionsSupported(request: LoadModelResidencyRequest): void {
  if (request.options && request.service !== 'lm-studio') {
    throw new BadRequestException({
      code: 'OPTIONS_UNSUPPORTED',
      message: `\`options\` are LM Studio load keys; service '${request.service}' takes none.`,
    });
  }
  const unsupported = (['evalBatchSize', 'numExperts', 'offloadKvCacheToGpu'] as const).filter((key) => request.options?.[key] != null);
  if (unsupported.length > 0) {
    throw new BadRequestException({
      code: 'OPTIONS_UNSUPPORTED',
      message:
        `LM Studio loads carry the model's serving profile; only \`contextLength\` and \`flashAttention\` may override it. ` +
        `Not supported: ${unsupported.join(', ')} (set them on the model's serving profile instead).`,
    });
  }
}

/** The catalogue read for every row a residency service may run (F1 matches reported keys against them in memory). */
/** Services whose placement falls back to host memory when no device is reported (nlp; tts runs on CPU only — TASK-1055 wave 3). */
const HOST_MEMORY_DEFAULT: ReadonlySet<string> = new Set(['nlp', 'tts']);

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
  if (service === 'tts') return match(rows.filter((r) => r.servedBy === 'tts'));
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

/** DTO options (nullable) → the overrides an LM Studio `load_spec` takes on top of the profile (absent when null). */
function lmStudioOverrides(options: LmStudioResidencyLoadOptions | null | undefined): LmStudioProfileOverrides {
  const out: LmStudioProfileOverrides = {};
  if (options?.contextLength != null) out.contextLength = options.contextLength;
  if (options?.flashAttention != null) out.flashAttention = options.flashAttention;
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
 * The typed failures of the agents (LM Studio's included) and the spec builder
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
          ...(error.device ? { agentDevice: error.device } : {}),
          ...(error.neededBytes !== undefined ? { needBytes: error.neededBytes } : {}),
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        });
      case 'DEVICE_UNAVAILABLE':
        return new BadRequestException({ ...body, ...(error.device ? { agentDevice: error.device } : {}) });
      case 'LOAD_FAILED':
        return error.status >= 500 ? new BadGatewayException(body) : new BadRequestException(body);
      case 'SERVICE_UNREACHABLE':
        return new ServiceUnavailableException(body);
      default:
        return new BadGatewayException({ ...body, code: 'SERVICE_UNREACHABLE' });
    }
  }
  if (error instanceof ResidencyLoadSpecError) {
    const body = { code: error.code, message: error.message };
    return error.code === 'MODEL_UNKNOWN' ? new NotFoundException(body) : new BadRequestException(body);
  }
  return error;
}
