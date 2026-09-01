'use client';

/**
 * The model CATALOGUE, read-only — what provider configurations select from.
 *
 * `features/ai-models` owns the authoritative editor (register, edit, discover,
 * OCC writes) and keeps its own fuller types. Rule 13 forbids importing it, so
 * this is the same minimal-copy posture as `model-store-client.ts`: the fields
 * this tab renders, one GET, no writes. The tab links out to `/ai-models` for
 * every mutation rather than growing a second editor.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, postJson } from '@/shared/api';

export interface CatalogueModel {
  id: string;
  slug: string;
  name: string;
  provider?: string | null;
  category: string;
  taskType: string;
  modelType: string;
  source: string;
  sourceUri: string;
  sourceRevision?: string | null;
  format: string;
  downloadStatus: string;
  tenantId: string;
  resourceStatus: string;
}

/** The registration body — the same shape `/ai-models` posts. */
export interface RegisterCatalogueModelRequest {
  slug: string;
  name: string;
  description?: string;
  category: string;
  taskType: string;
  modelType: string;
  source: string;
  sourceUri: string;
  sourceRevision?: string;
  format: string;
  provider?: string;
}

const BASE = 'admin/ai-models';

export function useCatalogueModels(enabled = true) {
  return useQuery({
    queryKey: ['ai-platform', 'catalogue'],
    queryFn: () => getJson<CatalogueModel[]>(BASE),
    enabled,
    retry: false,
  });
}

/**
 * Register a catalogue row.
 *
 * The model store's "fetch from HuggingFace" flow lands here: on this platform
 * a Hub model is BROUGHT IN by cataloguing it with `source: HUGGINGFACE` and a
 * `hf:<org>/<repo>` `sourceUri`, after which the weight fetcher pulls it on
 * first use. There is no separate download endpoint to call, and inventing a
 * client for one would produce a button that talks to nothing.
 */
export function useRegisterCatalogueModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterCatalogueModelRequest) => postJson<CatalogueModel>(BASE, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-platform', 'catalogue'] }),
  });
}
