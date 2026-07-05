import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — mirror the backend scheduler-admin surface (TASK-250 / OB-03):
//   - GET   /admin/schedulers              → SchedulerInfo[]
//   - POST  /admin/schedulers/:name/pause  → { success }
//   - POST  /admin/schedulers/:name/resume → { success }
//   - PATCH /admin/schedulers/:name/cron   → SchedulerInfo  (dynamic only)
//   - PATCH /admin/schedulers/:name/toggle → SchedulerInfo  (dynamic only)
//
// OB-03: same GLOBAL_ADMIN-only posture as the queue-admin controller. Only
// `dynamic` schedulers (e.g. `dna-regeneration`) accept cron/toggle edits; the
// server returns 400 for static ones. This client only consumes the API.
// ---------------------------------------------------------------------------

export interface SchedulerInfo {
  name: string;
  type: 'cron' | 'interval' | 'timeout';
  source: 'static' | 'dynamic';
  cronExpression: string | null;
  intervalMs: number | null;
  running: boolean;
  lastExecution: string | null;
  nextExecution: string | null;
  timeZone: string | null;
  settingsKey: string | null;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const schedulerKeys = {
  all: ['admin', 'schedulers'] as const,
  list: () => [...schedulerKeys.all, 'list'] as const,
};

// ---------------------------------------------------------------------------
// Query hook
// ---------------------------------------------------------------------------

export function useSchedulers(options?: Omit<UseQueryOptions<SchedulerInfo[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: schedulerKeys.list(),
    queryFn: () => adminClient.get<SchedulerInfo[]>('/admin/schedulers'),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export interface UpdateCronInput {
  name: string;
  cronExpression: string;
}

export interface ToggleSchedulerInput {
  name: string;
  enabled: boolean;
}

export function usePauseScheduler() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => adminClient.post<{ success: boolean }>(`/admin/schedulers/${name}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  });
}

export function useResumeScheduler() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => adminClient.post<{ success: boolean }>(`/admin/schedulers/${name}/resume`),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  });
}

export function useUpdateSchedulerCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, cronExpression }: UpdateCronInput) => adminClient.patch<SchedulerInfo>(`/admin/schedulers/${name}/cron`, { cronExpression }),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  });
}

export function useToggleScheduler() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enabled }: ToggleSchedulerInput) => adminClient.patch<SchedulerInfo>(`/admin/schedulers/${name}/toggle`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  });
}
