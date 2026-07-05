/**
 * Tenant storage data plane (capabilities-matrix row 24): physical buckets and
 * objects, addressed by NAME through /storage/* on the gateway. Tenant-scoped
 * via the working-tenant header the proxy injects.
 */

import { deleteJson, getJson, patchJson, postJson, request } from '@/shared/api';
import type {
    BucketWithFiles,
    CreateBucketRequest,
    CreateBucketResult,
    DeleteBucketResult,
    DeleteFileResult,
    FileInfoResult,
    FileUploadResult,
    StorageBucket,
    StorageHealth,
    StorageObject,
    UpdateBucketRequest,
    UpdateBucketResult,
} from './types';

const BUCKETS = 'storage/buckets';

const bucketPath = (name: string) => `${BUCKETS}/${encodeURIComponent(name)}`;

/**
 * Object keys are ONE `:key` path segment on the gateway, so the whole key is
 * percent-encoded (slashes included). Note the controller rejects keys that
 * decode to `/`, `\` or `..` with 400 — nested keys from other producers list
 * fine but cannot be presigned/deleted through this surface.
 */
const filePath = (bucketName: string, key: string) => `${bucketPath(bucketName)}/files/${encodeURIComponent(key)}`;

export function listBuckets(): Promise<StorageBucket[]> {
    return getJson(BUCKETS);
}

export function createBucket(body: CreateBucketRequest): Promise<CreateBucketResult> {
    return postJson(BUCKETS, body);
}

export function getBucket(name: string): Promise<BucketWithFiles> {
    return getJson(bucketPath(name));
}

export function updateBucket(name: string, body: UpdateBucketRequest): Promise<UpdateBucketResult> {
    return patchJson(bucketPath(name), body);
}

export function deleteBucket(name: string): Promise<DeleteBucketResult> {
    return deleteJson(bucketPath(name));
}

/** Plain-array listing; `prefix` is the only server-side filter (no pagination). */
export function listObjects(bucketName: string, prefix?: string): Promise<StorageObject[]> {
    return getJson(`${bucketPath(bucketName)}/files`, { prefix: prefix || undefined });
}

/**
 * Multipart upload — the shared request() passes FormData through untouched
 * (the browser sets the boundary). The gateway reads the `file` field
 * (FileInterceptor('file')) and the optional `key` QUERY param (defaults to
 * the file's original name). Limits: 100 MB, audio/video/application/text/image.
 */
export async function uploadFile(bucketName: string, file: File, key?: string): Promise<FileUploadResult> {
    const form = new FormData();
    form.set('file', file, file.name);
    return (await request<FileUploadResult>(`${bucketPath(bucketName)}/files`, { method: 'POST', body: form, params: { key } })).data;
}

/** Presigned download: returns `{ key, url }` JSON (1 h expiry), never bytes. */
export function getFileInfo(bucketName: string, key: string): Promise<FileInfoResult> {
    return getJson(filePath(bucketName, key));
}

export function deleteFile(bucketName: string, key: string): Promise<DeleteFileResult> {
    return deleteJson(filePath(bucketName, key));
}

export function getStorageHealth(): Promise<StorageHealth> {
    return getJson('storage/health');
}
