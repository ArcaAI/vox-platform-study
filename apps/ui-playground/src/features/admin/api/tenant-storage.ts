import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

export interface TenantBucket {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description?: string;
  bucketType: 'SYSTEM' | 'CUSTOM';
  pathPattern: string;
  isSystemBucket: boolean;
  createdAt: string;
  updatedAt: string;
  resourceStatus?: string;
}

export interface TenantBucketTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  path: string;
  size?: number;
  lastModified?: string;
  children?: TenantBucketTreeNode[];
}

export interface TenantBucketTreeResponse {
  bucketId: string;
  bucketName: string;
  rootPath: string;
  nodes: TenantBucketTreeNode[];
}

export interface TenantBucketObject {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
  [key: string]: unknown;
}

export interface CreateTenantBucketInput {
  slug: string;
  description?: string;
  pathPattern?: string;
}

export interface UploadTenantObjectInput {
  tenantId: string;
  bucketId: string;
  file: File | Blob;
  fileName: string;
  path?: string;
}

const keys = {
  all: ['admin', 'tenant-storage'] as const,
  buckets: (tenantId: string) => [...keys.all, 'buckets', tenantId] as const,
  tree: (tenantId: string, bucketId: string, prefix: string) => [...keys.all, 'tree', tenantId, bucketId, prefix] as const,
  objects: (tenantId: string, bucketId: string, prefix: string) => [...keys.all, 'objects', tenantId, bucketId, prefix] as const,
};

function normalizePrefix(prefix?: string): string {
  const raw = (prefix ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const normalized = raw.replace(/^\/+/, '');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function joinObjectPath(prefix: string | undefined, fileName: string): string {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedName = fileName.replace(/^\/+/, '');
  return `${normalizedPrefix}${normalizedName}`;
}

export function useTenantBuckets(tenantId: string, options?: Omit<UseQueryOptions<TenantBucket[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.buckets(tenantId),
    queryFn: () => adminClient.get<TenantBucket[]>('/admin/tenants/storage/buckets', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useTenantBucketTree(
  tenantId: string,
  bucketId: string,
  prefix?: string,
  options?: Omit<UseQueryOptions<TenantBucketTreeResponse>, 'queryKey' | 'queryFn'>,
) {
  const normalizedPrefix = normalizePrefix(prefix);
  const query = normalizedPrefix ? `?prefix=${encodeURIComponent(normalizedPrefix)}` : '';

  return useQuery({
    queryKey: keys.tree(tenantId, bucketId, normalizedPrefix),
    queryFn: () => adminClient.get<TenantBucketTreeResponse>(`/admin/tenants/storage/buckets/${bucketId}/tree${query}`, { tenantId }),
    enabled: !!tenantId && !!bucketId,
    ...options,
  });
}

export function useTenantBucketObjects(
  tenantId: string,
  bucketId: string,
  prefix?: string,
  options?: Omit<UseQueryOptions<TenantBucketObject[]>, 'queryKey' | 'queryFn'>,
) {
  const normalizedPrefix = normalizePrefix(prefix);
  const query = normalizedPrefix ? `?prefix=${encodeURIComponent(normalizedPrefix)}` : '';

  return useQuery({
    queryKey: keys.objects(tenantId, bucketId, normalizedPrefix),
    queryFn: () => adminClient.get<TenantBucketObject[]>(`/admin/tenants/storage/buckets/${bucketId}/objects${query}`, { tenantId }),
    enabled: !!tenantId && !!bucketId,
    ...options,
  });
}

export function useCreateTenantBucket(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantBucketInput) => adminClient.post<TenantBucket>('/admin/tenants/storage/buckets', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.buckets(tenantId) });
    },
  });
}

export function useDeleteTenantBucket(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bucketId: string) => adminClient.delete<TenantBucket>(`/admin/tenants/storage/buckets/${bucketId}`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.buckets(tenantId) });
    },
  });
}

/**
 * Delete a single object from a tenant bucket via the broadcasting admin
 * endpoint (`DELETE /admin/tenants/storage/buckets/:id/objects?key=`, TASK-328
 * A7). The server removes the object from the storage provider and emits a
 * `ResourceDeleted` SysEvent. `bucketName`/`path` are carried only to scope the
 * react-query invalidation back to the object list the user is viewing.
 */
export function useDeleteTenantBucketObject(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bucketId, fileKey }: { bucketId: string; bucketName: string; fileKey: string; path?: string }) =>
      adminClient.delete<{ key: string; deleted: boolean }>(`/admin/tenants/storage/buckets/${bucketId}/objects?key=${encodeURIComponent(fileKey)}`, {
        tenantId,
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: keys.objects(tenantId, variables.bucketId, normalizePrefix(variables.path)),
      });
      qc.invalidateQueries({ queryKey: [...keys.all, 'tree', tenantId] });
    },
  });
}

/**
 * Fetch a presigned download URL for an object on demand (TASK-328 A7). Modeled
 * as a mutation because it is triggered by an explicit user action ("Copy
 * link") rather than auto-fetched. The server default expiry is 1 hour.
 */
export function useTenantBucketPresignedUrl(tenantId: string) {
  return useMutation({
    mutationFn: ({ bucketId, fileKey }: { bucketId: string; fileKey: string }) =>
      adminClient.get<{ url: string }>(`/admin/tenants/storage/buckets/${bucketId}/presigned-url?key=${encodeURIComponent(fileKey)}`, { tenantId }),
  });
}

export interface TenantBucketDefaults {
  audio: TenantBucket | null;
  attachments: TenantBucket | null;
  misc: TenantBucket | null;
}

export interface SetTenantBucketDefaultsInput {
  audioBucketId?: string;
  attachmentsBucketId?: string;
  miscBucketId?: string;
}

export function useTenantBucketDefaults(tenantId: string, options?: Omit<UseQueryOptions<TenantBucketDefaults>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: [...keys.all, 'defaults', tenantId] as const,
    queryFn: () => adminClient.get<TenantBucketDefaults>('/admin/tenants/storage/buckets/defaults', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useSetTenantBucketDefaults(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetTenantBucketDefaultsInput) =>
      adminClient.put<TenantBucketDefaults>('/admin/tenants/storage/buckets/defaults', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...keys.all, 'defaults', tenantId] });
    },
  });
}

/**
 * Upload a single object through the broadcasting admin endpoint
 * (`POST /admin/tenants/storage/buckets/:id/objects?key=`, TASK-331 doc-03 F7).
 * The server writes the object to the storage provider and emits a
 * `ResourceCreated` SysEvent.
 */
export function useUploadTenantObject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, bucketId, file, fileName, path }: UploadTenantObjectInput) => {
      const key = joinObjectPath(path, fileName);
      const formData = new FormData();
      formData.append('file', file, fileName);
      return adminClient.upload<TenantBucketObject>(`/admin/tenants/storage/buckets/${bucketId}/objects?key=${encodeURIComponent(key)}`, formData, {
        tenantId,
      });
    },
    onSuccess: (_data, variables) => {
      const normalizedPrefix = normalizePrefix(variables.path);
      qc.invalidateQueries({
        queryKey: keys.objects(variables.tenantId, variables.bucketId, normalizedPrefix),
      });
      qc.invalidateQueries({
        queryKey: [...keys.all, 'tree', variables.tenantId],
      });
    },
  });
}

export function useCreateTenantFolder() {
  const uploader = useUploadTenantObject();
  return useMutation({
    mutationFn: ({ tenantId, bucketId, folderName, path }: { tenantId: string; bucketId: string; folderName: string; path?: string }) => {
      const normalizedFolder = folderName.trim().replace(/\/+/g, '/');
      if (!normalizedFolder) {
        throw new Error('Folder name is required');
      }
      const folderMarker = new Blob([''], {
        type: 'application/octet-stream',
      });
      return uploader.mutateAsync({
        tenantId,
        bucketId,
        file: folderMarker,
        fileName: '.folder',
        path: joinObjectPath(path, normalizedFolder),
      });
    },
  });
}

export { keys as tenantStorageKeys };
