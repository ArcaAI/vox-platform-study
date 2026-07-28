'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import {
  dnaJobStreamPath,
  generateDnaReport,
  getDnaDashboard,
  getDnaJobStatus,
  getDoctorReport,
  listDnaReports,
  listDnaVersions,
  updateDnaReport,
} from './client';
import { dnaKeys } from './keys';
import type { DnaJobStatus, GenerateDnaReportRequest, ListDnaReportsParams, UpdateDnaReportRequest } from './types';

export function useDnaReports(params?: ListDnaReportsParams) {
  return useQuery({ queryKey: dnaKeys.list(params), queryFn: () => listDnaReports(params), placeholderData: keepPreviousData });
}

export function useDnaDashboard() {
  return useQuery({ queryKey: dnaKeys.dashboard(), queryFn: getDnaDashboard });
}

/** Latest report for a doctor, WithEtag for the OCC PATCH. 404 = none yet. */
export function useDoctorReport(doctorId: string) {
  return useQuery({ queryKey: dnaKeys.doctor(doctorId), queryFn: () => getDoctorReport(doctorId), enabled: !!doctorId });
}

export function useDnaVersions(reportId: string) {
  return useQuery({ queryKey: dnaKeys.versions(reportId), queryFn: () => listDnaVersions(reportId), enabled: !!reportId });
}

export function useUpdateDnaReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reportId, patch, etag }: { reportId: string; patch: UpdateDnaReportRequest; etag: string }) =>
      updateDnaReport(reportId, patch, etag),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dnaKeys.root }),
  });
}

export function useGenerateDnaReport() {
  return useMutation({
    mutationFn: ({ doctorId, body }: { doctorId: string; body?: GenerateDnaReportRequest }) => generateDnaReport(doctorId, body),
  });
}

/** Fallback poll cadence while the SSE stream is down and the job is non-terminal. */
const JOB_POLL_MS = 2_000;

const DNA_JOB_EVENTS = ['status', 'progress', 'result', 'error'] as const;

function isTerminalDnaJobState(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/** A job snapshot plus its client receipt time (comparable across transports). */
interface JobSnapshot {
  job: DnaJobStatus | null;
  at: number;
}

const EMPTY_SNAPSHOT: JobSnapshot = { job: null, at: 0 };

/**
 * Latest-wins merge of the SSE and fallback-poll snapshots — EXCEPT a
 * terminal snapshot is never displaced by a non-terminal one (a stale
 * in-flight poll response landing after the SSE `result` event must not
 * regress the UI back to "processing"). The poll only runs after the stream
 * errors, but any SSE progress folded before the drop is still merged here.
 */
function mergeSnapshots(sse: JobSnapshot, polled: JobSnapshot | null): DnaJobStatus | null {
  if (!sse.job) return polled?.job ?? null;
  if (!polled?.job) return sse.job;
  const sseTerminal = isTerminalDnaJobState(sse.job.status);
  const pollTerminal = isTerminalDnaJobState(polled.job.status);
  if (sseTerminal !== pollTerminal) return sseTerminal ? sse.job : polled.job;
  return polled.at > sse.at ? polled.job : sse.job;
}

export interface UseDnaJobProgressOptions {
  /** Fired exactly once per job when it reaches completed/failed. */
  onTerminal?: (job: DnaJobStatus) => void;
}

export interface UseDnaJobProgressResult {
  /** Best-known job status (SSE primary, fallback poll merged in on stream error). */
  job: DnaJobStatus | null;
  isTerminal: boolean;
  /** SSE transport state — drives the Connecting/Live/Polling badge. */
  streamStatus: StreamStatus;
}

/**
 * Progress tracker for a DNA generation job. The ticket-authenticated SSE
 * stream (`@StreamScope dna_job` on the gateway route) is the
 * PRIMARY transport; a 2s status poll is the documented error fallback, spun
 * up only after the stream exhausts its retry budget (`streamStatus ===
 * 'error'`) so progress keeps flowing on networks that break SSE.
 *
 * On completion the reports/dashboard queries are invalidated so the grid
 * and roll-up refresh; the caller's `onTerminal` handles user feedback.
 */
export function useDnaJobProgress(jobId: string | null, { onTerminal }: UseDnaJobProgressOptions = {}): UseDnaJobProgressResult {
  const queryClient = useQueryClient();

  const [sse, setSse] = useState<JobSnapshot>(EMPTY_SNAPSHOT);
  const [trackedJobId, setTrackedJobId] = useState(jobId);
  // Render-time derived-state reset (the FilterSearch pattern): a new job
  // must not inherit the previous job's folded events.
  if (jobId !== trackedJobId) {
    setTrackedJobId(jobId);
    setSse(EMPTY_SNAPSHOT);
  }

  const onTerminalRef = useRef(onTerminal);
  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  // handleEvent needs stream.close, but it is created BEFORE the stream
  // handle exists — bridge with a ref (close is identity-stable).
  const closeRef = useRef<(() => void) | null>(null);

  const handleEvent = useCallback(
    (type: string, data: string) => {
      const at = Date.now();
      if (type === 'status') {
        const status = parseJson<DnaJobStatus>(data);
        if (status) setSse({ job: status, at });
        return;
      }
      if (type === 'progress') {
        const progress = parseJson<{ jobId: string; progress: number }>(data);
        if (progress) {
          setSse((previous) => (previous.job ? { job: { ...previous.job, progress: progress.progress }, at } : previous));
        }
        return;
      }
      if (type === 'result') {
        setSse((previous) => ({
          job: { jobId: previous.job?.jobId ?? jobId ?? '', status: 'completed', progress: 100, result: parseJson<unknown>(data) },
          at,
        }));
        closeRef.current?.();
        return;
      }
      if (type === 'error') {
        const failure = parseJson<{ jobId: string; error?: string }>(data);
        setSse((previous) => ({
          job: {
            jobId: previous.job?.jobId ?? failure?.jobId ?? jobId ?? '',
            status: 'failed',
            progress: previous.job?.progress ?? 0,
            error: failure?.error ?? 'Generation failed',
          },
          at,
        }));
        closeRef.current?.();
      }
    },
    [jobId],
  );

  const stream = useEventStream({
    path: jobId ? dnaJobStreamPath(jobId) : null,
    scope: jobId ? `dna_job:${jobId}` : null,
    eventNames: DNA_JOB_EVENTS,
    onEvent: handleEvent,
    enabled: !!jobId,
  });
  const { close: closeStream, status: streamStatus } = stream;
  useEffect(() => {
    closeRef.current = closeStream;
  }, [closeStream]);

  const sseTerminal = isTerminalDnaJobState(sse.job?.status);
  const poll = useQuery({
    queryKey: dnaKeys.job(jobId ?? 'idle'),
    queryFn: () => getDnaJobStatus(jobId as string),
    // Error fallback only: the SSE stream is the primary transport.
    enabled: !!jobId && !sseTerminal && streamStatus === 'error',
    // Stop once EITHER transport reported a terminal state.
    refetchInterval: (query) => (sseTerminal || isTerminalDnaJobState(query.state.data?.status) ? false : JOB_POLL_MS),
  });

  const polled: JobSnapshot | null = poll.data ? { job: poll.data, at: poll.dataUpdatedAt } : null;
  const job = jobId ? mergeSnapshots(sse, polled) : null;
  const isTerminal = isTerminalDnaJobState(job?.status);

  // Once-per-job terminal side effects: stop the stream (safety net for the
  // poll-detected end — SSE terminal events already closed eagerly), refresh
  // the grid + dashboard, then hand off to the caller for user feedback.
  const notifiedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !job || !isTerminalDnaJobState(job.status)) return;
    if (notifiedJobRef.current === jobId) return;
    notifiedJobRef.current = jobId;
    closeStream();
    if (job.status === 'completed') {
      // Root-level: the new report changes the list, the dashboard AND
      // any mounted doctor/versions reads.
      void queryClient.invalidateQueries({ queryKey: dnaKeys.root });
    }
    onTerminalRef.current?.(job);
  }, [jobId, job, closeStream, queryClient]);

  return { job, isTerminal, streamStatus: jobId ? streamStatus : 'idle' };
}
