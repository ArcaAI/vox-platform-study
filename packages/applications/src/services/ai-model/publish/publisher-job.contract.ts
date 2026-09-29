/**
 * The model publisher's job contract — the one shape the gateway (producer) and
 * the model-publisher worker (consumer) agree on. Both kinds ride the existing
 * `JobQueue.DownloadAiModel` queue: renaming the queue would need a drain.
 *
 * A payload with no `kind` is a download (jobs queued before this contract).
 */
export interface DownloadAiModelJobPayload {
  kind?: 'download';
  jobId: string;
  aiModelId: string;
  tenantId: string;
  userId?: string;
}

export interface UnregisterAiModelJobPayload {
  kind: 'unregister';
  jobId: string;
  aiModelId: string;
  tenantId: string;
  userId?: string;
  /** Delete the model's bucket prefix (skipped when another live row shares it). */
  deleteWeights: boolean;
  /** Delete every object VERSION now instead of leaving delete markers for ILM. */
  purge: boolean;
}

export type PublisherJobPayload = DownloadAiModelJobPayload | UnregisterAiModelJobPayload;

export function isUnregisterJob(payload: PublisherJobPayload): payload is UnregisterAiModelJobPayload {
  return payload.kind === 'unregister';
}

/** What happened to the weights when a model was unregistered. */
export type UnregisterWeightsOutcome = 'deleting' | 'deleted' | 'kept-shared' | 'kept';

/**
 * `AiModel._metadata.unregister` — written by the gateway when an unregister is
 * accepted (`startedAt`), completed by the worker (`finishedAt` / `error` /
 * `weights`). A row with `startedAt` and no `finishedAt`/`error` is UNREGISTERING.
 */
export interface AiModelUnregisterMeta {
  jobId: string;
  startedAt: string;
  deleteWeights: boolean;
  purge: boolean;
  finishedAt: string | null;
  error: string | null;
  weights: UnregisterWeightsOutcome;
  /** Objects / versions removed (worker-filled). */
  deletedObjects?: number;
  deletedVersions?: number;
}

/**
 * Progress + liveness fields the worker adds to `AiModel._metadata.download`
 * (alongside the existing jobId/startedAt/finishedAt/error/sizeMb). A
 * DOWNLOADING row whose `heartbeatAt` is older than
 * `modelRegistry.download.staleAfterSeconds` derives as DOWNLOAD_FAILED (STALLED).
 */
export interface AiModelDownloadProgressMeta {
  bytesDone?: number | null;
  bytesTotal?: number | null;
  heartbeatAt?: string | null;
  attempt?: number | null;
}

/** Error code a derived stalled download carries. */
export const DOWNLOAD_STALLED_CODE = 'STALLED';
