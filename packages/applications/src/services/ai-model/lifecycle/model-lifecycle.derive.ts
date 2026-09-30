import { AiDeploymentKind, AiModelAvailability } from '@arcaai/domains';
import type { ModelResidencyCatalogueResponse } from '../../model-residency/dto';
import { residencyServiceOf } from '../../model-residency/model-residency.types';
import {
  derivePublishStatus,
  isDownloadStalled,
  isUnregisterStale,
  readDownloadMeta,
  readUnregisterMeta,
  type ModelPublishStatus,
} from '../publish/model-download-meta.util';
import { DOWNLOAD_STALLED_CODE } from '../publish/publisher-job.contract';
import type { ModelLifecycle, ModelLifecycleStatus, ModelServiceState, ModelServiceStatus } from './model-lifecycle.types';

/** The registry-row facts one lifecycle is derived from. */
export interface LifecycleRow {
  id: string;
  slug: string;
  metaData?: Record<string, unknown> | null;
  availability: string | null | undefined;
  deploymentKind: string;
  servedBy?: string | null;
  provider?: string | null;
}

/** Per-model residency detail, indexed once per request by `aiModelId` and by `slug`. */
export interface ResidencyIndex {
  observedAt: string | null;
  byId: Map<string, ModelServiceStatus[]>;
  bySlug: Map<string, ModelServiceStatus[]>;
}

const SERVICE_STATES: ReadonlySet<string> = new Set<ModelServiceState>(['loaded', 'loading', 'unloading', 'not_loaded', 'failed']);

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A catalogue model's reported error (`failed` state), when it carries one. */
function errorOf(model: Record<string, unknown>): ModelServiceStatus['error'] {
  const error = rec(model.error);
  if (!error) return null;
  return { code: str(error.code) ?? 'UNKNOWN', message: str(error.message) ?? '', at: str(error.at) };
}

/**
 * Index the residency catalogue for the lifecycle join. The catalogue reports
 * every SELF_HOSTED model under the workload that runs it; one model may show
 * under several services (stt and stt-worker both warm the same slug).
 */
export function indexResidencyCatalogue(catalogue: ModelResidencyCatalogueResponse): ResidencyIndex {
  const byId = new Map<string, ModelServiceStatus[]>();
  const bySlug = new Map<string, ModelServiceStatus[]>();
  for (const group of catalogue.services ?? []) {
    for (const model of group.models ?? []) {
      const raw = model as unknown as Record<string, unknown>;
      const placement = rec(raw.residency);
      const state = String(raw.status);
      const status: ModelServiceStatus = {
        service: String(group.service),
        state: (SERVICE_STATES.has(state) ? state : 'not_loaded') as ModelServiceState,
        device: str(placement?.device),
        bytes: num(placement?.bytes),
        inFlight: num(placement?.inFlight),
        requestsPerMin: num(placement?.requestsPerMin),
        error: errorOf(raw),
      };
      const id = str(raw.aiModelId);
      const slug = str(raw.slug);
      if (id) byId.set(id, [...(byId.get(id) ?? []), status]);
      else if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), status]);
    }
  }
  return { observedAt: str(catalogue.reportedAt), byId, bySlug };
}

/** An unregister accepted by the gateway and not yet finished (or failed) by the worker. */
export function isUnregistering(metaData: Record<string, unknown> | null | undefined): boolean {
  const meta = readUnregisterMeta(metaData ?? null);
  return !!meta && !meta.finishedAt && !meta.error;
}

/** The publish state with the stale-heartbeat rule applied (D-4) — the util owns the rule. */
export function publishStatusOf(
  row: Pick<LifecycleRow, 'metaData' | 'availability'>,
  opts: { now: number; staleAfterMs: number },
): ModelPublishStatus {
  return derivePublishStatus(readDownloadMeta(row.metaData ?? null), row.availability, { now: new Date(opts.now), staleAfterMs: opts.staleAfterMs });
}

/**
 * ONE lifecycle status per registry row (D-9), with the per-service evidence beside it.
 *
 * First match wins:
 *   UNREGISTERING → UNREGISTER_FAILED (open past the stale window, TASK-1023 OD-6)
 *   → DOWNLOADING → DOWNLOAD_FAILED (incl. a stalled heartbeat)
 *   → DOWNLOAD_CANCELLED (an admin cancelled the run, TASK-1023 D-C)
 *   → NOT_APPLICABLE (not self-hosted: nothing to download or load)
 *   → NOT_DOWNLOADED (the bucket lacks the weights AND no service holds them)
 *   → LOAD_FAILED → LOADING → SERVING (resident on ≥ 1 observed service)
 *   → DOWNLOADED (idle, on a service the residency ledger observes)
 *   → NOT_OBSERVED (served by a workload outside the ledger — tts, asr-vllm, text, vLLM).
 *
 * `residency` is `null` when the catalogue could not be read: the status then
 * rests on the registry alone and `observedAt` is `null`.
 */
export function deriveModelLifecycle(
  row: LifecycleRow,
  residency: ResidencyIndex | null,
  opts: { now: number; staleAfterMs: number },
): ModelLifecycle {
  const meta = rec(row.metaData);
  const unregisterMeta = readUnregisterMeta(meta);
  const rawDownload = rec(meta?.download);
  const downloadMeta = readDownloadMeta(meta);
  const publish = publishStatusOf(row, opts);

  const download = rawDownload
    ? {
        bytesDone: num(rawDownload.bytesDone),
        bytesTotal: num(rawDownload.bytesTotal),
        error:
          downloadMeta?.error ??
          (isDownloadStalled(downloadMeta, { now: new Date(opts.now), staleAfterMs: opts.staleAfterMs }) ? DOWNLOAD_STALLED_CODE : null),
      }
    : null;
  const unregister = unregisterMeta ? { weights: unregisterMeta.weights, error: unregisterMeta.error } : null;
  const services = residency ? (residency.byId.get(row.id) ?? residency.bySlug.get(row.slug) ?? []) : [];
  const observedAt = residency?.observedAt ?? null;

  const lifecycle = (status: ModelLifecycleStatus): ModelLifecycle => ({ status, services, download, unregister, observedAt });

  // TASK-1023 OD-6 — an open unregister past the download stale window lost its
  // job: UNREGISTER_FAILED (retryable), in the slot right after UNREGISTERING.
  if (isUnregistering(meta)) {
    const stale = isUnregisterStale(unregisterMeta, { now: new Date(opts.now), staleAfterMs: opts.staleAfterMs });
    return lifecycle(stale ? 'UNREGISTER_FAILED' : 'UNREGISTERING');
  }
  if (publish === 'DOWNLOADING') return lifecycle('DOWNLOADING');
  if (publish === 'DOWNLOAD_FAILED') return lifecycle('DOWNLOAD_FAILED');
  if (publish === 'CANCELLED') return lifecycle('DOWNLOAD_CANCELLED');
  if (row.deploymentKind !== AiDeploymentKind.SELF_HOSTED) return lifecycle('NOT_APPLICABLE');

  const resident = services.some((s) => s.state === 'loaded' || s.state === 'unloading');
  const loading = services.some((s) => s.state === 'loading');
  // A service holding the model is positive evidence the weights exist, whatever
  // the bucket inventory measured (HF-cache rows served straight off the mount
  // carry no `bucketPrefix` and measure MISSING while loaded).
  const weightsPresent =
    row.availability === AiModelAvailability.AVAILABLE || row.availability === AiModelAvailability.NOT_APPLICABLE || resident || loading;
  if (!weightsPresent) return lifecycle('NOT_DOWNLOADED');
  if (services.some((s) => s.state === 'failed')) return lifecycle('LOAD_FAILED');
  if (loading) return lifecycle('LOADING');
  if (resident) return lifecycle('SERVING');

  const observed = services.length > 0 || residencyServiceOf({ servedBy: row.servedBy ?? '', provider: row.provider ?? null }) !== null;
  return lifecycle(observed ? 'DOWNLOADED' : 'NOT_OBSERVED');
}
