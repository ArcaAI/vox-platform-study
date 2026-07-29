'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getTranscriptionJob, getTranscriptionJobStats, listTranscriptionJobs, listTranscriptionJobsByStatus } from './client';
import { transcriptionJobKeys } from './keys';
import { TERMINAL_JOB_STATUSES, type TranscriptionJobStatus } from './types';

/** Frame 35 header contract: the whole surface auto-refreshes every 30 s. */
const REFRESH_MS = 30_000;

/** Fallback poll cadence for a selected, still-running job while its SSE stream is down. */
const SELECTED_JOB_POLL_MS = 5_000;

/** `enabled: false` while a status filter swaps the list for GET status/:status. */
export function useTranscriptionJobs(params?: { page?: number; limit?: number }, enabled = true) {
  return useQuery({
    queryKey: transcriptionJobKeys.list(params),
    queryFn: () => listTranscriptionJobs(params),
    enabled,
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useTranscriptionJobStats() {
  return useQuery({ queryKey: transcriptionJobKeys.stats(), queryFn: getTranscriptionJobStats, refetchInterval: REFRESH_MS });
}

export function useTranscriptionJobsByStatus(status: TranscriptionJobStatus | null) {
  return useQuery({
    queryKey: transcriptionJobKeys.byStatus(status ?? 'QUEUED'),
    queryFn: () => listTranscriptionJobsByStatus(status as TranscriptionJobStatus),
    enabled: !!status,
    refetchInterval: REFRESH_MS,
  });
}

/**
 * Selected-job detail: one read for the facts panel; live updates ride the
 * ticket-authenticated SSE stream (primary transport). `pollAsFallback` is
 * the documented error fallback — pass it while the stream sits on `error`
 * and the detail re-polls every 5 s until the job settles.
 */
export function useTranscriptionJob(id: string | null, pollAsFallback = false) {
  return useQuery({
    queryKey: transcriptionJobKeys.detail(id ?? ''),
    queryFn: () => getTranscriptionJob(id as string),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!pollAsFallback) return false;
      const status = query.state.data?.status;
      if (status && TERMINAL_JOB_STATUSES.includes(status)) return false;
      return SELECTED_JOB_POLL_MS;
    },
  });
}
