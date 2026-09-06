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

export interface AiModelDownloadMeta {
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
}

type MutableAiModelDownloadMeta = Partial<AiModelDownloadMeta> & { jobId?: string };

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

  return { ...base, download: merged };
}

/** Read the `download` bookkeeping back out of `metaData`; `null` when absent or malformed. */
export function readDownloadMeta(metaData: Record<string, unknown> | null | undefined): AiModelDownloadMeta | null {
  if (!metaData || typeof metaData !== 'object') return null;
  const raw = (metaData as Record<string, unknown>).download;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const download = raw as Record<string, unknown>;
  if (typeof download.jobId !== 'string') return null;

  return {
    jobId: download.jobId,
    startedAt: typeof download.startedAt === 'string' ? download.startedAt : null,
    finishedAt: typeof download.finishedAt === 'string' ? download.finishedAt : null,
    error: typeof download.error === 'string' ? download.error : null,
    sizeMb: typeof download.sizeMb === 'number' ? download.sizeMb : null,
  };
}

/**
 * The four publish states, as STRINGS (TASK-890 §3.11).
 *
 * The values are byte-identical to the dropped `AiModelDownloadStatus` enum on
 * purpose: the wire contract this endpoint froze does not change, only where the
 * value comes from. Declared here rather than imported from `@arcaai/domains`
 * because L2 removes that Prisma enum with the columns.
 */
export const MODEL_PUBLISH_STATUSES = ['NOT_DOWNLOADED', 'DOWNLOADING', 'DOWNLOADED', 'DOWNLOAD_FAILED'] as const;
export type ModelPublishStatus = (typeof MODEL_PUBLISH_STATUSES)[number];

/**
 * The publish state of a row, DERIVED from the two facts that survive the column
 * drop: the run bookkeeping and the MEASURED bucket availability.
 *
 * Precedence is deliberate. A job still in flight wins (it is the most recent
 * fact); then a recorded failure — which must stay visible even when the row's
 * PREVIOUS weights are still in the bucket, because "the last publish failed" is
 * exactly what an operator is polling for; then measured presence.
 */
export function derivePublishStatus(meta: AiModelDownloadMeta | null, availability: string | null | undefined): ModelPublishStatus {
  if (meta?.startedAt && !meta.finishedAt && !meta.error) return 'DOWNLOADING';
  if (meta?.error) return 'DOWNLOAD_FAILED';
  return availability === 'AVAILABLE' ? 'DOWNLOADED' : 'NOT_DOWNLOADED';
}
