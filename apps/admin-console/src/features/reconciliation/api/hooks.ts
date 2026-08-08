'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getLatestPerProvider, getReconciliationRuns, runReconciliation } from './client';
import { reconciliationKeys } from './keys';
import type { ReconciliationRun, ReconciliationRunsParams } from './types';

export function useReconciliationRuns(params?: ReconciliationRunsParams) {
  return useQuery<ReconciliationRun[]>({ queryKey: reconciliationKeys.runs(params), queryFn: () => getReconciliationRuns(params) });
}

export function useLatestPerProvider() {
  return useQuery<ReconciliationRun[]>({ queryKey: reconciliationKeys.latest(), queryFn: () => getLatestPerProvider() });
}

export function useRunReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => runReconciliation(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reconciliationKeys.root }),
  });
}
