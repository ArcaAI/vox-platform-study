import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Bucket {
  name: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface BucketFile {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: string;
  [key: string]: unknown;
}

export interface CreateBucketInput {
  name: string;
  [key: string]: unknown;
}

export interface UploadFileInput {
  bucketName: string;
  file: File;
  path?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const keys = {
  all: ['storage'] as const,
  buckets: () => [...keys.all, 'buckets'] as const,
  files: (bucketName: string, path?: string) => [...keys.all, 'files', bucketName, path] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useBuckets(options?: Omit<UseQueryOptions<Bucket[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.buckets(),
    queryFn: () => adminClient.get<Bucket[]>('/storage/buckets'),
    ...options,
  });
}

export function useBucketFiles(bucketName: string, path?: string, options?: Omit<UseQueryOptions<BucketFile[]>, 'queryKey' | 'queryFn'>) {
  const query = path ? `?prefix=${encodeURIComponent(path)}` : '';
  return useQuery({
    queryKey: keys.files(bucketName, path),
    queryFn: () => adminClient.get<BucketFile[]>(`/storage/buckets/${bucketName}/files${query}`),
    enabled: !!bucketName,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateBucket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBucketInput) => adminClient.post<Bucket>('/storage/buckets', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.buckets() });
    },
  });
}

export function useDeleteBucket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => adminClient.delete<void>(`/storage/buckets/${name}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.buckets() });
    },
  });
}

export function useUploadFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bucketName, file, path }: UploadFileInput) => {
      const formData = new FormData();
      formData.append('file', file);
      if (path) formData.append('path', path);
      return adminClient.upload<BucketFile>(`/storage/buckets/${bucketName}/files`, formData);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: keys.files(variables.bucketName),
      });
    },
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bucketName, fileKey }: { bucketName: string; fileKey: string }) =>
      adminClient.delete<void>(`/storage/buckets/${bucketName}/files/${fileKey}`),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: keys.files(variables.bucketName),
      });
    },
  });
}

export { keys as storageKeys };
