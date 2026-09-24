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
export type ResidencyClassName = 'PINNED' | 'WARM' | 'ON_DEMAND';
export type ResidencyClassSource = 'policy' | 'implicit-live-path' | 'default';
export type ResidencyBytesSource = 'measured' | 'unknown';
export type RecommendationAction = 'load' | 'unload' | 'pin' | 'unpin';
export type RecommendationReason = 'idle_ttl_expired' | 'promotion_rate' | 'live_path_pin' | 'make_room' | 'admission_rejected';
export type ResidencyErrorCode =
  'IN_FLIGHT' | 'LOAD_FAILED' | 'LOAD_IN_PROGRESS' | 'MODEL_UNKNOWN' | 'OPTIONS_UNSUPPORTED' | 'OVER_BUDGET' | 'SERVICE_UNREACHABLE';
export type ResidencyOperationStatus = 'running' | 'succeeded' | 'failed';

/** One resident model, in the agent contract's camelCase `gateway` shape. */
export interface ReportedResidentModel {
  modelRef: string;
  aiModelId: string | null;
  cache: string;
  state: ResidencyModelState;
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
