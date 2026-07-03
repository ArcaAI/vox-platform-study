/**
 * @arcaai/vox - useTenantBuckets Hook (TASK-323 Phase 0 / TASK-318 R9)
 *
 * Per-tenant storage bucket management for TENANT_ADMIN / SUPER_ADMIN. The
 * server gates `/admin/tenants/storage/buckets` with `@CanManage('Tenant')`,
 * so a plain DOCTOR is denied (403) — surfaced as a clean `AgenticError`.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { TENANT_BUCKET_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendFilters } from '../utils/urlUtils';

/**
 * Tenant storage bucket. Minimal local shape with an index signature so server
 * fields the SDK does not yet model pass through untouched.
 */
export interface TenantBucket {
  id: string;
  name?: string;
  purpose?: string;
  isSystem?: boolean;
  [key: string]: unknown;
}

/** Folder/file tree payload for the bucket tree view (opaque server shape). */
export interface TenantBucketTree {
  [key: string]: unknown;
}

/** Default bucket per purpose (audio / attachments / misc). */
export interface TenantBucketDefaults {
  [key: string]: unknown;
}

export interface CreateTenantBucketInput {
  name?: string;
  purpose?: string;
  [key: string]: unknown;
}

export interface SetTenantBucketDefaultsInput {
  [key: string]: unknown;
}

export interface UseTenantBucketsReturn {
  buckets: TenantBucket[];
  isLoading: boolean;
  error: Error | null;
  list: () => Promise<TenantBucket[]>;
  get: (id: string) => Promise<TenantBucket | null>;
  tree: (id: string, prefix?: string) => Promise<TenantBucketTree>;
  /** Read-only object listing for the Stores detail browser (TASK-407); optional key prefix filter. */
  listObjects: (id: string, prefix?: string) => Promise<TenantBucketObject[]>;
  presignedUrl: (id: string, key: string) => Promise<{ url: string }>;
  getDefaults: () => Promise<TenantBucketDefaults>;
  setDefaults: (input: SetTenantBucketDefaultsInput) => Promise<TenantBucketDefaults>;
  create: (input: CreateTenantBucketInput) => Promise<TenantBucket>;
  remove: (id: string) => Promise<TenantBucket>;
  /** Delete a single object from a bucket via the storage provider (TASK-328 A7). */
  deleteObject: (id: string, key: string) => Promise<DeleteTenantBucketObjectResult>;
  provision: (tenantId: string) => Promise<TenantBucket[]>;
}

/** Result of removing a single object via {@link UseTenantBucketsReturn.deleteObject}. */
export interface DeleteTenantBucketObjectResult {
  key: string;
  deleted: boolean;
}

/** One object row from the read-only bucket browser (TASK-407). */
export interface TenantBucketObject {
  key: string;
  size: number;
  lastModified?: string;
  [key: string]: unknown;
}

export function useTenantBuckets(): UseTenantBucketsReturn {
  const { execute, isLoading, error } = useApiOperation('useTenantBuckets');

  const [buckets, setBuckets] = useState<TenantBucket[]>([]);

  const list = useCallback(
    () =>
      execute<TenantBucket[]>('list', async (client) => {
        const raw = await client.get(TENANT_BUCKET_ENDPOINTS.LIST);
        const result = extractArray<TenantBucket>(raw);
        setBuckets(result);
        return result;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) => execute<TenantBucket | null>('get', (client) => client.get<TenantBucket | null>(TENANT_BUCKET_ENDPOINTS.GET(id))),
    [execute],
  );

  const tree = useCallback(
    (id: string, prefix?: string) =>
      execute<TenantBucketTree>('tree', (client) => client.get<TenantBucketTree>(appendFilters(TENANT_BUCKET_ENDPOINTS.TREE(id), { prefix }))),
    [execute],
  );

  const listObjects = useCallback(
    (id: string, prefix?: string) =>
      execute<TenantBucketObject[]>('listObjects', async (client) => {
        const raw = await client.get(appendFilters(TENANT_BUCKET_ENDPOINTS.LIST_OBJECTS(id), { prefix }));
        return extractArray<TenantBucketObject>(raw);
      }),
    [execute],
  );

  const presignedUrl = useCallback(
    (id: string, key: string) =>
      execute<{ url: string }>('presignedUrl', (client) => client.get<{ url: string }>(appendFilters(TENANT_BUCKET_ENDPOINTS.PRESIGNED_URL(id), { key }))),
    [execute],
  );

  const getDefaults = useCallback(
    () => execute<TenantBucketDefaults>('getDefaults', (client) => client.get<TenantBucketDefaults>(TENANT_BUCKET_ENDPOINTS.DEFAULTS)),
    [execute],
  );

  const setDefaults = useCallback(
    (input: SetTenantBucketDefaultsInput) =>
      execute<TenantBucketDefaults>('setDefaults', (client) => client.put<TenantBucketDefaults>(TENANT_BUCKET_ENDPOINTS.DEFAULTS, input)),
    [execute],
  );

  const create = useCallback(
    (input: CreateTenantBucketInput) =>
      execute<TenantBucket>('create', async (client) => {
        const data = await client.post<TenantBucket>(TENANT_BUCKET_ENDPOINTS.CREATE, input);
        setBuckets((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<TenantBucket>('remove', async (client) => {
        const data = await client.delete<TenantBucket>(TENANT_BUCKET_ENDPOINTS.DELETE(id));
        setBuckets((prev) => prev.filter((b) => b.id !== id));
        return data;
      }),
    [execute],
  );

  const deleteObject = useCallback(
    (id: string, key: string) =>
      execute<DeleteTenantBucketObjectResult>('deleteObject', (client) =>
        client.delete<DeleteTenantBucketObjectResult>(appendFilters(TENANT_BUCKET_ENDPOINTS.DELETE_OBJECT(id), { key })),
      ),
    [execute],
  );

  const provision = useCallback(
    (tenantId: string) =>
      execute<TenantBucket[]>('provision', (client) => client.post<TenantBucket[]>(TENANT_BUCKET_ENDPOINTS.PROVISION(tenantId), {})),
    [execute],
  );

  return { buckets, isLoading, error, list, get, tree, listObjects, presignedUrl, getDefaults, setDefaults, create, remove, deleteObject, provision };
}
