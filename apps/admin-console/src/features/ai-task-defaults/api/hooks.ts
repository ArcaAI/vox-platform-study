'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEffectiveTaskDefault, getEffectiveTaskDefaults, getTaskDefaultRow, getTaskModelOptions, putTaskDefaultRow } from './client';
import { aiTaskDefaultKeys } from './keys';
import type { AiTaskKey, UpsertAiTaskDefaultRequest } from './types';

export function useEffectiveTaskDefaults(tenantId?: string) {
  return useQuery({ queryKey: aiTaskDefaultKeys.effectiveAll(tenantId), queryFn: () => getEffectiveTaskDefaults(tenantId) });
}

export function useEffectiveTaskDefault(taskKey: AiTaskKey, tenantId?: string) {
  return useQuery({ queryKey: aiTaskDefaultKeys.effective(taskKey, tenantId), queryFn: () => getEffectiveTaskDefault(taskKey, tenantId) });
}

export function useTaskDefaultRow(taskKey: AiTaskKey, tenantId?: string) {
  return useQuery({ queryKey: aiTaskDefaultKeys.row(taskKey, tenantId), queryFn: () => getTaskDefaultRow(taskKey, tenantId) });
}

export function useTaskModelOptions(taskKey: AiTaskKey) {
  return useQuery({ queryKey: aiTaskDefaultKeys.options(taskKey), queryFn: () => getTaskModelOptions(taskKey) });
}

export function usePutTaskDefaultRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskKey,
      body,
      etag,
      tenantId,
    }: {
      taskKey: AiTaskKey;
      body: Omit<UpsertAiTaskDefaultRequest, 'expectedVersion'>;
      etag: string | null;
      tenantId?: string;
    }) => putTaskDefaultRow(taskKey, body, etag, tenantId),
    // The row edit also moves the resolved effective default.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: aiTaskDefaultKeys.root }),
  });
}
