/**
 * TASK-1005 — the vocabulary of the model-residency control plane.
 *
 * Every literal union below mirrors an `enums` entry of
 * `tests/contracts/model-residency-admin.fixture.json` (the admin API, consumed
 * by the console) or `tests/contracts/model-residency-agent.fixture.json` (what
 * the Python agents and the LM Studio adapter report). The fixtures are the
 * contract; these types are its TypeScript spelling.
 */

/** Services the controller can COMMAND. `stt-worker` has no HTTP API — it is observed through Prometheus only. */
export const RESIDENCY_CONTROLLED_SERVICES = ['stt', 'nlp', 'lm-studio'] as const;
export type ResidencyControlledService = (typeof RESIDENCY_CONTROLLED_SERVICES)[number];

/** Services that appear in the residency view. */
export type ResidencyServiceName = ResidencyControlledService | 'stt-worker';

export type ResidencyMode = 'shadow' | 'enforce';
export type ResidencyModelState = 'loading' | 'loaded' | 'unloading';
/**
 * What a service may REPORT for one model: the three resident states plus
 * `failed` (TASK-1019) — its last load raised and nothing has cleared it. A
 * failed model holds no memory, so it never becomes a ledger entry; it is kept
 * beside them as a {@link ResidencyLoadError}.
 */
export type ReportedModelState = ResidencyModelState | 'failed';
export type ResidencyClassName = 'PINNED' | 'WARM' | 'ON_DEMAND';
export type ResidencyClassSource = 'policy' | 'implicit-live-path' | 'default';
export type ResidencyBytesSource = 'measured' | 'unknown';
export type RecommendationAction = 'load' | 'unload' | 'pin' | 'unpin';
export type RecommendationReason = 'idle_ttl_expired' | 'promotion_rate' | 'live_path_pin' | 'make_room' | 'admission_rejected';
export type ResidencyErrorCode =
  | 'IN_FLIGHT'
  | 'LOAD_FAILED'
  | 'LOAD_IN_PROGRESS'
  | 'MODEL_UNKNOWN'
  // TASK-1051 F8 — never measured and no catalogue size: an un-forced load is refused.
  | 'NO_SIZE'
  | 'OPTIONS_UNSUPPORTED'
  | 'OVER_BUDGET'
  | 'SERVICE_UNREACHABLE';
export type ResidencyOperationStatus = 'running' | 'succeeded' | 'failed';

/** Why a load failed (TASK-1019). `at` is null when the source (the stt-worker gauge) carries no time. */
export interface ResidencyLoadError {
  code: string;
  message: string;
  at: string | null;
}

/** One resident model, in the agent contract's camelCase `gateway` shape. */
export interface ReportedResidentModel {
  modelRef: string;
  aiModelId: string | null;
  cache: string;
  state: ReportedModelState;
  /** Present on a `failed` model only; absent from agents that predate TASK-1019. */
  error?: ResidencyLoadError | null;
  /** The REPORTING service's device id (`cuda:0`, `cpu`, `multi`) — not yet mapped to a physical card. */
  device: string;
  bytes: number | null;
  bytesSource: ResidencyBytesSource;
  inFlight: number | null;
  pinned: boolean;
  adminPinned: boolean;
  ttlSeconds: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  loadSeconds: number | null;
  /** LM Studio only — the handle an unload takes. */
  instanceId?: string;
}

export interface ReportedDevice {
  id: string;
  kind: 'gpu' | 'cpu';
  totalBytes: number;
  freeBytes: number;
}

/** One service's `GET /internal/residency` (or the LM Studio adapter's `report()`), camelCased. */
export interface ServiceResidencyReport {
  service: ResidencyServiceName;
  instance: string;
  reportedAt: string;
  devices: ReportedDevice[];
  models: ReportedResidentModel[];
}

/** `${service}|${modelRef}` — the ledger's key for one (service, model) pair. */
export function residencyKey(service: string, modelRef: string): string {
  return `${service}|${modelRef}`;
}

/** `AiModel.provider` spellings of LM Studio (the live-path reader recognises the same two). */
const LM_STUDIO_PROVIDERS: ReadonlySet<string> = new Set(['lm-studio', 'lmstudio']);

/** The catalogue fields that say which workload runs a model. */
export interface ServingIdentity {
  servedBy: string;
  provider?: string | null;
}

/**
 * The residency service that runs a catalogue model, from `AiModel.servedBy`
 * (normalised: `lmstudio` → `lm-studio`), or `null` for a workload the
 * controller does not govern (`tts`, `tts-worker`, `text`, `gateway-proxy`).
 * A row whose PROVIDER is LM Studio counts as LM Studio's whatever its
 * `servedBy` says — it is the engine's key that the service reports.
 */
export function residencyServiceOf(model: ServingIdentity): ResidencyServiceName | null {
  if (model.servedBy === 'lmstudio' || model.servedBy === 'lm-studio' || (model.provider && LM_STUDIO_PROVIDERS.has(model.provider)))
    return 'lm-studio';
  if (model.servedBy === 'stt' || model.servedBy === 'stt-worker' || model.servedBy === 'nlp') return model.servedBy;
  return null;
}

// ── TASK-1005 §13 — the catalogue-first view (`tests/contracts/model-residency-catalogue.fixture.json` `enums`) ──

/** The catalogue view's service groups, in their FIXED display order. */
export const CATALOGUE_SERVICES = ['stt', 'stt-worker', 'lm-studio', 'nlp'] as const satisfies readonly ResidencyServiceName[];
export type CatalogueRunsOn = 'gpu' | 'cpu';
export type CatalogueModelStatus = ResidencyModelState | 'not_loaded' | 'failed';
export type CatalogueSizeSource = 'measured' | 'catalogue' | 'unknown';
export type CatalogueUseRole = 'primary' | 'fallback' | 'routing' | 'pipeline_stage' | 'workflow_node';
/** TASK-1051 — what HOPE can do with a catalogue row: hold it in memory (`resident`), nothing (a cloud API = `remote`; compiled into a library = `builtin`). */
export type CatalogueModelKind = 'resident' | 'remote' | 'builtin';
/** TASK-1051 — a device's per-model bytes: `measured` (the service's own delta), `estimated` (catalogue size, or a split LM Studio model's per-card share), `unknown`. */
export type CatalogueDeviceBytesSource = 'measured' | 'estimated' | 'unknown';
/** TASK-1051 — how well an unmatched runtime instance fits a catalogue row. */
export type RuntimeKeyMatchStrength = 'strong' | 'weak';
/** TASK-1051 — the checks behind `GET readiness`, in display order. */
export const READINESS_CHECK_IDS = [
  'shadow_review_recorded',
  'instances_matched',
  'gpus_inside_headroom',
  'shared_decision_state',
  'shadow_days',
  'usage_complete',
  'unmeasured_budgeted',
  'actions_audited',
] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];
export type CatalogueKeepPolicyKind = 'always' | 'warm' | 'on_demand';
export type CatalogueAction = 'load' | 'unload' | 'reload' | 'edit_policy';

/** The catalogue fields a service's cache key is taken from. */
export interface CatalogueRefFields {
  slug: string;
  sourceUri: string;
  wireModelId?: string | null;
  /** `AiModel._metadata` — TASK-1051 reads `residency.runtimeKeys` (operator-confirmed engine keys) from it. */
  metaData?: unknown;
}

/** The key a service caches a catalogue model under: stt / stt-worker = slug, nlp = sourceUri (hub id), LM Studio = wireModelId. */
export function refFor(service: string, model: CatalogueRefFields | undefined): string | null {
  if (!model) return null;
  if (service === 'lm-studio') return model.wireModelId ?? null;
  if (service === 'nlp') return model.sourceUri;
  return model.slug;
}
