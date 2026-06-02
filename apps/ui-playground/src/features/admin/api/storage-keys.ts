import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

/**
 * Storage access-key admin API (TASK-328 A7).
 *
 * Backs the access-keys section of the Storage admin page. Server controller:
 * `storage-access-key.controller.ts` (`@Controller('admin/tenants/storage/keys')`,
 * class-level `@CanManage('Tenant')`).
 *
 * SECURITY: `list` never returns the secret — only the public `accessKeyId`.
 * `create` returns `secretAccessKey` exactly once; surface it to the user
 * immediately and never persist it.
 */

export interface StorageAccessKey {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  accessKeyId: string;
  permissions: string[];
  bucketIds: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

/** Returned by `create` only — carries the one-time plaintext secret. */
export interface StorageAccessKeyWithSecret extends StorageAccessKey {
  secretAccessKey: string;
}

export interface CreateStorageAccessKeyInput {
  name: string;
  description?: string;
  permissions?: string[];
  bucketIds?: string[];
  expiresAt?: string;
}

const keys = {
  all: ['admin', 'storage-keys'] as const,
  list: (tenantId: string) => [...keys.all, tenantId] as const,
};

export function useStorageAccessKeys(tenantId: string, options?: Omit<UseQueryOptions<StorageAccessKey[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(tenantId),
    queryFn: () => adminClient.get<StorageAccessKey[]>('/admin/tenants/storage/keys', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useCreateStorageAccessKey(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStorageAccessKeyInput) =>
      adminClient.post<StorageAccessKeyWithSecret>('/admin/tenants/storage/keys', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.list(tenantId) });
    },
  });
}

export function useRevokeStorageAccessKey(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<StorageAccessKey>(`/admin/tenants/storage/keys/${id}`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.list(tenantId) });
    },
  });
}

export { keys as storageKeyKeys };
