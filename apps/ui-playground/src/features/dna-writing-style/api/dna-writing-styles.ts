import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { AdminApiError, adminClient } from '../../admin/api/admin-client';
import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';

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
}

export interface DnaUpdateInput {
  reportData?: Partial<DnaReportData>;
  styleText?: string;
  changeReason?: string;
}

export interface DnaJobStatus {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  jobId: string;
  result?: DnaReport;
  error?: string;
}

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

const keys = {
  all: ['dna-writing-styles'] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
  myStyle: () => [...keys.all, 'my-style'] as const,
  versions: (reportId: string) => [...keys.all, 'versions', reportId] as const,
  jobStatus: (jobId: string) => [...keys.all, 'job', jobId] as const,
};

// ---------------------------------------------------------------------------
// Query Hooks (user-scoped only)
// ---------------------------------------------------------------------------

export function useMyDnaStyle(
  options?: Omit<UseQueryOptions<DnaReport | null>, 'queryKey' | 'queryFn'>,
) {
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

export function useDnaStyleByDoctor(
  doctorId: string,
  options?: Omit<UseQueryOptions<DnaReport>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: [...keys.all, 'by-doctor', doctorId] as const,
    queryFn: () =>
      adminClient.get<DnaReport>(`/dna-writing-styles/doctor/${doctorId}`),
    enabled: !!doctorId,
    ...options,
  });
}

export function useDnaVersions(
  reportId: string,
  options?: Omit<UseQueryOptions<DnaStyleVersion[]>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.versions(reportId),
    queryFn: () =>
      adminClient.get<DnaStyleVersion[]>(
        `/dna-writing-styles/${reportId}/versions`,
      ),
    enabled: !!reportId,
    ...options,
  });
}

export function useDnaJobStatus(
  jobId: string,
  options?: Omit<UseQueryOptions<DnaJobStatus>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.jobStatus(jobId),
    queryFn: () =>
      adminClient.get<DnaJobStatus>(
        `/dna-writing-styles/jobs/${jobId}`,
      ),
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
    mutationFn: (input: DnaGenerateInput) =>
      adminClient.post<{ jobId: string }>('/dna-writing-styles/generate', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
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

// ---------------------------------------------------------------------------
// SSE Streaming (user-scoped only)
// ---------------------------------------------------------------------------

export interface DnaStreamChunk {
  type: 'chunk' | 'meta' | 'done' | 'error' | 'status';
  content?: string;
  data?: Record<string, unknown>;
}

export interface DnaStreamCallbacks {
  onChunk: (chunk: DnaStreamChunk) => void;
  onDone?: (finalReport?: DnaReport) => void;
  onError?: (error: Error) => void;
}

function getStreamHeaders(): Record<string, string> {
  const { accessToken, apiKey, authMethod, tenantId, isImpersonating, impersonationToken } =
    useAuthStore.getState();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  if (authMethod === 'credentials') {
    const token = isImpersonating && impersonationToken ? impersonationToken : accessToken;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } else if (authMethod === 'apiKey' && apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  if (tenantId) {
    headers['X-Tenant-Id'] = tenantId;
  }

  return headers;
}

/**
 * Initiates a DNA report generation via SSE stream for the current user.
 * POST /dna-writing-styles/generate with `stream: true`, then reads the
 * response body as a ReadableStream, parsing SSE `data:` lines.
 *
 * Returns an AbortController so the caller can cancel the stream.
 */
export function streamDnaGenerate(
  input: DnaGenerateInput,
  callbacks: DnaStreamCallbacks,
): AbortController {
  const abort = new AbortController();
  const baseUrl = usePlaygroundStore.getState().apiBaseUrl;
  const url = `${baseUrl}/dna-writing-styles/generate`;

  (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: getStreamHeaders(),
        body: JSON.stringify({ ...input, stream: true }),
        signal: abort.signal,
      });

      if (!res.ok) {
        let errorBody: unknown;
        try { errorBody = await res.json(); } catch { /* empty */ }
        const msg =
          (errorBody as { message?: string })?.message ??
          `Stream request failed (${res.status})`;
        callbacks.onError?.(new Error(msg));
        return;
      }

      if (!res.body) {
        callbacks.onError?.(new Error('Response body is empty — streaming not supported'));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('data: ')) {
              const payload = trimmed.slice(6).trim();
              if (payload === '[DONE]') {
                callbacks.onDone?.();
                return;
              }
              try {
                const chunk = JSON.parse(payload) as DnaStreamChunk;
                callbacks.onChunk(chunk);

                if (chunk.type === 'done') {
                  const report = chunk.data as unknown as DnaReport | undefined;
                  callbacks.onDone?.(report);
                  return;
                }
                if (chunk.type === 'error') {
                  callbacks.onError?.(new Error(chunk.content ?? 'Stream error'));
                  return;
                }
              } catch {
                callbacks.onChunk({ type: 'chunk', content: payload });
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      callbacks.onDone?.();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      callbacks.onError?.(err as Error);
    }
  })();

  return abort;
}

export { keys as dnaWritingStyleKeys };
