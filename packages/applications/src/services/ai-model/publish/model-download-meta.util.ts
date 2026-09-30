import type { AiModelDownloadProgressMeta, AiModelUnregisterMeta, UnregisterWeightsOutcome } from './publisher-job.contract';

/**
 * `AiModel.metaData` (`_metadata` JSONB) bookkeeping for a download job.
 *
 * `startedAt` / `finishedAt` / `error` have no dedicated columns on `AiModel`
 * — the schema comment on `downloadStatus` says the download fields are
 * "manual registry bookkeeping (no write-back automation yet)", and
 * `packages/database/**` is owned by another lane for this ticket, so no
 * migration is available. `metaData` is an already-existing JSONB column the
 * entity round-trips (`AiModelEntity`'s own doc comment records TTS
 * `metaData.voices` / Azure deployment names living there the same way), so
 * job bookkeeping rides under a `download` key rather than growing a new
 * column.
 */
export interface AiModelDownloadMeta extends AiModelDownloadProgressMeta {
  jobId: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /**
   * Published size in MB. TASK-890 §3.11 moved it here from the dropped
   * `AiModel.fileSizeMb` column: it is a fact about ONE publish RUN, which is
   * what this bookkeeping is, not a property of the catalogue row.
   */
  sizeMb?: number | null;
  /**
   * TASK-1023 D-C — cancel bookkeeping, carried ONLY once written and dropped
   * whenever a NEW run (a different `jobId`) is claimed, so a retry after a
   * cancel never inherits it.
   *
   *   cancelRequestedAt / cancelRequestedBy   the gateway asked a RUNNING job to stop
   *   removeRegistrationOnCancel              …and to unregister the row once stopped (OD-5)
   *   cancelledAt / cancelledBy               the cancel is FINAL (with `finishedAt` and
   *                                           `error = 'CANCELLED'`) — derives `CANCELLED`
   */
  cancelRequestedAt?: string | null;
  cancelRequestedBy?: string | null;
  removeRegistrationOnCancel?: boolean | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
}

/** `_metadata.download.error` of a cancelled run (D-C). */
export const DOWNLOAD_CANCELLED_CODE = 'CANCELLED';

type MutableAiModelDownloadMeta = Partial<AiModelDownloadMeta> & { jobId?: string };

/**
 * TASK-1019 progress + liveness fields. Carried ONLY once written, so a row
 * nobody has published since keeps the exact pre-TASK-1019 shape.
 */
const PROGRESS_KEYS = ['bytesDone', 'bytesTotal', 'heartbeatAt', 'attempt'] as const;

/** TASK-1023 cancel fields — per RUN: a merge that names a new `jobId` drops them. */
const CANCEL_KEYS = ['cancelRequestedAt', 'cancelRequestedBy', 'removeRegistrationOnCancel', 'cancelledAt', 'cancelledBy'] as const;

/**
 * Merge a partial download-bookkeeping update onto an entity's existing
 * `metaData`, preserving every other key already stored there and every
 * `download` field the caller did not supply.
 */
export function mergeDownloadMeta(existing: Record<string, unknown> | null | undefined, update: MutableAiModelDownloadMeta): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? existing : {};
  const currentDownload = readDownloadMeta(base);

  const merged: AiModelDownloadMeta = {
    jobId: update.jobId ?? currentDownload?.jobId ?? '',
    startedAt: 'startedAt' in update ? (update.startedAt ?? null) : (currentDownload?.startedAt ?? null),
    finishedAt: 'finishedAt' in update ? (update.finishedAt ?? null) : (currentDownload?.finishedAt ?? null),
    error: 'error' in update ? (update.error ?? null) : (currentDownload?.error ?? null),
    sizeMb: 'sizeMb' in update ? (update.sizeMb ?? null) : (currentDownload?.sizeMb ?? null),
  };
  for (const key of PROGRESS_KEYS) {
    if (key in update) {
      (merged as unknown as Record<string, unknown>)[key] = update[key] ?? null;
    } else if (currentDownload && key in currentDownload) {
      (merged as unknown as Record<string, unknown>)[key] = currentDownload[key] ?? null;
    }
  }
  const sameRun = !update.jobId || update.jobId === currentDownload?.jobId;
  for (const key of CANCEL_KEYS) {
    if (key in update) {
      (merged as unknown as Record<string, unknown>)[key] = update[key] ?? null;
    } else if (sameRun && currentDownload && key in currentDownload) {
      (merged as unknown as Record<string, unknown>)[key] = currentDownload[key] ?? null;
    }
  }

  return { ...base, download: merged };
}

/** Read the `download` bookkeeping back out of `metaData`; `null` when absent or malformed. */
export function readDownloadMeta(metaData: Record<string, unknown> | null | undefined): AiModelDownloadMeta | null {
  if (!metaData || typeof metaData !== 'object') return null;
  const raw = (metaData as Record<string, unknown>).download;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const download = raw as Record<string, unknown>;
  if (typeof download.jobId !== 'string') return null;

  const meta: AiModelDownloadMeta = {
    jobId: download.jobId,
    startedAt: typeof download.startedAt === 'string' ? download.startedAt : null,
    finishedAt: typeof download.finishedAt === 'string' ? download.finishedAt : null,
    error: typeof download.error === 'string' ? download.error : null,
    sizeMb: typeof download.sizeMb === 'number' ? download.sizeMb : null,
  };
  if ('bytesDone' in download) meta.bytesDone = typeof download.bytesDone === 'number' ? download.bytesDone : null;
  if ('bytesTotal' in download) meta.bytesTotal = typeof download.bytesTotal === 'number' ? download.bytesTotal : null;
  if ('heartbeatAt' in download) meta.heartbeatAt = typeof download.heartbeatAt === 'string' ? download.heartbeatAt : null;
  if ('attempt' in download) meta.attempt = typeof download.attempt === 'number' ? download.attempt : null;
  for (const key of ['cancelRequestedAt', 'cancelRequestedBy', 'cancelledAt', 'cancelledBy'] as const) {
    if (key in download) meta[key] = typeof download[key] === 'string' ? (download[key] as string) : null;
  }
  if ('removeRegistrationOnCancel' in download) meta.removeRegistrationOnCancel = download.removeRegistrationOnCancel === true;
  return meta;
}

/**
 * The four publish states, as STRINGS (TASK-890 §3.11).
 *
 * The values are byte-identical to the dropped `AiModelDownloadStatus` enum on
 * purpose: the wire contract this endpoint froze does not change, only where the
 * value comes from. Declared here rather than imported from `@arcaai/domains`
 * because L2 removes that Prisma enum with the columns.
 */
export const MODEL_PUBLISH_STATUSES = ['NOT_DOWNLOADED', 'DOWNLOADING', 'DOWNLOADED', 'DOWNLOAD_FAILED', 'CANCELLED'] as const;
export type ModelPublishStatus = (typeof MODEL_PUBLISH_STATUSES)[number];

/** Staleness inputs for `derivePublishStatus` / `isDownloadStalled` (TASK-1019 D-4). */
export interface DownloadStalenessOptions {
  now?: Date;
  /** `modelRegistry.download.staleAfterSeconds` × 1000, resolved by the caller. */
  staleAfterMs?: number;
}

function isInFlight(meta: AiModelDownloadMeta | null): boolean {
  return Boolean(meta?.startedAt && !meta.finishedAt && !meta.error);
}

/**
 * An in-flight run whose last sign of life — `heartbeatAt`, or `startedAt`
 * when the worker never wrote one (it crashed before picking the job up, or
 * the job was queued by a pre-TASK-1019 gateway) — is older than
 * `staleAfterMs`. Such a run is reported as `DOWNLOAD_FAILED` with code
 * `DOWNLOAD_STALLED_CODE` and may be re-triggered. `false` whenever no
 * `staleAfterMs` is given: staleness is a policy the CALLER resolves.
 */
export function isDownloadStalled(meta: AiModelDownloadMeta | null, opts: DownloadStalenessOptions = {}): boolean {
  if (opts.staleAfterMs === undefined || !isInFlight(meta)) return false;
  const lastSeen = Date.parse(meta?.heartbeatAt ?? meta?.startedAt ?? '');
  if (Number.isNaN(lastSeen)) return false;
  return (opts.now ?? new Date()).getTime() - lastSeen > opts.staleAfterMs;
}

/**
 * The publish state of a row, DERIVED from the two facts that survive the column
 * drop: the run bookkeeping and the MEASURED bucket availability.
 *
 * Precedence is deliberate. A job still in flight wins (it is the most recent
 * fact) — unless it has STALLED (TASK-1019 D-4: no heartbeat within
 * `staleAfterMs`, the signature of a worker that died mid-job), which reads as
 * a failure; then a recorded failure — which must stay visible even when the
 * row's PREVIOUS weights are still in the bucket, because "the last publish
 * failed" is exactly what an operator is polling for; then measured presence.
 * With no `opts` the behaviour is exactly the pre-TASK-1019 one.
 */
export function derivePublishStatus(
  meta: AiModelDownloadMeta | null,
  availability: string | null | undefined,
  opts?: DownloadStalenessOptions,
): ModelPublishStatus {
  if (isInFlight(meta)) return isDownloadStalled(meta, opts) ? 'DOWNLOAD_FAILED' : 'DOWNLOADING';
  // TASK-1023 D-C — an admin cancel is not a failure: its own word, still ahead
  // of measured presence (the operator asked for THIS outcome to stay visible).
  if (meta?.cancelledAt && meta.finishedAt) return 'CANCELLED';
  if (meta?.error) return 'DOWNLOAD_FAILED';
  return availability === 'AVAILABLE' ? 'DOWNLOADED' : 'NOT_DOWNLOADED';
}

const UNREGISTER_WEIGHTS: ReadonlySet<string> = new Set<UnregisterWeightsOutcome>(['deleting', 'deleted', 'kept-shared', 'kept']);

/**
 * Merge a partial `_metadata.unregister` update (contract `AiModelUnregisterMeta`)
 * — the gateway writes the accepted request, the publisher worker completes it.
 * Every other `metaData` key, `download` included, is preserved.
 */
export function mergeUnregisterMeta(
  existing: Record<string, unknown> | null | undefined,
  update: Partial<AiModelUnregisterMeta>,
): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? existing : {};
  const current = readUnregisterMeta(base);
  const merged: AiModelUnregisterMeta = {
    jobId: update.jobId ?? current?.jobId ?? '',
    startedAt: update.startedAt ?? current?.startedAt ?? new Date().toISOString(),
    deleteWeights: update.deleteWeights ?? current?.deleteWeights ?? false,
    purge: update.purge ?? current?.purge ?? false,
    finishedAt: 'finishedAt' in update ? (update.finishedAt ?? null) : (current?.finishedAt ?? null),
    error: 'error' in update ? (update.error ?? null) : (current?.error ?? null),
    weights: update.weights ?? current?.weights ?? 'deleting',
  };
  const deletedObjects = 'deletedObjects' in update ? update.deletedObjects : current?.deletedObjects;
  const deletedVersions = 'deletedVersions' in update ? update.deletedVersions : current?.deletedVersions;
  if (deletedObjects !== undefined) merged.deletedObjects = deletedObjects;
  if (deletedVersions !== undefined) merged.deletedVersions = deletedVersions;
  return { ...base, unregister: merged };
}

/**
 * TASK-1023 OD-6 — an unregister the gateway accepted, that no worker finished
 * or failed, whose `startedAt` is older than the SAME stale window downloads
 * use. The job was lost (removed, Redis flushed, worker gone): the row derives
 * `UNREGISTER_FAILED` and the unregister may be retried. `false` with no
 * `staleAfterMs` — staleness is a policy the caller resolves.
 */
export function isUnregisterStale(meta: AiModelUnregisterMeta | null, opts: DownloadStalenessOptions = {}): boolean {
  if (opts.staleAfterMs === undefined || !meta || meta.finishedAt || meta.error) return false;
  const startedAt = Date.parse(meta.startedAt);
  if (Number.isNaN(startedAt)) return false;
  return (opts.now ?? new Date()).getTime() - startedAt > opts.staleAfterMs;
}

/** Read `_metadata.unregister`; `null` when absent or malformed. */
export function readUnregisterMeta(metaData: Record<string, unknown> | null | undefined): AiModelUnregisterMeta | null {
  if (!metaData || typeof metaData !== 'object') return null;
  const raw = (metaData as Record<string, unknown>).unregister;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.jobId !== 'string' || typeof u.startedAt !== 'string') return null;
  const meta: AiModelUnregisterMeta = {
    jobId: u.jobId,
    startedAt: u.startedAt,
    deleteWeights: u.deleteWeights === true,
    purge: u.purge === true,
    finishedAt: typeof u.finishedAt === 'string' ? u.finishedAt : null,
    error: typeof u.error === 'string' ? u.error : null,
    weights: typeof u.weights === 'string' && UNREGISTER_WEIGHTS.has(u.weights) ? (u.weights as UnregisterWeightsOutcome) : 'deleting',
  };
  if (typeof u.deletedObjects === 'number') meta.deletedObjects = u.deletedObjects;
  if (typeof u.deletedVersions === 'number') meta.deletedVersions = u.deletedVersions;
  return meta;
}
