'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelTranscriptionJob,
  getTranscriptionJob,
  listMyTranscriptionJobs,
  listPlaygroundPipelines,
  retryTranscriptionJob,
  uploadBatchAudio,
} from './client';
import { liveTranscriptionKeys } from './keys';
import { TERMINAL_JOB_STATUSES } from './types';

/** Frame 51 my-jobs strip refresh cadence (mirrors the row-28 admin surface). */
const REFRESH_MS = 30_000;

/** Poll cadence for the active job while its SSE stream is down. */
const JOB_POLL_MS = 5_000;

export function usePlaygroundPipelines() {
  return useQuery({ queryKey: liveTranscriptionKeys.pipelines(), queryFn: listPlaygroundPipelines });
}

export function useMyTranscriptionJobs(params?: { page?: number; limit?: number }) {
  return useQuery({
    queryKey: liveTranscriptionKeys.jobs(params),
    queryFn: () => listMyTranscriptionJobs(params),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

/**
 * Active-job detail: one read for the card facts; live updates ride the
 * scoped SSE stream. `pollAsFallback` re-polls every 5 s while the stream is
 * on `error` until the job settles (the documented fallback).
 */
export function usePlaygroundJob(id: string | null, pollAsFallback = false) {
  return useQuery({
    queryKey: liveTranscriptionKeys.job(id ?? ''),
    queryFn: () => getTranscriptionJob(id as string),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!pollAsFallback) return false;
      const status = query.state.data?.status;
      if (status && TERMINAL_JOB_STATUSES.includes(status)) return false;
      return JOB_POLL_MS;
    },
  });
}

export function useBatchUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadBatchAudio,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: liveTranscriptionKeys.root }),
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: cancelTranscriptionJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: liveTranscriptionKeys.root }),
  });
}

export function useRetryJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: retryTranscriptionJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: liveTranscriptionKeys.root }),
  });
}
