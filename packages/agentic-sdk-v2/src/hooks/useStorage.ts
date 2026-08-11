/**
 * @arcaai/vox - useStorage Hook
 *
 * Storage management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import { STORAGE_ENDPOINTS } from '../core/constants';
import type { PaginationParams } from '../types/common';

export interface Bucket {
  name: string;
  fileCount?: number;
  totalSize?: number;
  [key: string]: unknown;
}

export interface StorageFile {
  key: string;
  size?: number;
  lastModified?: string;
  contentType?: string;
  /**
   * The `Media` table row UUID for this file (TASK-656). Only present on the
   * response of an upload (`uploadFile`) — `StorageController.uploadFile`
   * creates a `Media` row best-effort and returns its id alongside `key`.
   * Callers that persist a reference to an uploaded file (e.g. as
   * `ContextItem.mediaId`) MUST use `mediaId`, never `key` — `key` is the raw
   * storage object key, not something `MediaRepository.findById` can resolve.
   */
  mediaId?: string;
  [key: string]: unknown;
}

export interface StorageFileWithUrl extends StorageFile {
  url: string;
}

export interface StorageHealth {
  status: 'healthy' | 'unhealthy' | 'not-configured' | string;
  connected?: boolean;
  configured?: boolean;
  isMinIO?: boolean;
  endpoint?: string;
  publicBucket?: string;
  privateBucket?: string;
  error?: string;
  [key: string]: unknown;
}

export interface CreateBucketResult {
  name: string;
  created: boolean;
}

export interface UseStorageReturn {
  buckets: Bucket[];
  files: StorageFile[];
  isLoading: boolean;
  error: Error | null;
  listBuckets: () => Promise<Bucket[]>;
  getBucket: (name: string) => Promise<Bucket>;
  createBucket: (name: string, type?: string) => Promise<CreateBucketResult>;
  deleteBucket: (name: string) => Promise<void>;
  listFiles: (bucket: string, prefix?: string, pagination?: PaginationParams) => Promise<StorageFile[]>;
  uploadFile: (bucket: string, file: File, key?: string) => Promise<StorageFile>;
  getFileInfo: (bucket: string, key: string) => Promise<StorageFileWithUrl>;
  deleteFile: (bucket: string, key: string) => Promise<void>;
  checkHealth: () => Promise<StorageHealth>;
}

export function useStorage(): UseStorageReturn {
  const { execute, isLoading, error } = useApiOperation('useStorage');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [files, setFiles] = useState<StorageFile[]>([]);

  const listBuckets = useCallback(
    () =>
      execute<Bucket[]>('listBuckets', async (client) => {
        const raw = await client.get(STORAGE_ENDPOINTS.LIST_BUCKETS);
        const items = extractArray<Bucket>(raw);
        const valid = items.filter((b) => b.name?.trim());
        setBuckets(valid);
        return valid;
      }),
    [execute],
  );

  const getBucket = useCallback(
    (name: string) => execute<Bucket>('getBucket', (client) => client.get<Bucket>(STORAGE_ENDPOINTS.GET_BUCKET(name))),
    [execute],
  );

  const createBucket = useCallback(
    (name: string, type?: string) =>
      execute<CreateBucketResult>('createBucket', async (client) => {
        const data = await client.post<CreateBucketResult>(STORAGE_ENDPOINTS.CREATE_BUCKET, { name, type: type ?? 'private' });
        setBuckets((prev) => [...prev, { ...data }]);
        return data;
      }),
    [execute],
  );

  const deleteBucket = useCallback(
    (name: string) =>
      execute<void>('deleteBucket', async (client) => {
        await client.delete(STORAGE_ENDPOINTS.DELETE_BUCKET(name));
        setBuckets((prev) => prev.filter((b) => b.name !== name));
      }),
    [execute],
  );

  const listFiles = useCallback(
    (bucket: string, prefix?: string, pagination?: PaginationParams) => {
      if (!bucket?.trim()) throw new Error('Bucket name is required');
      return execute<StorageFile[]>('listFiles', async (client) => {
        let endpoint = STORAGE_ENDPOINTS.LIST_FILES(bucket);
        const params = new URLSearchParams();
        if (prefix) params.set('prefix', prefix);
        const qs = params.toString();
        if (qs) endpoint = endpoint + '?' + qs;
        endpoint = appendPagination(endpoint, pagination);
        const raw = await client.get(endpoint);
        const items = extractArray<StorageFile>(raw);
        setFiles(items);
        return items;
      });
    },
    [execute],
  );

  const uploadFile = useCallback(
    (bucket: string, file: File, key?: string) =>
      execute<StorageFile>('uploadFile', async (client) => {
        const formData = new FormData();
        formData.append('file', file);
        if (key) formData.append('key', key);
        const data = await client.postFormData<StorageFile>(STORAGE_ENDPOINTS.UPLOAD_FILE(bucket), formData);
        setFiles((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const getFileInfo = useCallback(
    (bucket: string, key: string) =>
      execute<StorageFileWithUrl>('getFileInfo', (client) => client.get<StorageFileWithUrl>(STORAGE_ENDPOINTS.GET_FILE(bucket, key))),
    [execute],
  );

  const deleteFile = useCallback(
    (bucket: string, key: string) =>
      execute<void>('deleteFile', async (client) => {
        await client.delete(STORAGE_ENDPOINTS.DELETE_FILE(bucket, key));
        setFiles((prev) => prev.filter((f) => f.key !== key));
      }),
    [execute],
  );

  const checkHealth = useCallback(
    () => execute<StorageHealth>('checkHealth', (client) => client.get<StorageHealth>(STORAGE_ENDPOINTS.HEALTH)),
    [execute],
  );

  return {
    buckets,
    files,
    isLoading,
    error,
    listBuckets,
    getBucket,
    createBucket,
    deleteBucket,
    listFiles,
    uploadFile,
    getFileInfo,
    deleteFile,
    checkHealth,
  };
}
