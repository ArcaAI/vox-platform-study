/**
 * @arcaai/vox - useDnaWritingStyle Hook
 *
 * DNA writing-style sample ingest (TASK-974, business plane).
 *
 * `ingest()` submits a time-ordered batch of a clinician's writing samples
 * to `POST /dna-writing-styles/ingest`, which enqueues a job for the
 * platform's hidden DNA analyst agent and answers `202` with a `jobId`.
 * `getIngestJob()` / `pollIngestJob()` track that job via
 * `GET /dna-writing-styles/ingest/jobs/:jobId` — there is no SSE on this
 * surface, so polling is the only track mechanism (README §4.1).
 *
 * Mirrors the `getJob`/`pollJob` idioms of `useConsultationJob`: state via
 * `useState`, a store-provided `apiClient` (context-backed `useAgenticStore`,
 * never the deprecated module singleton), and a `setTimeout`-driven poll
 * loop cleaned up on unmount.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useAgenticStore } from '../store';
import { DNA_WRITING_STYLE_ENDPOINTS } from '../core/constants';
import type { DnaWritingSamplesIngestInput, DnaIngestJobResponse, DnaIngestJobStatus } from '../types/dna';

const TERMINAL_INGEST_JOB_STATUSES = new Set(['completed', 'failed']);

export interface PollIngestJobOptions {
  /** Delay between polls, in ms. Default 2000. */
  intervalMs?: number;
  /** Give up and reject once this many ms have elapsed. Default 120000 (2 min). */
  timeoutMs?: number;
}

export interface UseDnaWritingStyleReturn {
  /** The most recent job snapshot — set by `ingest`, `getIngestJob` and `pollIngestJob`. */
  job: DnaIngestJobStatus | null;
  /** `true` while an `ingest()` call is in flight. */
  isIngesting: boolean;
  error: Error | null;
  /** Submit a time-ordered batch of writing samples; enqueues a job and answers `202`. */
  ingest: (input: DnaWritingSamplesIngestInput) => Promise<DnaIngestJobResponse>;
  /** Fetch the current status of an ingest job by id. */
  getIngestJob: (jobId: string) => Promise<DnaIngestJobStatus>;
  /** Poll an ingest job until it reaches a terminal status, or reject on `timeoutMs`. */
  pollIngestJob: (jobId: string, options?: PollIngestJobOptions) => Promise<DnaIngestJobStatus>;
}

export function useDnaWritingStyle(): UseDnaWritingStyleReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useDnaWritingStyle'), [store.logger]);

  const [job, setJob] = useState<DnaIngestJobStatus | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ingest = useCallback(
    async (input: DnaWritingSamplesIngestInput): Promise<DnaIngestJobResponse> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setIsIngesting(true);
      setError(null);
      const timer = logger?.startOperation('ingest');
      try {
        const data = await apiClient.post<DnaIngestJobResponse>(DNA_WRITING_STYLE_ENDPOINTS.INGEST, input);
        setJob({ jobId: data.jobId, status: 'queued' });
        timer?.end(true);
        return data;
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      } finally {
        setIsIngesting(false);
      }
    },
    [apiClient, logger],
  );

  const getIngestJob = useCallback(
    async (jobId: string): Promise<DnaIngestJobStatus> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setError(null);
      const timer = logger?.startOperation('getIngestJob');
      try {
        const data = await apiClient.get<DnaIngestJobStatus>(DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB(jobId));
        setJob(data);
        timer?.end(true);
        return data;
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      }
    },
    [apiClient, logger],
  );

  const pollIngestJob = useCallback(
    async (jobId: string, options?: PollIngestJobOptions): Promise<DnaIngestJobStatus> => {
      if (!apiClient) throw new Error('SDK not initialized');
      const intervalMs = options?.intervalMs ?? 2000;
      const timeoutMs = options?.timeoutMs ?? 120000;
      const timer = logger?.startOperation('pollIngestJob');
      const deadline = Date.now() + timeoutMs;

      return new Promise<DnaIngestJobStatus>((resolve, reject) => {
        const poll = async () => {
          try {
            const data = await apiClient.get<DnaIngestJobStatus>(DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB(jobId));
            setJob(data);

            if (TERMINAL_INGEST_JOB_STATUSES.has(data.status)) {
              timer?.end(true);
              resolve(data);
              return;
            }

            if (Date.now() >= deadline) {
              const err = new Error(`Polling ingest job "${jobId}" exceeded timeout of ${timeoutMs}ms`);
              setError(err);
              timer?.error(err);
              reject(err);
              return;
            }

            pollTimerRef.current = setTimeout(poll, intervalMs);
          } catch (err) {
            setError(err as Error);
            timer?.error(err as Error);
            reject(err);
          }
        };

        poll();
      });
    },
    [apiClient, logger],
  );

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  return useMemo(
    () => ({ job, isIngesting, error, ingest, getIngestJob, pollIngestJob }),
    [job, isIngesting, error, ingest, getIngestJob, pollIngestJob],
  );
}
