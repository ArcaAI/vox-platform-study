import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient, type PaginatedResponse } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — mirror the backend admin job surfaces (TASK-319 F1/F3):
//   - GET /admin/consultations            → PaginatedConsultationResponse  ({count})
//   - GET /admin/audio/transcription-jobs → PaginatedTranscriptionJobResponse ({total})
//   - GET /admin/audio/transcription-jobs/stats → status counts
//
// OB-02: these tenant-wide controllers already exist but had no FE consumer.
// This client only consumes them — no backend changes.
//
// IMPORTANT — envelope split (TH5/OB-06): the consultation list uses the admin
// `{ data, count, limit, page }` envelope, while the transcription-job list
// uses the SDK `{ data, total, limit, page, totalPages }` envelope. They are
// read with their respective field names below.
// ---------------------------------------------------------------------------

export interface AdminConsultationDoctor {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
}

export interface AdminConsultationDepartment {
  id: string;
  code?: string;
  name?: string;
}

export interface AdminConsultation {
  id: string;
  patientId: string;
  doctorId: string;
  doctor?: AdminConsultationDoctor;
  departmentId?: string;
  department?: AdminConsultationDepartment;
  appointmentDate: string;
  status?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminConsultationParams {
  page?: number;
  limit?: number;
  patientId?: string;
  doctorId?: string;
  departmentId?: string;
}

export type TranscriptionJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'dead';

export interface AdminTranscriptionJob {
  id: string;
  jobType: string;
  pipelineId: string;
  status: string;
  progress: number;
  consultationId?: string | null;
  mediaId?: string | null;
  queuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  retryCount: number;
  maxRetries: number;
  tenantId: string;
}

/** `{ data, total, page, limit, totalPages }` — distinct from the admin `count` envelope. */
export interface PaginatedTranscriptionJobs {
  data: AdminTranscriptionJob[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface TranscriptionJobStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  dead: number;
}

export interface AdminTranscriptionJobParams {
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const adminJobKeys = {
  all: (tenantId?: string) => ['admin', 'jobs', tenantId ?? ''] as const,
  consultations: (tenantId: string | undefined, params?: AdminConsultationParams) =>
    [...adminJobKeys.all(tenantId), 'consultations', params] as const,
  transcriptionJobs: (tenantId: string | undefined, params?: AdminTranscriptionJobParams) =>
    [...adminJobKeys.all(tenantId), 'transcription-jobs', params] as const,
  transcriptionStats: (tenantId?: string) => [...adminJobKeys.all(tenantId), 'transcription-jobs', 'stats'] as const,
};

function qs(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Query hooks — tenant-scoped (the active tenant is sent as X-Tenant-Id).
// ---------------------------------------------------------------------------

export function useAdminConsultations(
  tenantId: string,
  params?: AdminConsultationParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<AdminConsultation>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: adminJobKeys.consultations(tenantId, params),
    queryFn: () => adminClient.get<PaginatedResponse<AdminConsultation>>(`/admin/consultations${qs(params)}`, { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useAdminTranscriptionJobs(
  tenantId: string,
  params?: AdminTranscriptionJobParams,
  options?: Omit<UseQueryOptions<PaginatedTranscriptionJobs>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: adminJobKeys.transcriptionJobs(tenantId, params),
    queryFn: () => adminClient.get<PaginatedTranscriptionJobs>(`/admin/audio/transcription-jobs${qs(params)}`, { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useTranscriptionJobStats(tenantId: string, options?: Omit<UseQueryOptions<TranscriptionJobStats>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: adminJobKeys.transcriptionStats(tenantId),
    queryFn: () => adminClient.get<TranscriptionJobStats>('/admin/audio/transcription-jobs/stats', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}
