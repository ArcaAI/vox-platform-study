/**
 * @arcaai/vox - useConsultationJob Hook
 *
 * Consultation job tracking with SSE streaming and polling.
 * Uses SSEClient for authenticated, reconnectable SSE connections.
 *
 * Connects via the `SSEClient(scope, apiClient, logger)` constructor. There
 * is no `authToken` plumbing — SSE auth is ticket-based
 * (`?ticket=<single-use>`), fetched per-connect by the SSEClient itself.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useAgenticStore } from '../store';
import { CONSULTATION_JOB_ENDPOINTS, CONTEXT_ENDPOINTS, consultationJobStreamScope } from '../core/constants';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import type { ConsultationJob, JobStatus, PollOptions, JobStreamCallbacks } from '../types/consultation-job';
import { isTerminalStatus } from '../types/consultation-job';

/**
 * The gateway's job status vocabulary (`PENDING` / `RUNNING` / `COMPLETED` / `FAILED` /
 * `CANCELLED`, and the `CANCELED` spelling a read may still carry) onto {@link JobStatus}. A value
 * already in the SDK's own vocabulary (`processing`) passes through unchanged.
 */
function toJobStatus(raw: unknown): JobStatus {
  const lowered = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (lowered === 'running') return 'processing';
  if (lowered === 'canceled') return 'cancelled';
  return lowered as JobStatus;
}

export interface UseConsultationJobReturn {
  job: ConsultationJob | null;
  status: JobStatus;
  isStreaming: boolean;
  error: Error | null;
  getJob: (jobId: string) => Promise<ConsultationJob>;
  cancelJob: (jobId: string) => Promise<void>;
  streamJob: (jobId: string, callbacks: JobStreamCallbacks) => () => void;
  pollJob: (jobId: string, options?: PollOptions) => Promise<ConsultationJob>;
}

export function useConsultationJob(): UseConsultationJobReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useConsultationJob'), [store.logger]);

  const [job, setJob] = useState<ConsultationJob | null>(null);
  const [status, setStatus] = useState<JobStatus>('idle');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshContextItems = useCallback(
    async (consultationId: string): Promise<void> => {
      if (!apiClient) return;
      try {
        await apiClient.get(CONTEXT_ENDPOINTS.GET(consultationId));
        logger?.debug('Context items refreshed after job completion', {
          operation: 'refreshContextItems',
          component: 'useConsultationJob',
          sdk: { consultationId },
        });
      } catch (err) {
        logger?.warn('Failed to refresh context items after job completion', {
          operation: 'refreshContextItems',
          component: 'useConsultationJob',
          error: err as Error,
        });
      }
    },
    [apiClient, logger],
  );

  const getJob = useCallback(
    async (jobId: string): Promise<ConsultationJob> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setError(null);
      const timer = logger?.startOperation('getJob');
      try {
        const data = await apiClient.get<ConsultationJob>(CONSULTATION_JOB_ENDPOINTS.GET(jobId));
        setJob(data);
        setStatus(data.status as JobStatus);
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

  const cancelJob = useCallback(
    async (jobId: string): Promise<void> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setError(null);
      const timer = logger?.startOperation('cancelJob');
      try {
        await apiClient.patch(CONSULTATION_JOB_ENDPOINTS.CANCEL(jobId), {});
        setStatus('cancelled');
        timer?.end(true);
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      }
    },
    [apiClient, logger],
  );

  const streamJob = useCallback(
    (jobId: string, callbacks: JobStreamCallbacks): (() => void) => {
      if (!apiClient) throw new Error('SDK not initialized');
      setIsStreaming(true);
      setError(null);

      const sseClient = new SSEClient(consultationJobStreamScope(jobId), apiClient as unknown as SSEApiClient, logger);
      sseClientRef.current = sseClient;

      const cleanup = () => {
        sseClient.disconnect();
        sseClientRef.current = null;
        setIsStreaming(false);
      };

      const baseUrl = apiClient.getBaseUrl();
      const sseUrl = `${baseUrl}${CONSULTATION_JOB_ENDPOINTS.SSE(jobId)}`;

      logger?.info('Connecting to consultation job SSE stream', {
        operation: 'streamJob',
        component: 'useConsultationJob',
        attributes: { jobId, url: sseUrl },
      });

      sseClient.onEvent('status', (data: string) => {
        try {
          const parsed = JSON.parse(data);
          const next = toJobStatus(parsed.status);
          // Every frame carries the FULL job status (TASK-1038 B3a), so the job in state is that frame.
          if (typeof parsed.jobId === 'string') setJob({ ...parsed, id: parsed.jobId } as ConsultationJob);
          setStatus(next);
          callbacks.onStatus?.(next);
          if (isTerminalStatus(next)) {
            cleanup();
            const cId = parsed.consultationId || store.consultation?.id;
            if (cId) refreshContextItems(cId);
          }
        } catch (err) {
          logger?.warn('Failed to parse SSE status event', {
            operation: 'streamJob',
            component: 'useConsultationJob',
            error: err as Error,
          });
        }
      });

      sseClient.onEvent('progress', (data: string) => {
        try {
          const parsed = JSON.parse(data);
          callbacks.onProgress?.(parsed.progress);
        } catch (err) {
          logger?.warn('Failed to parse SSE progress event', {
            operation: 'streamJob',
            component: 'useConsultationJob',
            error: err as Error,
          });
        }
      });

      sseClient.onEvent('result', (data: string) => {
        try {
          const parsed = JSON.parse(data);
          // The gateway's `result` frame is the full job status; the job's result rides on it. A
          // bare result object (the pre-TASK-1038 frame) is passed through as it was.
          const isJobFrame = parsed !== null && typeof parsed === 'object' && 'status' in parsed && 'result' in parsed;
          callbacks.onResult?.(isJobFrame ? parsed.result : parsed);
        } catch (err) {
          logger?.warn('Failed to parse SSE result event', {
            operation: 'streamJob',
            component: 'useConsultationJob',
            error: err as Error,
          });
        }
      });

      sseClient.onError(() => {
        const err = new Error('SSE connection error');
        setError(err);
        callbacks.onError?.(err);
      });

      try {
        sseClient.connect(sseUrl, {
          autoReconnect: true,
          reconnectIntervalMs: 2000,
          maxReconnectAttempts: 15,
          maxDelayMs: 30000,
        });
      } catch (err) {
        setError(err as Error);
        setIsStreaming(false);
        callbacks.onError?.(err as Error);
      }

      return cleanup;
    },
    [apiClient, logger, store.consultation, refreshContextItems],
  );

  const pollJob = useCallback(
    async (jobId: string, options?: PollOptions): Promise<ConsultationJob> => {
      if (!apiClient) throw new Error('SDK not initialized');
      const intervalMs = options?.intervalMs ?? 2000;
      const maxAttempts = options?.maxAttempts ?? 60;
      const timer = logger?.startOperation('pollJob');

      let attempts = 0;

      return new Promise<ConsultationJob>((resolve, reject) => {
        const poll = async () => {
          attempts++;
          try {
            const data = await apiClient.get<ConsultationJob>(CONSULTATION_JOB_ENDPOINTS.GET(jobId));
            setJob(data);
            setStatus(data.status as JobStatus);

            if (isTerminalStatus(data.status)) {
              timer?.end(true);
              const cId = data.consultationId || store.consultation?.id;
              if (cId) {
                refreshContextItems(cId).finally(() => resolve(data));
              } else {
                resolve(data);
              }
              return;
            }

            if (attempts >= maxAttempts) {
              const err = new Error('Polling exceeded max attempts');
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
    [apiClient, logger, store.consultation, refreshContextItems],
  );

  useEffect(() => {
    return () => {
      sseClientRef.current?.disconnect();
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  return useMemo(
    () => ({
      job,
      status,
      isStreaming,
      error,
      getJob,
      cancelJob,
      streamJob,
      pollJob,
    }),
    [job, status, isStreaming, error, getJob, cancelJob, streamJob, pollJob],
  );
}
