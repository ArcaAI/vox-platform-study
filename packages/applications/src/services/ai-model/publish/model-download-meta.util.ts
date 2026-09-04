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
  };
}
