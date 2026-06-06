import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

/**
 * Tenant storage provider-config admin API (TASK-328 A7).
 *
 * Backs the provider-config section of the Storage admin page. Server
 * controller: `tenant-storage-config-admin.controller.ts`
 * (`@Controller('admin/tenants/storage/config')`, class-level
 * `@CanManage('Tenant')`). `upsert` is a PUT to the same path as `list`.
 *
 * NOTE: `credentialsRef` is only a SecretsService *key name*, never the secret
 * value — the raw credentials never leave the secrets manager.
 */

export type StorageProvider = 'MINIO' | 'AWS_S3' | 'AZURE_BLOB';
export type StorageTopology = 'SHARED' | 'DEDICATED';

export interface TenantStorageConfig {
  id: string;
  tenantId: string;
  bucketId?: string | null;
  provider: StorageProvider;
  topology: StorageTopology;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
  accountName?: string | null;
  endpointSuffix?: string | null;
  containerPrefix?: string | null;
  credentialsRef?: string | null;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTenantStorageConfigInput {
  bucketId?: string | null;
  provider: StorageProvider;
  topology?: StorageTopology;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
  accountName?: string | null;
  endpointSuffix?: string | null;
  containerPrefix?: string | null;
  credentialsRef?: string | null;
}

const keys = {
  all: ['admin', 'storage-config'] as const,
  list: (tenantId: string) => [...keys.all, tenantId] as const,
};

export function useTenantStorageConfigs(tenantId: string, options?: Omit<UseQueryOptions<TenantStorageConfig[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(tenantId),
    queryFn: () => adminClient.get<TenantStorageConfig[]>('/admin/tenants/storage/config', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useUpsertTenantStorageConfig(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertTenantStorageConfigInput) => adminClient.put<TenantStorageConfig>('/admin/tenants/storage/config', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.list(tenantId) });
    },
  });
}

export { keys as storageConfigKeys };
