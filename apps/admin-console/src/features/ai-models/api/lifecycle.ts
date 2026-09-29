import type { AiModel, ModelLifecycleStatus, PaginatedModels } from './types';

/** How often the registry re-reads while any row is mid-flight (OD-5). */
export const LIFECYCLE_POLL_MS = 5_000;

/** Statuses that will change on their own — the only ones worth polling for. */
const TRANSIENT: ReadonlySet<ModelLifecycleStatus> = new Set(['DOWNLOADING', 'UNREGISTERING', 'LOADING']);

export function isTransientLifecycle(status: ModelLifecycleStatus | undefined | null): boolean {
  return status != null && TRANSIENT.has(status);
}

/** `true` when any row of the page is DOWNLOADING / UNREGISTERING / LOADING. */
export function hasTransientRows(rows: readonly AiModel[] | undefined | null): boolean {
  return (rows ?? []).some((row) => isTransientLifecycle(row.lifecycle?.status));
}

/** Refetch interval for the paginated list: 5 s while transient, off otherwise. */
export function listRefetchInterval(page: PaginatedModels | undefined): number | false {
  return hasTransientRows(page?.data) ? LIFECYCLE_POLL_MS : false;
}
