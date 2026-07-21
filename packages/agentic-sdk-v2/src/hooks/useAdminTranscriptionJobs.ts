/**
 * @arcaai/vox - useAdminTranscriptionJobs Hook
 *
 * Tenant-wide transcription-job supervision for TENANT_ADMIN / GLOBAL_ADMIN. The
 * server gates `/admin/audio/transcription-jobs` with `@CanManage('Tenant')`,
 * so a plain DOCTOR is denied (403) — surfaced here as a clean
 * `AgenticError('FORBIDDEN')`.
 *
 * IMPORTANT: the end-user `STT_V2_ENDPOINTS` reads (`LIST_JOBS`/`JOB_STATS`/
 * `JOBS_BY_STATUS`) are owner-scoped. Admin consumers that
 * need every job in the tenant MUST use this hook instead.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { ADMIN_TRANSCRIPTION_JOB_ENDPOINTS } from '../core/constants';
import { extractPaginated } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams, PaginatedResponse } from '../types/common';

/**
 * Tenant-wide transcription job. Minimal local shape with an index signature so
 * server fields the SDK does not yet model pass through untouched.
 */
export interface AdminTranscriptionJob {
  id: string;
  status?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Status → count map returned by the tenant-wide stats endpoint. */
export type AdminTranscriptionJobStats = Record<string, number>;

export interface UseAdminTranscriptionJobsReturn {
  jobs: AdminTranscriptionJob[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<PaginatedResponse<AdminTranscriptionJob>>;
  stats: () => Promise<AdminTranscriptionJobStats>;
  byStatus: (status: string) => Promise<AdminTranscriptionJob[]>;
}

export function useAdminTranscriptionJobs(): UseAdminTranscriptionJobsReturn {
  const { execute, isLoading, error } = useApiOperation('useAdminTranscriptionJobs');

  const [jobs, setJobs] = useState<AdminTranscriptionJob[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<PaginatedResponse<AdminTranscriptionJob>>('list', async (client) => {
        const raw = await client.get(appendPagination(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.LIST, pagination));
        const result = extractPaginated<AdminTranscriptionJob>(raw);
        setJobs(result.data);
        return result;
      }),
    [execute],
  );

  const stats = useCallback(
    () => execute<AdminTranscriptionJobStats>('stats', (client) => client.get<AdminTranscriptionJobStats>(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.STATS)),
    [execute],
  );

  const byStatus = useCallback(
    (status: string) =>
      execute<AdminTranscriptionJob[]>('byStatus', (client) =>
        client.get<AdminTranscriptionJob[]>(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.BY_STATUS(status)),
      ),
    [execute],
  );

  return { jobs, isLoading, error, list, stats, byStatus };
}
