/**
 * Tenant storage administration (capabilities-matrix row 5): buckets, object
 * browsing, provider config and scoped access keys. Tenant-scoped via the
 * working-tenant header the proxy injects.
 */

import { deleteJson, getJson, postJson, putJson, request } from '@/shared/api';
import type {
    BucketDefaults,
    BucketObject,
    BucketTree,
    CreateAccessKeyRequest,
    CreateBucketRequest,
    SetBucketDefaultsRequest,
    StorageAccessKey,
    StorageAccessKeyWithSecret,
    TenantBucket,
    TenantStorageConfig,
    UpsertStorageConfigRequest,
} from './types';

const BUCKETS = 'admin/tenants/storage/buckets';
const CONFIG = 'admin/tenants/storage/config';
const KEYS = 'admin/tenants/storage/keys';

export function listBuckets(): Promise<TenantBucket[]> {
    return getJson(BUCKETS);
}

export function getBucket(id: string): Promise<TenantBucket | null> {
    return getJson(`${BUCKETS}/${encodeURIComponent(id)}`);
}

export function createBucket(body: CreateBucketRequest): Promise<TenantBucket> {
    return postJson(BUCKETS, body);
}

export function deleteBucket(id: string): Promise<TenantBucket> {
    return deleteJson(`${BUCKETS}/${encodeURIComponent(id)}`);
}

/** Provisions the standard system buckets for a tenant. */
export function provisionTenantBuckets(tenantId: string): Promise<TenantBucket[]> {
    return postJson(`${BUCKETS}/provision/${encodeURIComponent(tenantId)}`);
}

export function getBucketDefaults(): Promise<BucketDefaults> {
    return getJson(`${BUCKETS}/defaults`);
}

export function setBucketDefaults(body: SetBucketDefaultsRequest): Promise<BucketDefaults> {
    return putJson(`${BUCKETS}/defaults`, body);
}

export function getBucketTree(bucketId: string, prefix?: string): Promise<BucketTree> {
    return getJson(`${BUCKETS}/${encodeURIComponent(bucketId)}/tree`, { prefix });
}

export function listObjects(bucketId: string, prefix?: string): Promise<BucketObject[]> {
    return getJson(`${BUCKETS}/${encodeURIComponent(bucketId)}/objects`, { prefix });
}

/** Multipart upload — FormData passes through the proxy untouched. */
export async function uploadObject(bucketId: string, key: string, file: Blob, filename?: string): Promise<BucketObject> {
    const form = new FormData();
    form.set('file', file, filename ?? key.split('/').pop() ?? 'file');
    return (await request<BucketObject>(`${BUCKETS}/${encodeURIComponent(bucketId)}/objects`, { method: 'POST', body: form, params: { key } })).data;
}

export function deleteObject(bucketId: string, key: string): Promise<{ key: string; deleted: boolean }> {
    return deleteJson(`${BUCKETS}/${encodeURIComponent(bucketId)}/objects`, undefined, { key });
}

export function getPresignedUrl(bucketId: string, key: string): Promise<{ url: string }> {
    return getJson(`${BUCKETS}/${encodeURIComponent(bucketId)}/presigned-url`, { key });
}

export function listStorageConfigs(includeDisabled?: boolean): Promise<TenantStorageConfig[]> {
    return getJson(CONFIG, { includeDisabled });
}

export function getEffectiveStorageConfig(bucketId?: string): Promise<TenantStorageConfig | null> {
    return getJson(`${CONFIG}/effective`, { bucketId });
}

export function upsertStorageConfig(body: UpsertStorageConfigRequest): Promise<TenantStorageConfig> {
    return putJson(CONFIG, body);
}

export function deleteStorageConfig(id: string): Promise<TenantStorageConfig> {
    return deleteJson(`${CONFIG}/${encodeURIComponent(id)}`);
}

export function listAccessKeys(): Promise<StorageAccessKey[]> {
    return getJson(KEYS);
}

/** The secretAccessKey in the response is shown exactly once. */
export function createAccessKey(body: CreateAccessKeyRequest): Promise<StorageAccessKeyWithSecret> {
    return postJson(KEYS, body);
}

export function deleteAccessKey(id: string): Promise<StorageAccessKey> {
    return deleteJson(`${KEYS}/${encodeURIComponent(id)}`);
}
