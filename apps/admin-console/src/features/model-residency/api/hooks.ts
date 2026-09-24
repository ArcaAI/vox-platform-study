'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createResidencyPolicy,
  deleteResidencyPolicy,
  getModelResidency,
  listResidencyPolicies,
  loadModel,
  setPin,
  unloadModel,
  updateResidencyPolicy,
} from './client';
import { modelResidencyKeys } from './keys';
import type {
  CreatePolicyRequest,
  LoadModelRequest,
  LoadModelResponse,
  ModelResidencyResponse,
  SetPinRequest,
  UnloadModelRequest,
  UpdatePolicyRequest,
} from './types';

/** Freshness target is <= 15s (§5.5); poll at 10s so the screen never lags the target. */
const REFRESH_MS = 10_000;

export function useModelResidency() {
  return useQuery<ModelResidencyResponse>({ queryKey: modelResidencyKeys.list(), queryFn: getModelResidency, refetchInterval: REFRESH_MS });
}

function useInvalidateModelResidency() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: modelResidencyKeys.list() });
}

/**
 * Async load (202 + `operationId`) or synchronous `already_loaded` (200).
 * The caller merges `response.model` into the list cache itself (the row must
 * appear — `state: 'loading'` — before the next 10s poll) and starts
 * `useModelResidencyOperation(operationId)` to learn when it settles.
 */
export function useLoadModel() {
  const queryClient = useQueryClient();
  return useMutation<LoadModelResponse, unknown, LoadModelRequest>({
    mutationFn: (body) => loadModel(body),
    onSuccess: (response) => {
      queryClient.setQueryData<ModelResidencyResponse | undefined>(modelResidencyKeys.list(), (current) => {
        if (!current) return current;
        const key = (model: { service: string; instance: string }) => `${model.service}::${model.instance}`;
        const withoutRow = current.models.filter((model) => key(model) !== key(response.model));
        return { ...current, models: [...withoutRow, response.model] };
      });
    },
  });
}

export function useUnloadModel() {
  const invalidate = useInvalidateModelResidency();
  return useMutation({ mutationFn: (body: UnloadModelRequest) => unloadModel(body), onSuccess: invalidate });
}

export function useSetPin() {
  const invalidate = useInvalidateModelResidency();
  return useMutation({ mutationFn: (body: SetPinRequest) => setPin(body), onSuccess: invalidate });
}

export function useResidencyPolicies() {
  return useQuery({ queryKey: modelResidencyKeys.policies(), queryFn: listResidencyPolicies });
}

export function useCreateResidencyPolicy() {
  const invalidate = useInvalidateModelResidency();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePolicyRequest) => createResidencyPolicy(body),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.policies() });
    },
  });
}

export function useUpdateResidencyPolicy() {
  const invalidate = useInvalidateModelResidency();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, expectedVersion }: { id: string; patch: UpdatePolicyRequest; expectedVersion: number }) =>
      updateResidencyPolicy(id, patch, expectedVersion),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.policies() });
    },
  });
}

export function useDeleteResidencyPolicy() {
  const invalidate = useInvalidateModelResidency();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteResidencyPolicy(id),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.policies() });
    },
  });
}
