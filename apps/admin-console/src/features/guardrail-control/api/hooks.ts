'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGuardrailActivity,
  getGuardrailAvailability,
  getGuardrailCatalogue,
  getGuardrailHealth,
  getGuardrailJudgeLanes,
  getGuardrailJudgeMeta,
  getGuardrailModelSummary,
  getGuardrailPerformance,
  listGuardrailEvaluations,
  listGuardrailPolicyKeys,
  listGuardrailPolicyRevisions,
  putGuardrailAvailability,
  resetGuardrailJudgeMeta,
  resetGuardrailPolicyKey,
  resetGuardrailPolicyLane,
  restoreGuardrailPolicyRevision,
  runGuardrailDryRun,
  updateGuardrailJudgeLanes,
  updateGuardrailJudgeMeta,
  updateGuardrailPolicyKey,
} from './client';
import { guardrailControlKeys } from './keys';
import type {
  GuardrailDryRunRequest,
  GuardrailEvaluationQuery,
  GuardrailJudgeCategoryTarget,
  GuardrailJudgeMeta,
  GuardrailMetricsWindow,
  GuardrailStoredPolicy,
} from './types';

// ── Rules ────────────────────────────────────────────────────────────────────

/** Static per deployment, so cached hard. */
export function useGuardrailCatalogue() {
  return useQuery({ queryKey: guardrailControlKeys.catalogue(), queryFn: getGuardrailCatalogue, staleTime: Infinity });
}

export function useGuardrailAvailability(tenantId: string | null) {
  return useQuery({
    queryKey: guardrailControlKeys.availability(tenantId ?? ''),
    queryFn: () => getGuardrailAvailability(tenantId as string),
    enabled: Boolean(tenantId),
  });
}

/**
 * Single-row OCC PUT: the response IS the re-read row, so it seeds the cache; any failure (a 412 above
 * all) invalidates so the next read carries the version that actually won. A SYSTEM-row write moves every
 * tenant's effective view, so it drops every cached availability row.
 */
export function useUpdateGuardrailAvailability(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ policies, version }: { policies: GuardrailStoredPolicy | Record<string, never>; version: number }) =>
      putGuardrailAvailability(tenantId, policies, version),
    onSuccess: (row) => {
      queryClient.setQueryData(guardrailControlKeys.availability(tenantId), row);
      void queryClient.invalidateQueries({ queryKey: [...guardrailControlKeys.root, 'availability'], predicate: (q) => q.queryKey[2] !== tenantId });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.availability(tenantId) }),
  });
}

// ── Policy keys ──────────────────────────────────────────────────────────────

export function useGuardrailPolicyKeys() {
  return useQuery({ queryKey: guardrailControlKeys.policyKeys(), queryFn: listGuardrailPolicyKeys });
}

function useInvalidatePolicyKeys() {
  const queryClient = useQueryClient();
  return (key?: string) => {
    void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.policyKeys() });
    if (key) void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.revisions(key) });
  };
}

/** Any outcome may have moved the model row's `_version` (or the 412 says it already did), so settle → re-read. */
export function useUpdateGuardrailPolicyKey() {
  const invalidate = useInvalidatePolicyKeys();
  return useMutation({
    mutationFn: ({ key, value, modelVersion }: { key: string; value: unknown; modelVersion: number }) =>
      updateGuardrailPolicyKey(key, value, modelVersion),
    onSettled: (_data, _error, variables) => invalidate(variables.key),
  });
}

export function useResetGuardrailPolicyKey() {
  const invalidate = useInvalidatePolicyKeys();
  return useMutation({ mutationFn: (key: string) => resetGuardrailPolicyKey(key), onSettled: (_d, _e, key) => invalidate(key) });
}

export function useResetGuardrailPolicyLane() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lane: string) => resetGuardrailPolicyLane(lane),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.root }),
  });
}

export function useGuardrailPolicyRevisions(key: string, enabled: boolean) {
  return useQuery({ queryKey: guardrailControlKeys.revisions(key), queryFn: () => listGuardrailPolicyRevisions(key), enabled });
}

export function useRestoreGuardrailPolicyRevision() {
  const invalidate = useInvalidatePolicyKeys();
  return useMutation({
    mutationFn: ({ key, revisionId }: { key: string; revisionId: string }) => restoreGuardrailPolicyRevision(key, revisionId),
    onSettled: (_d, _e, variables) => invalidate(variables.key),
  });
}

// ── Judge models ─────────────────────────────────────────────────────────────

export function useGuardrailJudgeMeta(modelId: string | null) {
  return useQuery({
    queryKey: guardrailControlKeys.judgeMeta(modelId ?? ''),
    queryFn: () => getGuardrailJudgeMeta(modelId as string),
    enabled: Boolean(modelId),
  });
}

export function useUpdateGuardrailJudgeMeta(modelId: string) {
  const queryClient = useQueryClient();
  const onSuccess = (meta: GuardrailJudgeMeta) => queryClient.setQueryData(guardrailControlKeys.judgeMeta(modelId), meta);
  return useMutation({
    mutationFn: ({
      body,
      version,
    }: {
      body: { categoryMap?: Record<string, GuardrailJudgeCategoryTarget>; tiers?: Record<string, string> };
      version: number;
    }) => updateGuardrailJudgeMeta(modelId, body, version),
    onSuccess,
    onError: () => void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.judgeMeta(modelId) }),
  });
}

export function useResetGuardrailJudgeMeta(modelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => resetGuardrailJudgeMeta(modelId),
    onSuccess: (meta) => queryClient.setQueryData(guardrailControlKeys.judgeMeta(modelId), meta),
    onError: () => void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.judgeMeta(modelId) }),
  });
}

export function useGuardrailJudgeLanes() {
  return useQuery({ queryKey: guardrailControlKeys.judgeLanes(), queryFn: getGuardrailJudgeLanes });
}

/** A lane switch moves which model row a lane's keys live on, so the key list re-reads too. */
export function useUpdateGuardrailJudgeLanes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (selections: { lane: string; modelId: string }[]) => updateGuardrailJudgeLanes(selections),
    onSuccess: (lanes) => queryClient.setQueryData(guardrailControlKeys.judgeLanes(), lanes),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: guardrailControlKeys.policyKeys() }),
  });
}

export function useGuardrailModelSummary(modelId: string) {
  return useQuery({ queryKey: guardrailControlKeys.model(modelId), queryFn: () => getGuardrailModelSummary(modelId) });
}

/** Read-only evaluation: persists nothing, loads nothing (409 `MODEL_NOT_RESIDENT` instead). */
export function useGuardrailDryRun() {
  return useMutation({ mutationFn: (body: GuardrailDryRunRequest) => runGuardrailDryRun(body) });
}

// ── Monitoring ───────────────────────────────────────────────────────────────

export function useGuardrailActivity(window: GuardrailMetricsWindow) {
  return useQuery({ queryKey: guardrailControlKeys.activity(window), queryFn: () => getGuardrailActivity(window) });
}

export function useGuardrailPerformance() {
  return useQuery({ queryKey: guardrailControlKeys.performance(), queryFn: getGuardrailPerformance, refetchInterval: 30_000 });
}

export function useGuardrailHealth() {
  return useQuery({ queryKey: guardrailControlKeys.health(), queryFn: getGuardrailHealth, refetchInterval: 30_000 });
}

export function useGuardrailEvaluations(query: GuardrailEvaluationQuery) {
  return useQuery({ queryKey: guardrailControlKeys.evaluations(query), queryFn: () => listGuardrailEvaluations(query) });
}
