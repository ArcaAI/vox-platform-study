/**
 * Transcription-jobs read client (capabilities-matrix row 28). Read-only ops
 * surface: tenant-wide reads come from the admin controller; the per-job
 * detail + SSE stream live on the tenant-owned end-user controller. Job
 * creation is the SDK plane — deliberately no writes here.
 */

import { getJson } from '@/shared/api';
import type { PaginatedTranscriptionJobs, TranscriptionJob, TranscriptionJobStats, TranscriptionJobStatus } from './types';

const ADMIN_BASE = 'admin/audio/transcription-jobs';
const JOB_BASE = 'audio/transcription-jobs';

/** NOTE: custom envelope { data, total, page, limit, totalPages }; page is 1-based. */
export function listTranscriptionJobs(params?: { page?: number; limit?: number }): Promise<PaginatedTranscriptionJobs> {
  return getJson(ADMIN_BASE, params);
}

export function getTranscriptionJobStats(): Promise<TranscriptionJobStats> {
  return getJson(`${ADMIN_BASE}/stats`);
}

/** Unpaginated array — the status filter swaps the list for this read. */
export function listTranscriptionJobsByStatus(status: TranscriptionJobStatus): Promise<TranscriptionJob[]> {
  return getJson(`${ADMIN_BASE}/status/${encodeURIComponent(status)}`);
}

/** Tenant-owned detail (404-over-403 posture on cross-tenant probes). */
export function getTranscriptionJob(id: string): Promise<TranscriptionJob> {
  return getJson(`${JOB_BASE}/${encodeURIComponent(id)}`);
}

/**
 * SSE path for useEventStream — relative to /api/v1 (the browser connects to
 * the gateway directly with a single-use ticket, never through the BFF proxy).
 */
export function transcriptionJobStreamPath(id: string): string {
  return `${JOB_BASE}/${encodeURIComponent(id)}/stream`;
}
