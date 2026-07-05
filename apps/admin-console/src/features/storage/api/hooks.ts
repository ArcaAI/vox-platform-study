'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    createAccessKey,
    createBucket,
    deleteAccessKey,
    deleteBucket,
    deleteObject,
    deleteStorageConfig,
    getBucket,
    getBucketDefaults,
    getBucketTree,
    getEffectiveStorageConfig,
    getPresignedUrl,
    listAccessKeys,
    listBuckets,
    listObjects,
    listStorageConfigs,
    provisionTenantBuckets,
    setBucketDefaults,
    uploadObject,
    upsertStorageConfig,
} from './client';
import { storageKeys } from './keys';
import type { CreateAccessKeyRequest, CreateBucketRequest, SetBucketDefaultsRequest, UpsertStorageConfigRequest } from './types';

export function useBuckets() {
    return useQuery({ queryKey: storageKeys.buckets(), queryFn: listBuckets });
}

export function useBucket(id: string) {
    return useQuery({ queryKey: storageKeys.bucket(id), queryFn: () => getBucket(id), enabled: !!id });
}

export function useBucketDefaults() {
    return useQuery({ queryKey: storageKeys.defaults(), queryFn: getBucketDefaults });
}

export function useBucketTree(bucketId: string, prefix?: string) {
    return useQuery({ queryKey: storageKeys.tree(bucketId, prefix), queryFn: () => getBucketTree(bucketId, prefix), enabled: !!bucketId });
}

export function useObjects(bucketId: string, prefix?: string) {
    return useQuery({ queryKey: storageKeys.objects(bucketId, prefix), queryFn: () => listObjects(bucketId, prefix), enabled: !!bucketId });
}

export function useStorageConfigs(includeDisabled?: boolean) {
    return useQuery({ queryKey: storageKeys.configs(includeDisabled), queryFn: () => listStorageConfigs(includeDisabled) });
}

export function useEffectiveStorageConfig(bucketId?: string) {
    return useQuery({ queryKey: storageKeys.effectiveConfig(bucketId), queryFn: () => getEffectiveStorageConfig(bucketId) });
}

export function useAccessKeys() {
    return useQuery({ queryKey: storageKeys.accessKeys(), queryFn: listAccessKeys });
}

function useInvalidateStorage() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: storageKeys.root });
}

export function useCreateBucket() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (body: CreateBucketRequest) => createBucket(body), onSuccess: invalidate });
}

export function useDeleteBucket() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (id: string) => deleteBucket(id), onSuccess: invalidate });
}

export function useProvisionTenantBuckets() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (tenantId: string) => provisionTenantBuckets(tenantId), onSuccess: invalidate });
}

export function useSetBucketDefaults() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (body: SetBucketDefaultsRequest) => setBucketDefaults(body), onSuccess: invalidate });
}

export function useUploadObject() {
    const invalidate = useInvalidateStorage();
    return useMutation({
        mutationFn: ({ bucketId, key, file, filename }: { bucketId: string; key: string; file: Blob; filename?: string }) =>
            uploadObject(bucketId, key, file, filename),
        onSuccess: invalidate,
    });
}

export function useDeleteObject() {
    const invalidate = useInvalidateStorage();
    return useMutation({
        mutationFn: ({ bucketId, key }: { bucketId: string; key: string }) => deleteObject(bucketId, key),
        onSuccess: invalidate,
    });
}

/** Presigned URLs are one-shot reads — fetch on demand, never cache. */
export function usePresignedUrl() {
    return useMutation({ mutationFn: ({ bucketId, key }: { bucketId: string; key: string }) => getPresignedUrl(bucketId, key) });
}

export function useUpsertStorageConfig() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (body: UpsertStorageConfigRequest) => upsertStorageConfig(body), onSuccess: invalidate });
}

export function useDeleteStorageConfig() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (id: string) => deleteStorageConfig(id), onSuccess: invalidate });
}

export function useCreateAccessKey() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (body: CreateAccessKeyRequest) => createAccessKey(body), onSuccess: invalidate });
}

export function useDeleteAccessKey() {
    const invalidate = useInvalidateStorage();
    return useMutation({ mutationFn: (id: string) => deleteAccessKey(id), onSuccess: invalidate });
}
