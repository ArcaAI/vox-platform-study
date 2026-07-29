'use client';

/**
 * TanStack Query v5 hooks for the identity-providers surface. Mutations
 * invalidate the whole ['identity-providers'] namespace — an admin console
 * prefers fresh reads over cache cleverness (rule 13).
 *
 * `useSyncDirectory` deliberately does NOT poll for job progress: the
 * gateway's job-status endpoint (`GET /admin/queues/:queue/jobs/:jobId`) is
 * platform-admin-only today (a documented gap, out of scope to
 * widen here), so a tenant admin who triggers a sync cannot poll it anyway —
 * the UI shows a single "sync started" toast instead of a live progress bar.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProvider,
  deleteProvider,
  getProvider,
  listDepartments,
  listProviders,
  listRoles,
  setDirectoryCredentials,
  syncDirectory,
  testConnection,
  updateProvider,
} from './client';
import { identityProviderKeys } from './keys';
import type { CreateTenantIdpConfigRequest, DirectoryCredentials, UpdateTenantIdpConfigRequest } from './types';

export function useIdentityProviders() {
  return useQuery({ queryKey: identityProviderKeys.list(), queryFn: listProviders });
}

/** Detail read: `data.data` is the provider row, `data.etag` feeds the update/test-connection PUT/POST. */
export function useIdentityProvider(id: string) {
  return useQuery({ queryKey: identityProviderKeys.detail(id), queryFn: () => getProvider(id), enabled: !!id });
}

export function useDepartments() {
  return useQuery({ queryKey: identityProviderKeys.departments(), queryFn: listDepartments });
}

export function useRoles() {
  return useQuery({ queryKey: identityProviderKeys.roles(), queryFn: listRoles });
}

function useInvalidateIdentityProviders() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: identityProviderKeys.root });
}

export function useCreateIdentityProvider() {
  const invalidate = useInvalidateIdentityProviders();
  return useMutation({ mutationFn: (body: CreateTenantIdpConfigRequest) => createProvider(body), onSuccess: invalidate });
}

export function useUpdateIdentityProvider() {
  const invalidate = useInvalidateIdentityProviders();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: Omit<UpdateTenantIdpConfigRequest, 'expectedVersion'>; etag: string }) =>
      updateProvider(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteIdentityProvider() {
  const invalidate = useInvalidateIdentityProviders();
  return useMutation({ mutationFn: (id: string) => deleteProvider(id), onSuccess: invalidate });
}

/** Flips DRAFT -> ENABLED server-side on success — invalidate so the row reflects the new status. */
export function useTestConnection() {
  const invalidate = useInvalidateIdentityProviders();
  return useMutation({ mutationFn: (id: string) => testConnection(id), onSuccess: invalidate });
}

/** Fire-and-forget trigger; see module doc for why this doesn't poll. */
export function useSyncDirectory() {
  return useMutation({ mutationFn: (id: string) => syncDirectory(id) });
}

/** Write-only secret rotation — invalidate so the row's hasSecret-style state (directory config) reflects the change. */
export function useSetDirectoryCredentials() {
  const invalidate = useInvalidateIdentityProviders();
  return useMutation({
    mutationFn: ({ id, credentials }: { id: string; credentials: DirectoryCredentials }) => setDirectoryCredentials(id, credentials),
    onSuccess: invalidate,
  });
}
