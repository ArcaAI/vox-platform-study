'use client';

/**
 * TanStack Query v5 hooks for tenant administration. Mutations invalidate the
 * whole ['tenants'] namespace — an admin console prefers fresh reads over
 * cache cleverness (rule 13).
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import {
  archiveTenant,
  createTenant,
  deleteTenant,
  getFrontendConfig,
  getTenant,
  getTenantStorageBreakdown,
  getTenantTags,
  getTenantUsage,
  listTenantConfigs,
  listTenants,
  provisionTenant,
  restoreTenant,
  setTenantTags,
  suspendTenant,
  updateFrontendConfig,
  updateTenant,
  updateTenantConfigs,
} from './client';
import { tenantKeys } from './keys';
import type {
  CreateTenantRequest,
  ProvisionTenantRequest,
  UpdateTenantConfigItem,
  UpdateTenantRequest,
  UpsertTenantFrontendConfigRequest,
} from './types';

export function useTenants(params?: ListParams) {
  return useQuery({ queryKey: tenantKeys.list(params), queryFn: () => listTenants(params), placeholderData: keepPreviousData });
}

/** Detail read: `data.data` is the tenant, `data.etag` feeds the update. */
export function useTenant(id: string) {
  return useQuery({ queryKey: tenantKeys.detail(id), queryFn: () => getTenant(id), enabled: !!id });
}

export function useTenantUsage(id: string) {
  return useQuery({ queryKey: tenantKeys.usage(id), queryFn: () => getTenantUsage(id), enabled: !!id });
}

/**
 * TASK-959 — the nightly snapshot's per-class storage split, beside the live
 * `Media.size` figure `useTenantUsage` already carries. A separate, silently
 * degrading read: a caller without `manage:UsageAnalytics` (or any other
 * failure) leaves the breakdown row absent rather than blocking the primary
 * usage tiles this tab exists to show.
 */
export function useTenantStorageBreakdown(id: string) {
  return useQuery({
    queryKey: tenantKeys.storageBreakdown(id),
    queryFn: () => getTenantStorageBreakdown(id),
    enabled: !!id,
    retry: false,
  });
}

export function useTenantTags(id: string) {
  return useQuery({ queryKey: tenantKeys.tags(id), queryFn: () => getTenantTags(id), enabled: !!id });
}

export function useTenantConfigs(identifier: string, params?: ListParams) {
  return useQuery({
    queryKey: tenantKeys.configs(identifier, params),
    queryFn: () => listTenantConfigs(identifier, params),
    enabled: !!identifier,
    placeholderData: keepPreviousData,
  });
}

export function useFrontendConfig(tenantId?: string) {
  return useQuery({ queryKey: tenantKeys.frontendConfig(tenantId), queryFn: () => getFrontendConfig(tenantId) });
}

function useInvalidateTenants() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: tenantKeys.root });
}

export function useCreateTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({ mutationFn: (body: CreateTenantRequest) => createTenant(body), onSuccess: invalidate });
}

/** Global-admin create-tenant-with-admin. */
export function useProvisionTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({ mutationFn: (body: ProvisionTenantRequest) => provisionTenant(body), onSuccess: invalidate });
}

export function useUpdateTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateTenantRequest; etag: string }) => updateTenant(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({ mutationFn: (id: string) => deleteTenant(id), onSuccess: invalidate });
}

export function useSuspendTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({ mutationFn: (id: string) => suspendTenant(id), onSuccess: invalidate });
}

export function useArchiveTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({ mutationFn: (id: string) => archiveTenant(id), onSuccess: invalidate });
}

export function useRestoreTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({ mutationFn: (id: string) => restoreTenant(id), onSuccess: invalidate });
}

/** OCC write: `etag` is the tenant DETAIL ETag (`useTenant`), which the tag route CASes against. */
export function useSetTenantTags() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: ({ id, tags, etag }: { id: string; tags: string[]; etag: string }) => setTenantTags(id, tags, etag),
    onSuccess: invalidate,
  });
}

export function useUpdateTenantConfigs() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: ({ identifier, updates }: { identifier: string; updates: UpdateTenantConfigItem[] }) => updateTenantConfigs(identifier, updates),
    onSuccess: invalidate,
  });
}

export function useUpdateFrontendConfig() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: ({ body, etag, tenantId }: { body: UpsertTenantFrontendConfigRequest; etag?: string; tenantId?: string }) =>
      updateFrontendConfig(body, etag, tenantId),
    onSuccess: invalidate,
  });
}
