/**
 * TASK-407 — pure display helpers for the Audio processing surface
 * (tenant-wide transcription-job supervision). Design source:
 * `unbuilt-super-admin-surfaces.md` §2 "Audio Processing" (spec-only):
 * pipeline card + job status list; read-only, no destructive actions.
 */

export type JobColorRole = 'info' | 'warning' | 'success' | 'destructive' | 'neutral';

const STATUS_ROLES: Record<string, JobColorRole> = {
  QUEUED: 'info',
  PROCESSING: 'warning',
  COMPLETED: 'success',
  FAILED: 'destructive',
  DEAD: 'destructive',
  CANCELLED: 'neutral',
};

/** TranscriptionJobStatus → status-pill color role (case-insensitive). */
export function jobStatusRole(status?: string | null): JobColorRole {
  if (!status) return 'neutral';
  return STATUS_ROLES[status.toUpperCase()] ?? 'neutral';
}

/** "42s" / "2m 5s" between two ISO instants; em-dash when unbounded/invalid. */
export function jobDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt || !completedAt) return '—';
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export interface JobStatsSummary {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  /** FAILED + DEAD — both are terminal failures on the tile. */
  failed: number;
}

/** Normalize the tenant-wide status→count map into the four stat tiles. */
export function summarizeJobStats(stats: Record<string, number> | null | undefined): JobStatsSummary {
  const at = (key: string) => Number(stats?.[key] ?? 0) || 0;
  const queued = at('queued');
  const processing = at('processing');
  const completed = at('completed');
  const failed = at('failed') + at('dead');
  const cancelled = at('cancelled');
  return { total: queued + processing + completed + failed + cancelled, queued, processing, completed, failed };
}
