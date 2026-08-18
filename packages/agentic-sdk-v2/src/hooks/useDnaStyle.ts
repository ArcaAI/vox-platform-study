/**
 * @arcaai/vox - useDnaStyle Hook (SDK-207 WS-5)
 *
 * DNA Writing Style management hook for doctor-facing operations.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { DNA_STYLE_ENDPOINTS } from '../core/constants';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import { withIdempotencyKey } from '../utils/idempotency';
import { appendFilters } from '../utils/urlUtils';
import type { DnaReport, DnaStyleVersion, DnaGenerateInput, DnaUpdateInput, DnaJobStatus, DnaErasureResult } from '../types';

/**
 * Filters for the admin cross-user report list. A super admin
 * may target a tenant via `tenantId`; a tenant admin is pinned to their CLS
 * tenant server-side. `doctorId` narrows to one in-tenant doctor.
 */
export interface AdminDnaListFilters {
  doctorId?: string;
  tenantId?: string;
  includeDisabled?: boolean;
  page?: number;
  limit?: number;
}

/** Paginated admin report envelope (mirrors the backend shape). */
export interface AdminDnaReportPage {
  data: DnaReport[];
  count: number;
  page: number;
  limit: number;
}

/**
 * SSE callbacks for DNA report generation.
 */
export interface DnaJobStreamCallbacks {
  onStatus?: (status: DnaJobStatus['status']) => void;
  onProgress?: (progress: number) => void;
  onResult?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

/**
 * Build the per-job SSE scope literal expected by the backend
 * `@StreamScope({ namespace: 'dna_job', param: 'jobId' })` decorator.
 */
const dnaJobScopeFor = (jobId: string): string => `dna_job:${jobId}`;

const DNA_TERMINAL = new Set(['completed', 'failed']);

export interface UseDnaStyleReturn {
  style: DnaReport | null;
  versions: DnaStyleVersion[];
  /** The doctor's own report history (populated by getMyReports). */
  reports: DnaReport[];
  isLoading: boolean;
  error: Error | null;
  getMyStyle: () => Promise<DnaReport>;
  /**
   * DNA generate is a side-effectful POST. Pass an explicit
   * `idempotencyKey` on the input to dedupe duplicate user-actions, or let
   * the hook mint a UUID for you per call.
   */
  generate: (input?: DnaGenerateInput & { idempotencyKey?: string }) => Promise<{ jobId: string }>;
  /**
   * Generate a brand-new DNA report seeded from a selection of
   * historical source items (prior report-version snapshots / context items).
   * Thin wrapper over `generate` that attaches the selected `sourceIds`.
   */
  generateFromHistory: (sourceIds: string[], extra?: Omit<DnaGenerateInput, 'sourceIds'> & { idempotencyKey?: string }) => Promise<{ jobId: string }>;
  update: (reportId: string, input: DnaUpdateInput) => Promise<DnaReport>;
  /**
   * Promote a historical report to the doctor's active/default
   * (`isLatest`) report. Owner + tenant scoped on the backend.
   */
  setDefault: (reportId: string) => Promise<DnaReport>;
  /** Fetch the doctor's own report history (owner-scoped). */
  getMyReports: () => Promise<DnaReport[]>;
  getVersions: (reportId: string) => Promise<DnaStyleVersion[]>;
  /**
   * Erase the caller's ENTIRE learned writing-style profile (every report and
   * every version). Idempotent. Independent of the DNA on/off toggle: erasing
   * does not opt the clinician out, so a fresh profile is rebuilt from their
   * approved notes if learning is still enabled.
   */
  resetMyStyle: () => Promise<DnaErasureResult>;
  /** Erase ONE of the caller's own reports and its versions. */
  deleteReport: (reportId: string) => Promise<DnaErasureResult>;
  /**
   * Resolve two version snapshots of a report for a side-by-side
   * diff. Reuses the versions endpoint and returns the matched `left`/`right`.
   */
  getVersionDiff: (
    reportId: string,
    fromVersionId: string,
    toVersionId: string,
  ) => Promise<{ left: DnaStyleVersion | null; right: DnaStyleVersion | null }>;
  getJobStatus: (jobId: string) => Promise<DnaJobStatus>;
  pollJobStatus: (jobId: string, options?: { intervalMs?: number; maxAttempts?: number }) => Promise<DnaReport>;
  /**
   * Subscribe to real-time DNA-report generation status via SSE.
   * Returns a cleanup function that closes the SSE connection.
   */
  streamJobStatus: (jobId: string, callbacks: DnaJobStreamCallbacks) => () => void;
  getByDoctor: (doctorId: string) => Promise<DnaReport>;
  // ─── Admin cross-user (PHI-gated) reads/generate ─────
  // These hit the `/admin/dna-writing-styles` controller (requires
  // `manage:DnaWritingStyleReport`); the service tenant-scopes the caller and
  // even SUPER_ADMIN cannot cross tenants. Distinct from the self-only
  // `getByDoctor`/`getVersions` above.
  /** Latest DNA report for another in-tenant doctor (admin). */
  adminGetReportForDoctor: (doctorId: string) => Promise<DnaReport>;
  /** Version history for a report, bypassing owner check (admin, tenant-scoped). */
  adminGetVersions: (reportId: string) => Promise<DnaStyleVersion[]>;
  /** Queue a DNA generation for another in-tenant doctor (admin). */
  adminGenerateForDoctor: (doctorId: string, input?: DnaGenerateInput & { idempotencyKey?: string }) => Promise<{ jobId: string }>;
  /** Paginated cross-user report list; narrow with `doctorId` (admin, tenant-scoped). */
  adminListReports: (filters?: AdminDnaListFilters) => Promise<AdminDnaReportPage>;
}

export function useDnaStyle(): UseDnaStyleReturn {
  const { execute, isLoading, error, apiClient, logger } = useApiOperation('useDnaStyle');

  const [style, setStyle] = useState<DnaReport | null>(null);
  const [versions, setVersions] = useState<DnaStyleVersion[]>([]);
  const [reports, setReports] = useState<DnaReport[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);

  const getMyStyle = useCallback(
    (): Promise<DnaReport> =>
      execute<DnaReport>('getMyStyle', async (client) => {
        const data = await client.get<DnaReport>(DNA_STYLE_ENDPOINTS.MY_STYLE);
        setStyle(data);
        return data;
      }),
    [execute],
  );

  const generate = useCallback(
    (input?: DnaGenerateInput & { idempotencyKey?: string }): Promise<{ jobId: string }> => {
      // Attach an idempotency key to the POST body so the
      // backend can dedupe duplicate submissions (double-clicks, retries).
      const { idempotencyKey, ...rest } = (input ?? {}) as Record<string, unknown> & { idempotencyKey?: string };
      const body = withIdempotencyKey(rest as Record<string, unknown>, idempotencyKey);
      return execute<{ jobId: string }>('generate', (client) => client.post<{ jobId: string }>(DNA_STYLE_ENDPOINTS.GENERATE, body));
    },
    [execute],
  );

  // Generate seeded from a selection of historical source items.
  const generateFromHistory = useCallback(
    (sourceIds: string[], extra?: Omit<DnaGenerateInput, 'sourceIds'> & { idempotencyKey?: string }): Promise<{ jobId: string }> => {
      const { idempotencyKey, ...rest } = (extra ?? {}) as Record<string, unknown> & { idempotencyKey?: string };
      const body = withIdempotencyKey({ ...rest, sourceIds }, idempotencyKey);
      return execute<{ jobId: string }>('generateFromHistory', (client) => client.post<{ jobId: string }>(DNA_STYLE_ENDPOINTS.GENERATE, body));
    },
    [execute],
  );

  const update = useCallback(
    (reportId: string, input: DnaUpdateInput): Promise<DnaReport> =>
      execute<DnaReport>('update', async (client) => {
        const data = await client.patch<DnaReport>(DNA_STYLE_ENDPOINTS.UPDATE(reportId), input);
        setStyle(data);
        return data;
      }),
    [execute],
  );

  // Promote a historical report to the doctor's active default.
  const setDefault = useCallback(
    (reportId: string): Promise<DnaReport> =>
      execute<DnaReport>('setDefault', async (client) => {
        const data = await client.patch<DnaReport>(DNA_STYLE_ENDPOINTS.SET_DEFAULT(reportId), {});
        setStyle(data);
        return data;
      }),
    [execute],
  );

  // Erasure — the other half of the opt-out (the toggle only stops FUTURE
  // learning). Clears local state so the UI stops showing an erased profile.
  const resetMyStyle = useCallback(
    (): Promise<DnaErasureResult> =>
      execute<DnaErasureResult>('resetMyStyle', async (client) => {
        const data = await client.delete<DnaErasureResult>(DNA_STYLE_ENDPOINTS.RESET_MY_STYLE);
        setStyle(null);
        setVersions([]);
        return data;
      }),
    [execute],
  );

  const deleteReport = useCallback(
    (reportId: string): Promise<DnaErasureResult> =>
      execute<DnaErasureResult>('deleteReport', async (client) => {
        const data = await client.delete<DnaErasureResult>(DNA_STYLE_ENDPOINTS.DELETE_REPORT(reportId));
        setVersions([]);
        return data;
      }),
    [execute],
  );

  const getVersions = useCallback(
    (reportId: string): Promise<DnaStyleVersion[]> =>
      execute<DnaStyleVersion[]>('getVersions', async (client) => {
        const raw = await client.get(DNA_STYLE_ENDPOINTS.VERSIONS(reportId));
        const items = extractArray<DnaStyleVersion>(raw);
        setVersions(items);
        return items;
      }),
    [execute],
  );

  // The doctor's own report history (owner-scoped).
  const getMyReports = useCallback(
    (): Promise<DnaReport[]> =>
      execute<DnaReport[]>('getMyReports', async (client) => {
        const raw = await client.get(DNA_STYLE_ENDPOINTS.MINE);
        const items = extractArray<DnaReport>(raw);
        setReports(items);
        return items;
      }),
    [execute],
  );

  // Resolve two versions of a report for a side-by-side diff.
  const getVersionDiff = useCallback(
    (reportId: string, fromVersionId: string, toVersionId: string): Promise<{ left: DnaStyleVersion | null; right: DnaStyleVersion | null }> =>
      execute<{ left: DnaStyleVersion | null; right: DnaStyleVersion | null }>('getVersionDiff', async (client) => {
        const raw = await client.get(DNA_STYLE_ENDPOINTS.VERSIONS(reportId));
        const items = extractArray<DnaStyleVersion>(raw);
        setVersions(items);
        return {
          left: items.find((v) => v.id === fromVersionId) ?? null,
          right: items.find((v) => v.id === toVersionId) ?? null,
        };
      }),
    [execute],
  );

  const getJobStatus = useCallback(
    (jobId: string): Promise<DnaJobStatus> =>
      execute<DnaJobStatus>('getJobStatus', (client) => client.get<DnaJobStatus>(DNA_STYLE_ENDPOINTS.JOB_STATUS(jobId))),
    [execute],
  );

  const pollJobStatus = useCallback(
    async (jobId: string, options?: { intervalMs?: number; maxAttempts?: number }): Promise<DnaReport> => {
      if (!apiClient) throw new Error('SDK not initialized');
      const intervalMs = options?.intervalMs ?? 2000;
      const maxAttempts = options?.maxAttempts ?? 60;
      const timer = logger?.startOperation('pollJobStatus');

      return new Promise<DnaReport>((resolve, reject) => {
        let attempts = 0;
        const poll = async () => {
          attempts++;
          try {
            const data = await apiClient.get<DnaJobStatus>(DNA_STYLE_ENDPOINTS.JOB_STATUS(jobId));

            if (data.status === 'completed') {
              const styleData = await apiClient.get<DnaReport>(DNA_STYLE_ENDPOINTS.MY_STYLE);
              setStyle(styleData);
              timer?.end(true);
              resolve(styleData);
              return;
            }
            if (data.status === 'failed') {
              const err = new Error('DNA report generation failed');
              timer?.error(err);
              reject(err);
              return;
            }
            if (attempts >= maxAttempts) {
              const err = new Error('Polling exceeded max attempts');
              timer?.error(err);
              reject(err);
              return;
            }
            pollTimerRef.current = setTimeout(poll, intervalMs);
          } catch (err) {
            timer?.error(err as Error);
            reject(err);
          }
        };
        poll();
      });
    },
    [apiClient, logger],
  );

  // SSE consumer for DNA generation jobs.
  const streamJobStatus = useCallback(
    (jobId: string, callbacks: DnaJobStreamCallbacks): (() => void) => {
      if (!apiClient) throw new Error('SDK not initialized');

      const sseClient = new SSEClient(dnaJobScopeFor(jobId), apiClient as unknown as SSEApiClient, logger);
      sseClientRef.current = sseClient;

      const cleanup = () => {
        sseClient.disconnect();
        if (sseClientRef.current === sseClient) {
          sseClientRef.current = null;
        }
      };

      const baseUrl = apiClient.getBaseUrl();
      const sseUrl = `${baseUrl}${DNA_STYLE_ENDPOINTS.JOB_STREAM(jobId)}`;

      sseClient.onEvent('status', (data: string) => {
        try {
          const parsed = JSON.parse(data) as DnaJobStatus;
          callbacks.onStatus?.(parsed.status);
          if (parsed.status && DNA_TERMINAL.has(parsed.status)) {
            cleanup();
          }
        } catch (err) {
          logger?.warn('Failed to parse DNA SSE status event', {
            operation: 'streamJobStatus',
            component: 'useDnaStyle',
            error: err as Error,
          });
        }
      });

      sseClient.onEvent('progress', (data: string) => {
        try {
          const parsed = JSON.parse(data) as { progress?: number };
          if (typeof parsed.progress === 'number') callbacks.onProgress?.(parsed.progress);
        } catch (err) {
          logger?.warn('Failed to parse DNA SSE progress event', {
            operation: 'streamJobStatus',
            component: 'useDnaStyle',
            error: err as Error,
          });
        }
      });

      sseClient.onEvent('result', (data: string) => {
        try {
          const parsed = JSON.parse(data);
          callbacks.onResult?.(parsed);
        } catch (err) {
          logger?.warn('Failed to parse DNA SSE result event', {
            operation: 'streamJobStatus',
            component: 'useDnaStyle',
            error: err as Error,
          });
        }
      });

      sseClient.onError(() => {
        const err = new Error('DNA SSE connection error');
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
        callbacks.onError?.(err as Error);
      }

      return cleanup;
    },
    [apiClient, logger],
  );

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      sseClientRef.current?.disconnect();
      sseClientRef.current = null;
    };
  }, []);

  const getByDoctor = useCallback(
    (doctorId: string): Promise<DnaReport> =>
      execute<DnaReport>('getByDoctor', async (client) => {
        const data = await client.get<DnaReport>(DNA_STYLE_ENDPOINTS.BY_DOCTOR(doctorId));
        setStyle(data);
        return data;
      }),
    [execute],
  );

  // ─── Admin cross-user (PHI-gated) methods ────────────
  const adminGetReportForDoctor = useCallback(
    (doctorId: string): Promise<DnaReport> =>
      execute<DnaReport>('adminGetReportForDoctor', async (client) => {
        const data = await client.get<DnaReport>(DNA_STYLE_ENDPOINTS.ADMIN_BY_DOCTOR(doctorId));
        setStyle(data);
        return data;
      }),
    [execute],
  );

  const adminGetVersions = useCallback(
    (reportId: string): Promise<DnaStyleVersion[]> =>
      execute<DnaStyleVersion[]>('adminGetVersions', async (client) => {
        const raw = await client.get(DNA_STYLE_ENDPOINTS.ADMIN_VERSIONS(reportId));
        const items = extractArray<DnaStyleVersion>(raw);
        setVersions(items);
        return items;
      }),
    [execute],
  );

  const adminGenerateForDoctor = useCallback(
    (doctorId: string, input?: DnaGenerateInput & { idempotencyKey?: string }): Promise<{ jobId: string }> => {
      const { idempotencyKey, ...rest } = (input ?? {}) as Record<string, unknown> & { idempotencyKey?: string };
      const body = withIdempotencyKey(rest as Record<string, unknown>, idempotencyKey);
      return execute<{ jobId: string }>('adminGenerateForDoctor', (client) =>
        client.post<{ jobId: string }>(DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR(doctorId), body),
      );
    },
    [execute],
  );

  const adminListReports = useCallback(
    (filters?: AdminDnaListFilters): Promise<AdminDnaReportPage> =>
      execute<AdminDnaReportPage>('adminListReports', async (client) => {
        const url = filters
          ? appendFilters(DNA_STYLE_ENDPOINTS.ADMIN_LIST, {
              doctorId: filters.doctorId,
              tenantId: filters.tenantId,
              includeDisabled: filters.includeDisabled ? 'true' : undefined,
              page: filters.page !== undefined ? String(filters.page) : undefined,
              limit: filters.limit !== undefined ? String(filters.limit) : undefined,
            })
          : DNA_STYLE_ENDPOINTS.ADMIN_LIST;
        return client.get<AdminDnaReportPage>(url);
      }),
    [execute],
  );

  return {
    style,
    versions,
    reports,
    isLoading,
    error,
    getMyStyle,
    generate,
    generateFromHistory,
    update,
    setDefault,
    resetMyStyle,
    deleteReport,
    getMyReports,
    getVersions,
    getVersionDiff,
    getJobStatus,
    pollJobStatus,
    streamJobStatus,
    getByDoctor,
    adminGetReportForDoctor,
    adminGetVersions,
    adminGenerateForDoctor,
    adminListReports,
  };
}
