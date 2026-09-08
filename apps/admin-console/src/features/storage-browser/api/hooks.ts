'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createBucket,
  deleteBucket,
  deleteFile,
  getFileInfo,
  getStorageHealth,
  listBuckets,
  listBucketsAllTenants,
  listObjects,
  updateBucket,
  uploadFile,
} from './client';
import { storageBrowserKeys } from './keys';
import type { CreateBucketRequest, UpdateBucketRequest } from './types';

export function useBuckets() {
  return useQuery({ queryKey: storageBrowserKeys.buckets(), queryFn: listBuckets });
}

/** "All tenants" listing (TASK-932 Lane T) — only fired while `enabled`. */
export function useBucketsAllTenants(enabled: boolean) {
  return useQuery({ queryKey: storageBrowserKeys.bucketsAllTenants(), queryFn: listBucketsAllTenants, enabled });
}

export function useObjects(bucketName: string, prefix?: string) {
  return useQuery({
    queryKey: storageBrowserKeys.objects(bucketName, prefix),
    queryFn: () => listObjects(bucketName, prefix),
    enabled: !!bucketName,
  });
}

export function useStorageHealth() {
  return useQuery({ queryKey: storageBrowserKeys.health(), queryFn: getStorageHealth });
}

function useInvalidateStorageBrowser() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: storageBrowserKeys.root });
}

export function useCreateBucket() {
  const invalidate = useInvalidateStorageBrowser();
  return useMutation({ mutationFn: (body: CreateBucketRequest) => createBucket(body), onSuccess: invalidate });
}

export function useUpdateBucket() {
  const invalidate = useInvalidateStorageBrowser();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: UpdateBucketRequest }) => updateBucket(name, body),
    onSuccess: invalidate,
  });
}

export function useDeleteBucket() {
  const invalidate = useInvalidateStorageBrowser();
  return useMutation({ mutationFn: (name: string) => deleteBucket(name), onSuccess: invalidate });
}

export function useUploadFile() {
  const invalidate = useInvalidateStorageBrowser();
  return useMutation({
    mutationFn: ({ bucketName, file, key }: { bucketName: string; file: File; key?: string }) => uploadFile(bucketName, file, key),
    onSuccess: invalidate,
  });
}

export function useDeleteFile() {
  const invalidate = useInvalidateStorageBrowser();
  return useMutation({
    mutationFn: ({ bucketName, key }: { bucketName: string; key: string }) => deleteFile(bucketName, key),
    onSuccess: invalidate,
  });
}

/** Presigned URLs are one-shot, short-lived reads — fetch on demand, never cache. */
export function usePresignedDownload() {
  return useMutation({ mutationFn: ({ bucketName, key }: { bucketName: string; key: string }) => getFileInfo(bucketName, key) });
}
