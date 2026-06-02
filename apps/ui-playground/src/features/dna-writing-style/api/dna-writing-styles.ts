import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { AdminApiError, adminClient } from '../../admin/api/admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DnaReportData {
  tone?: string;
  vocabulary?: string;
  structure?: string;
  formality?: string;
  sentenceLength?: string;
  medicalTermUsage?: string;
  abbreviationStyle?: string;
  [key: string]: unknown;
}

export interface DnaReport {
  id: string;
  tenantId?: string;
  doctorId: string;
  reportData: DnaReportData | null;
  styleText?: string | null;
  isLatest: boolean;
  currentVersionNumber: number;
  resourceStatus?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DnaStyleVersion {
  id: string;
  tenantId?: string;
  dnaReportId: string;
  versionNumber: number;
  reportData: DnaReportData | null;
  styleText?: string | null;
  changeReason?: string | null;
  changedBy?: string | null;
  createdAt: string;
}

export interface DnaGenerateInput {
  textSamples?: string[];
  departmentId?: string;
  // TASK-329 P5 — historical source item IDs selected to seed generation.
  sourceIds?: string[];
}

export interface DnaUpdateInput {
  reportData?: Partial<DnaReportData>;
  styleText?: string;
  changeReason?: string;
}

export interface DnaJobResult {
  reportId: string;
  reportData?: Record<string, unknown>;
  styleText?: string;
}

export interface DnaJobStatus {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  jobId: string;
  progress?: number;
  result?: DnaJobResult;
  error?: string;
}

export interface DnaStreamCallbacks {
  onStatus?: (status: DnaJobStatus) => void;
  onProgress?: (progress: number) => void;
  onResult?: (result: DnaJobResult | null) => void;
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

const keys = {
  all: ['dna-writing-styles'] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
  myStyle: () => [...keys.all, 'my-style'] as const,
  // TASK-329 P5 — the doctor's own report history (set-default picker source).
  mine: () => [...keys.all, 'mine'] as const,
  versions: (reportId: string) => [...keys.all, 'versions', reportId] as const,
  jobStatus: (jobId: string) => [...keys.all, 'job', jobId] as const,
};

/**
 * TASK-329 P5 — Pure optimistic transform: promote `reportId` to the doctor's
 * default (`isLatest`) and demote every other report, so the cached `/mine`
 * list reflects the new default immediately (before the PATCH resolves).
 */
export function applyDefaultToReports(reports: DnaReport[], reportId: string): DnaReport[] {
  return reports.map((r) => ({ ...r, isLatest: r.id === reportId }));
}

// ---------------------------------------------------------------------------
// Query Hooks (user-scoped only)
// ---------------------------------------------------------------------------

export function useMyDnaStyle(options?: Omit<UseQueryOptions<DnaReport | null>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.myStyle(),
    queryFn: async () => {
      try {
        return await adminClient.get<DnaReport>('/dna-writing-styles/my-style');
      } catch (error) {
        if (error instanceof AdminApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    retry: (failureCount, error) => {
      if (error instanceof AdminApiError && error.status === 404) return false;
      return failureCount < 3;
    },
    ...options,
  });
}

export function useMyDnaReports(options?: Omit<UseQueryOptions<DnaReport[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.mine(),
    queryFn: () => adminClient.get<DnaReport[]>('/dna-writing-styles/mine'),
    ...options,
  });
}

export function useDnaStyleByDoctor(doctorId: string, options?: Omit<UseQueryOptions<DnaReport>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: [...keys.all, 'by-doctor', doctorId] as const,
    queryFn: () => adminClient.get<DnaReport>(`/dna-writing-styles/doctor/${doctorId}`),
    enabled: !!doctorId,
    ...options,
  });
}

export function useDnaVersions(reportId: string, options?: Omit<UseQueryOptions<DnaStyleVersion[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.versions(reportId),
    queryFn: () => adminClient.get<DnaStyleVersion[]>(`/dna-writing-styles/${reportId}/versions`),
    enabled: !!reportId,
    ...options,
  });
}

export function useDnaJobStatus(jobId: string, options?: Omit<UseQueryOptions<DnaJobStatus>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.jobStatus(jobId),
    queryFn: () => adminClient.get<DnaJobStatus>(`/dna-writing-styles/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'completed' || data?.status === 'failed') return false;
      return 2000;
    },
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation Hooks (user-scoped only)
// ---------------------------------------------------------------------------

export function useGenerateDnaReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DnaGenerateInput) => adminClient.post<{ jobId: string }>('/dna-writing-styles/generate', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function streamDnaJob(jobId: string, callbacks: DnaStreamCallbacks): AbortController {
  const abort = new AbortController();

  void (async () => {
    try {
      const response = await adminClient.stream(`/dna-writing-styles/jobs/${jobId}/stream`, abort.signal);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SSE response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';

      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          const lines = eventBlock.split('\n');
          const eventName =
            lines
              .find((line) => line.startsWith('event:'))
              ?.slice(6)
              .trim() ?? 'message';
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

          if (!data) continue;

          if (eventName === 'status') {
            callbacks.onStatus?.(JSON.parse(data) as DnaJobStatus);
          } else if (eventName === 'progress') {
            const parsed = JSON.parse(data) as { progress?: number };
            callbacks.onProgress?.(parsed.progress ?? 0);
          } else if (eventName === 'result') {
            callbacks.onResult?.(JSON.parse(data) as DnaJobResult | null);
          } else if (eventName === 'error') {
            const parsed = JSON.parse(data) as { error?: string };
            throw new Error(parsed.error ?? 'DNA stream failed');
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return abort;
}

export function useUpdateDnaReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reportId, ...input }: DnaUpdateInput & { reportId: string }) =>
      adminClient.patch<DnaReport>(`/dna-writing-styles/${reportId}`, input),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.reportId) });
    },
  });
}

/**
 * TASK-329 P5 — Promote a report to the doctor's default with an optimistic
 * cache update + rollback. The cached `/mine` list flips immediately so the
 * default badge moves without waiting for the round-trip; on error we restore
 * the snapshot, and on settle we reconcile with the server.
 */
export function useSetDefaultDnaReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) => adminClient.patch<DnaReport>(`/dna-writing-styles/${reportId}/default`, {}),
    onMutate: async (reportId) => {
      await qc.cancelQueries({ queryKey: keys.mine() });
      const previous = qc.getQueryData<DnaReport[]>(keys.mine());
      if (previous) {
        qc.setQueryData<DnaReport[]>(keys.mine(), applyDefaultToReports(previous, reportId));
      }
      return { previous };
    },
    onError: (_err, _reportId, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.mine(), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export { keys as dnaWritingStyleKeys };
