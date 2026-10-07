'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadModelResidency, type LoadModelResidencyRequest } from '@/shared/residency';
import {
  createResidencyPolicy,
  dismissResidencySuggestion,
  getModelResidencyCatalogue,
  getModelResidencyReadiness,
  linkRuntimeKey,
  pinResidencyModel,
  previewModelLoad,
  unloadModel,
  updateResidencyPolicy,
} from './client';
import { modelResidencyKeys } from './keys';
import type {
  LinkRuntimeKeyRequest,
  ModelResidencyCatalogueResponse,
  ModelResidencyReadiness,
  PinModelRequest,
  ResidencyPolicyClass,
  UnloadModelRequest,
} from './types';

/** Freshness target is <= 15s (ticket §5.5); poll at 10s so the screen never lags the target. */
const REFRESH_MS = 10_000;

export function useModelResidencyCatalogue() {
  return useQuery<ModelResidencyCatalogueResponse>({
    queryKey: modelResidencyKeys.catalogue(),
    queryFn: getModelResidencyCatalogue,
    refetchInterval: REFRESH_MS,
  });
}

function useInvalidateCatalogue() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: modelResidencyKeys.catalogue() });
}

/**
 * Async load (202 + `operationId`) or synchronous `already_loaded` (200) — the
 * SAME `admin/model-residency/load` route `features/inference-engines` uses
 * (`@/shared/residency`). The caller polls the returned `operationId` to a
 * terminal state and refetches the catalogue itself; nothing here merges a
 * row, since the target row lives nested under `services[].models[]`.
 */
export function useLoadResidencyModel() {
  const invalidate = useInvalidateCatalogue();
  return useMutation({
    mutationFn: (body: LoadModelResidencyRequest) => loadModelResidency(body),
    onSuccess: invalidate,
  });
}

export function useUnloadResidencyModel() {
  const invalidate = useInvalidateCatalogue();
  return useMutation({ mutationFn: (body: UnloadModelRequest) => unloadModel(body), onSuccess: invalidate });
}

export interface SaveResidencyPolicyInput {
  aiModelId: string;
  service: string;
  /** From the row's `keepPolicy` — present only once an explicit policy row exists. */
  policyId: string | null;
  policyVersion: number | null;
  class: ResidencyPolicyClass;
  idleTtlSeconds: number | null;
}

/**
 * The keep-policy editor's one save path (ticket §13.2 — "PATCH with If-Match
 * or POST when no policy exists"). A row that has never had an explicit
 * policy (`policyId: null`) is CREATED on first save; one that already has a
 * row is PATCHed with If-Match built from `policyVersion`, already carried on
 * the catalogue row — no extra GET needed.
 */
export function useSaveResidencyPolicy() {
  const invalidate = useInvalidateCatalogue();
  return useMutation({
    mutationFn: (input: SaveResidencyPolicyInput) =>
      input.policyId && input.policyVersion !== null
        ? updateResidencyPolicy(input.policyId, { class: input.class, idleTtlSeconds: input.idleTtlSeconds }, input.policyVersion)
        : createResidencyPolicy({
            aiModelId: input.aiModelId,
            service: input.service,
            class: input.class,
            idleTtlSeconds: input.idleTtlSeconds,
          }),
    onSuccess: invalidate,
  });
}

// ── TASK-1051 ──────────────────────────────────────────────────────────────

/** The Load dialog's dry run. A mutation (POST), never cached: every open asks again. */
export function useLoadPreview() {
  return useMutation({ mutationFn: (body: LoadModelResidencyRequest) => previewModelLoad(body) });
}

export function useLinkRuntimeKey() {
  const invalidate = useInvalidateCatalogue();
  return useMutation({ mutationFn: (body: LinkRuntimeKeyRequest) => linkRuntimeKey(body), onSuccess: invalidate });
}

export function useDismissSuggestion() {
  const invalidate = useInvalidateCatalogue();
  return useMutation({ mutationFn: (id: string) => dismissResidencySuggestion(id), onSuccess: invalidate });
}

export function usePinResidencyModel() {
  const invalidate = useInvalidateCatalogue();
  return useMutation({ mutationFn: (body: PinModelRequest) => pinResidencyModel(body), onSuccess: invalidate });
}

export function useModelResidencyReadiness() {
  return useQuery<ModelResidencyReadiness>({
    queryKey: modelResidencyKeys.readiness(),
    queryFn: getModelResidencyReadiness,
    refetchInterval: 30_000,
  });
}
