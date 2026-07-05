/**
 * @arcaai/vox - useTenantStorageConfig Hook (TASK-323 Phase 0 / TASK-318 R9)
 *
 * Per-tenant / per-bucket storage provider configuration (backend + topology)
 * for TENANT_ADMIN / GLOBAL_ADMIN. The server gates
 * `/admin/tenants/storage/config` with `@CanManage('Tenant')`, so a plain
 * DOCTOR is denied (403) — surfaced as a clean `AgenticError`.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { TENANT_STORAGE_CONFIG_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendFilters } from '../utils/urlUtils';

/**
 * Tenant storage config. Minimal local shape with an index signature so server
 * fields the SDK does not yet model pass through untouched.
 */
export interface TenantStorageConfig {
  id: string;
  bucketId?: string | null;
  backend?: string;
  topology?: string;
  [key: string]: unknown;
}

export interface ListTenantStorageConfigParams {
  /** Include soft-deleted/disabled configs. */
  includeDisabled?: boolean;
}

export interface UpsertTenantStorageConfigInput {
  /** Bucket id; omit for the tenant default config. */
  bucketId?: string;
  [key: string]: unknown;
}

export interface UseTenantStorageConfigReturn {
  configs: TenantStorageConfig[];
  isLoading: boolean;
  error: Error | null;
  list: (params?: ListTenantStorageConfigParams) => Promise<TenantStorageConfig[]>;
  effective: (bucketId?: string) => Promise<TenantStorageConfig | null>;
  upsert: (input: UpsertTenantStorageConfigInput) => Promise<TenantStorageConfig>;
  remove: (id: string) => Promise<TenantStorageConfig>;
}

export function useTenantStorageConfig(): UseTenantStorageConfigReturn {
  const { execute, isLoading, error } = useApiOperation('useTenantStorageConfig');

  const [configs, setConfigs] = useState<TenantStorageConfig[]>([]);

  const list = useCallback(
    (params?: ListTenantStorageConfigParams) =>
      execute<TenantStorageConfig[]>('list', async (client) => {
        // The controller checks `includeDisabled === 'true'`, so only send the
        // flag when explicitly enabled.
        const url = appendFilters(TENANT_STORAGE_CONFIG_ENDPOINTS.LIST, {
          includeDisabled: params?.includeDisabled ? 'true' : undefined,
        });
        const raw = await client.get(url);
        const result = extractArray<TenantStorageConfig>(raw);
        setConfigs(result);
        return result;
      }),
    [execute],
  );

  const effective = useCallback(
    (bucketId?: string) =>
      execute<TenantStorageConfig | null>('effective', (client) =>
        client.get<TenantStorageConfig | null>(appendFilters(TENANT_STORAGE_CONFIG_ENDPOINTS.EFFECTIVE, { bucketId })),
      ),
    [execute],
  );

  const upsert = useCallback(
    (input: UpsertTenantStorageConfigInput) =>
      execute<TenantStorageConfig>('upsert', (client) => client.put<TenantStorageConfig>(TENANT_STORAGE_CONFIG_ENDPOINTS.UPSERT, input)),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<TenantStorageConfig>('remove', async (client) => {
        const data = await client.delete<TenantStorageConfig>(TENANT_STORAGE_CONFIG_ENDPOINTS.DELETE(id));
        setConfigs((prev) => prev.filter((c) => c.id !== id));
        return data;
      }),
    [execute],
  );

  return { configs, isLoading, error, list, effective, upsert, remove };
}
