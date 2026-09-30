import type { AiModel, ModelLifecycleStatus, PaginatedModels, PublisherJobView } from './types';

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

/**
 * Why the edit form is read-only for a row in this status, or `null` when it is
 * editable (final review I11). While a download runs every heartbeat bumps the
 * row's `_version`, so a PATCH with the drawer's If-Match could only 412; an
 * unregister is about to remove the row. LOADING is transient too, but it is a
 * service-side state that does not touch the row, so it does not lock the form.
 */
export function editLockReason(status: ModelLifecycleStatus | undefined | null): string | null {
  if (status === 'DOWNLOADING') return 'Editing is unavailable while the model is downloading.';
  if (status === 'UNREGISTERING') return 'Editing is unavailable while the model is being unregistered.';
  return null;
}

/** A publisher job that is still running or queued — the only kind worth polling for or cancelling. */
export function isActiveJob(job: Pick<PublisherJobView, 'state'>): boolean {
  return job.state === 'waiting' || job.state === 'active';
}

export function hasActiveJobs(jobs: readonly PublisherJobView[] | undefined | null): boolean {
  return (jobs ?? []).some(isActiveJob);
}
