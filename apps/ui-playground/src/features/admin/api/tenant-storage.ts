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
  bucketName: string;
  file: File | Blob;
  fileName: string;
  path?: string;
}

const keys = {
  all: ['admin', 'tenant-storage'] as const,
  buckets: (tenantId: string) => [...keys.all, 'buckets', tenantId] as const,
  tree: (tenantId: string, bucketId: string, prefix: string) => [...keys.all, 'tree', tenantId, bucketId, prefix] as const,
  objects: (tenantId: string, bucketName: string, prefix: string) => [...keys.all, 'objects', tenantId, bucketName, prefix] as const,
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
  bucketName: string,
  prefix?: string,
  options?: Omit<UseQueryOptions<TenantBucketObject[]>, 'queryKey' | 'queryFn'>,
) {
  const normalizedPrefix = normalizePrefix(prefix);
  const query = normalizedPrefix ? `?prefix=${encodeURIComponent(normalizedPrefix)}` : '';

  return useQuery({
    queryKey: keys.objects(tenantId, bucketName, normalizedPrefix),
    queryFn: () => adminClient.get<TenantBucketObject[]>(`/storage/buckets/${bucketName}/files${query}`, { tenantId }),
    enabled: !!tenantId && !!bucketName,
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

export function useUploadTenantObject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, bucketName, file, fileName, path }: UploadTenantObjectInput) => {
      const key = joinObjectPath(path, fileName);
      const formData = new FormData();
      formData.append('file', file, fileName);
      return adminClient.upload<TenantBucketObject>(`/storage/buckets/${bucketName}/files?key=${encodeURIComponent(key)}`, formData, { tenantId });
    },
    onSuccess: (_data, variables) => {
      const normalizedPrefix = normalizePrefix(variables.path);
      qc.invalidateQueries({
        queryKey: keys.objects(variables.tenantId, variables.bucketName, normalizedPrefix),
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
    mutationFn: ({ tenantId, bucketName, folderName, path }: { tenantId: string; bucketName: string; folderName: string; path?: string }) => {
      const normalizedFolder = folderName.trim().replace(/\/+/g, '/');
      if (!normalizedFolder) {
        throw new Error('Folder name is required');
      }
      const folderMarker = new Blob([''], {
        type: 'application/octet-stream',
      });
      return uploader.mutateAsync({
        tenantId,
        bucketName,
        file: folderMarker,
        fileName: '.folder',
        path: joinObjectPath(path, normalizedFolder),
      });
    },
  });
}

export function useDeleteTenantObject() {
  const qc = useQueryClient();
  return useMutation({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mutationFn: ({ tenantId, bucketName, fileKey, path }: { tenantId: string; bucketName: string; fileKey: string; path?: string }) =>
      adminClient.delete(`/storage/buckets/${bucketName}/files/${encodeURIComponent(fileKey)}`, { tenantId }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: keys.objects(variables.tenantId, variables.bucketName, normalizePrefix(variables.path)),
      });
    },
  });
}

export { keys as tenantStorageKeys };
