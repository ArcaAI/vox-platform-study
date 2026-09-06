'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import {
  createModel,
  deleteModel,
  discoverModels,
  getModel,
  getModelBySlug,
  getModelDownloadState,
  getModelRegistryConnectionStatus,
  listModels,
  listModelsPaginated,
  runModelInventory,
  setModelPlatformDefault,
  startModelDownload,
  updateModel,
} from './client';
import { aiModelKeys } from './keys';
import type { AiTaskKind, CreateModelRequest, ModelInventoryReport, UpdateModelRequest } from './types';

export function useModels() {
  return useQuery({ queryKey: aiModelKeys.all(), queryFn: listModels });
}

export function useModelsPaginated(params?: ListParams) {
  return useQuery({ queryKey: aiModelKeys.list(params), queryFn: () => listModelsPaginated(params), placeholderData: keepPreviousData });
}

export function useModel(id: string) {
  return useQuery({ queryKey: aiModelKeys.detail(id), queryFn: () => getModel(id), enabled: !!id });
}

export function useModelBySlug(slug: string) {
  return useQuery({ queryKey: aiModelKeys.bySlug(slug), queryFn: () => getModelBySlug(slug), enabled: !!slug });
}

/** Public so `useModelDownload` can refresh the grid once a poll reaches a terminal state. */
export function useInvalidateAiModels() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: aiModelKeys.root });
}
export function useCreateModel() {
  const invalidate = useInvalidateAiModels();
  return useMutation({ mutationFn: (body: CreateModelRequest) => createModel(body), onSuccess: invalidate });
}

export function useUpdateModel() {
  const invalidate = useInvalidateAiModels();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateModelRequest; etag: string }) => updateModel(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteModel() {
  const invalidate = useInvalidateAiModels();
  return useMutation({ mutationFn: (id: string) => deleteModel(id), onSuccess: invalidate });
}

/** Platform-default election; invalidates the root so the previous holder's row refreshes too. */
export function useSetModelPlatformDefault() {
  const invalidate = useInvalidateAiModels();
  return useMutation({
    mutationFn: ({ id, tasks }: { id: string; tasks: AiTaskKind[] }) => setModelPlatformDefault(id, tasks),
    onSuccess: invalidate,
  });
}

/**
 * Runs the inventory, caches the report under `aiModelKeys.inventory()` (the
 * "In bucket, not registered" panel reads it) and refreshes the grid so every
 * row's measured `availability` updates in place.
 */
export function useRunModelInventory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => runModelInventory(),
    onSuccess: (report) => {
      queryClient.setQueryData<ModelInventoryReport>(aiModelKeys.inventory(), report);
      void queryClient.invalidateQueries({ queryKey: aiModelKeys.all() });
      void queryClient.invalidateQueries({ queryKey: aiModelKeys.list() });
    },
  });
}

/** The last inventory report of this session, if a run happened (never fetched on its own). */
export function useLastInventoryReport() {
  return useQuery<ModelInventoryReport | null>({
    queryKey: aiModelKeys.inventory(),
    queryFn: () => Promise.resolve(null),
    enabled: false,
    staleTime: Infinity,
  });
}

/**
 * Live merge view. `enabled` gates the probe so it fires only when
 * the drawer is open (the registry grid must never wait on an engine probe);
 * a 30 s `staleTime` keeps re-opens instant while `probedAt` + the Refresh
 * button make staleness explicit rather than silent.
 */
export function useModelDiscovery(provider: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: aiModelKeys.discovery(provider),
    queryFn: () => discoverModels(provider),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// =============================================================================
// Download — FROZEN contract (endpoints may not exist on the gateway yet; a
// sibling lane owns that side. See api/client.ts / api/types.ts.)
// =============================================================================

/**
 * Polls the download job while `enabled`. `refetchInterval` re-reads its own
 * last result every tick, so polling stops itself the moment the state turns
 * terminal (`DOWNLOADED`/`DOWNLOAD_FAILED`) — no manual interval bookkeeping,
 * and no risk of polling past the outcome the caller already toasted.
 */
export function useModelDownloadStatus(id: string, options: { enabled: boolean }) {
  return useQuery({
    queryKey: aiModelKeys.download(id),
    queryFn: () => getModelDownloadState(id),
    enabled: options.enabled && id !== '',
    refetchInterval: (query) => (query.state.data?.status === 'DOWNLOADING' ? 2_000 : false),
  });
}

/**
 * Starts a download. Does NOT invalidate the registry list itself — the
 * caller (`useModelDownload`) invalidates once the poll reaches a terminal
 * state, so the grid's `availability` / `localPath` refresh with the finished
 * row instead of the mid-flight one.
 */
export function useStartModelDownload() {
  return useMutation({ mutationFn: (id: string) => startModelDownload(id) });
}

export function useModelRegistryConnectionStatus() {
  return useQuery({ queryKey: aiModelKeys.modelRegistryConnection(), queryFn: getModelRegistryConnectionStatus });
}
