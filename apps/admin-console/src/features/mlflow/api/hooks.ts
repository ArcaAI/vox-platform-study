'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMlflowStatus, searchMlflowExperiments, searchMlflowModelVersions, searchMlflowRegisteredModels } from './client';
import { mlflowKeys } from './keys';

/**
 * The status probe. `retry: false` because MLflow ships with no Ingress, so
 * "not reachable" is a stable fact about the deployment rather than a blip —
 * and the gateway already answers with a document rather than an error, so
 * there is nothing here for a retry to rescue.
 */
export function useMlflowStatus() {
  return useQuery({ queryKey: mlflowKeys.status(), queryFn: getMlflowStatus, staleTime: 30_000, retry: false });
}

/**
 * The three listings are gated on `enabled`, which the screen sets from BOTH
 * the active tab and `status.reachable`. Firing a registry read at a tracking
 * server the probe just said is unreachable would replace a clear "MLflow is not
 * deployed" with three redundant 503s.
 */
export function useMlflowRegisteredModels(enabled: boolean) {
  return useQuery({ queryKey: mlflowKeys.registeredModels(), queryFn: searchMlflowRegisteredModels, enabled, staleTime: 30_000, retry: false });
}

export function useMlflowModelVersions(enabled: boolean) {
  return useQuery({ queryKey: mlflowKeys.modelVersions(), queryFn: searchMlflowModelVersions, enabled, staleTime: 30_000, retry: false });
}

export function useMlflowExperiments(enabled: boolean) {
  return useQuery({ queryKey: mlflowKeys.experiments(), queryFn: searchMlflowExperiments, enabled, staleTime: 30_000, retry: false });
}

export function useRefreshMlflow() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: mlflowKeys.root });
}
