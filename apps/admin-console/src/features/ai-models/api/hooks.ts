'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import {
  createModel,
  deleteModel,
  discoverModels,
  downloadMissingModels,
  getModel,
  getModelBySlug,
  getLastModelInventory,
  getModelDownloadState,
  getModelRegistryConnectionStatus,
  getModelUsage,
  listModels,
  listModelsPaginated,
  previewHubRepo,
  registerFromHub,
  runModelInventory,
  setModelPlatformDefault,
  startModelDownload,
  unregisterModel,
  updateModel,
} from './client';
import { aiModelKeys } from './keys';
import { editLockReason, isTransientLifecycle, LIFECYCLE_POLL_MS, listRefetchInterval } from './lifecycle';
import type { AiTaskKind, CreateModelRequest, ModelInventoryReport, RegisterFromHubRequest, UnregisterModelRequest, UpdateModelRequest } from './types';

export function useModels() {
  return useQuery({ queryKey: aiModelKeys.all(), queryFn: listModels });
}

/**
 * The registry list. Re-reads every 5 s WHILE any row is DOWNLOADING /
 * UNREGISTERING / LOADING (TASK-1019 OD-5) and not at all otherwise — the
 * interval reads the query's own last page, so polling stops itself the moment
 * every row is settled.
 */
export function useModelsPaginated(params?: ListParams) {
  return useQuery({
    queryKey: aiModelKeys.list(params),
    queryFn: () => listModelsPaginated(params),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => listRefetchInterval(query.state.data),
  });
}

/**
 * Live lifecycle of ONE model for the drawer's Status section. A query of its
 * own (not `useModel`) on purpose: `useModel` carries the ETag the edit form
 * PATCHes with, and a background refetch must never silently advance the
 * version under an admin's unsaved edits.
 */
export function useModelLifecycle(id: string) {
  return useQuery({
    queryKey: aiModelKeys.lifecycle(id),
    queryFn: async () => (await getModel(id)).data?.lifecycle ?? null,
    enabled: !!id,
    refetchInterval: (query) => (isTransientLifecycle(query.state.data?.status) ? LIFECYCLE_POLL_MS : false),
  });
}

/**
 * One row + the ETag the edit form PATCHes with. It re-reads every 5 s ONLY
 * while the row is DOWNLOADING / UNREGISTERING — the form is read-only then
 * (`editLockReason`, final review I11), so advancing the ETag can never land
 * under unsaved edits — and stops itself the moment the row settles, leaving
 * the form the settled row and its current ETag.
 */
export function useModel(id: string) {
  return useQuery({
    queryKey: aiModelKeys.detail(id),
    queryFn: () => getModel(id),
    enabled: !!id,
    refetchInterval: (query) => (editLockReason(query.state.data?.data?.lifecycle?.status) ? LIFECYCLE_POLL_MS : false),
  });
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

/**
 * The last inventory report — fetched on mount (TASK-890 J1 MINOR-7).
 *
 * It used to be a session-only cache slot (`enabled: false`, resolving `null`),
 * so "In bucket, not registered" was disabled on every fresh load and the only
 * way to populate it was to re-run a full bucket sweep — one listing plus a
 * manifest read per published row — for a list the platform already had. The
 * gateway now stores the report, so this reads it.
 *
 * `staleTime: Infinity` because the report only changes when a run happens, and
 * `useRunModelInventory` writes the new one into this exact cache key.
 */
export function useLastInventoryReport() {
  return useQuery<ModelInventoryReport | null>({
    queryKey: aiModelKeys.inventory(),
    queryFn: () => getLastModelInventory(),
    staleTime: Infinity,
    retry: false,
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
  const invalidate = useInvalidateAiModels();
  // Refresh the model reads so an open drawer sees DOWNLOADING and locks its edit form.
  return useMutation({ mutationFn: (id: string) => startModelDownload(id), onSuccess: invalidate });
}

export function useModelRegistryConnectionStatus() {
  return useQuery({ queryKey: aiModelKeys.modelRegistryConnection(), queryFn: getModelRegistryConnectionStatus });
}


// =============================================================================
// TASK-1019 — register from Hugging Face, unregister, download-missing
// =============================================================================

/** Repo ids look like `org/name` — anything else never reaches the Hub. */
export const HF_REPO_ID_PATTERN = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

/**
 * Hub card for a repo id. `enabled` is the caller's debounced + validated gate;
 * a 404 / 422 is a real answer the form renders, so no retry.
 */
export function useHubPreview(repoId: string, revision: string, enabled: boolean) {
  return useQuery({
    queryKey: aiModelKeys.hubPreview(repoId, revision),
    queryFn: () => previewHubRepo(repoId, revision || undefined),
    enabled: enabled && HF_REPO_ID_PATTERN.test(repoId),
    retry: false,
    staleTime: 60_000,
  });
}

/** Creates the row + enqueues the download; the list refetches and shows DOWNLOADING. */
export function useRegisterFromHub() {
  const invalidate = useInvalidateAiModels();
  return useMutation({ mutationFn: (body: RegisterFromHubRequest) => registerFromHub(body), onSuccess: invalidate });
}

/** Referrers of a model — `enabled` gates it to the open dialog. */
export function useModelUsage(id: string, enabled: boolean) {
  return useQuery({
    queryKey: aiModelKeys.usage(id),
    queryFn: () => getModelUsage(id),
    enabled: enabled && id !== '',
    retry: false,
    // A referrer can appear between two opens; never trust a cached "no referrers".
    staleTime: 0,
    gcTime: 0,
  });
}

export function useUnregisterModel() {
  const invalidate = useInvalidateAiModels();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & UnregisterModelRequest) => unregisterModel(id, body),
    onSuccess: invalidate,
  });
}

export function useDownloadMissingModels() {
  const invalidate = useInvalidateAiModels();
  return useMutation({ mutationFn: () => downloadMissingModels(), onSuccess: invalidate });
}
