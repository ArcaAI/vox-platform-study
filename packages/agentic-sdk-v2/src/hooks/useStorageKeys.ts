/**
 * @arcaai/vox - useStorageKeys Hook
 *
 * Per-tenant storage access-key management for TENANT_ADMIN / GLOBAL_ADMIN. The
 * server gates `/admin/tenants/storage/keys` with `@CanManage('Tenant')`, so a
 * plain DOCTOR is denied (403) — surfaced as a clean `AgenticError`.
 *
 * SECURITY: `create()` returns the secret exactly once (`StorageKeyWithSecret`).
 * `list()` never returns secrets. Surface the secret to the user immediately
 * and do not persist it.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { STORAGE_KEY_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';

/**
 * Storage access key (secret NOT included). Minimal local shape with an index
 * signature so server fields the SDK does not yet model pass through untouched.
 */
export interface StorageKey {
  id: string;
  accessKeyId?: string;
  label?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** Storage access key with its one-time secret (only returned by `create`). */
export interface StorageKeyWithSecret extends StorageKey {
  /** The generated secret — shown exactly once. */
  secret?: string;
}

export interface CreateStorageKeyInput {
  label?: string;
  [key: string]: unknown;
}

export interface UseStorageKeysReturn {
  keys: StorageKey[];
  isLoading: boolean;
  error: Error | null;
  list: () => Promise<StorageKey[]>;
  create: (input: CreateStorageKeyInput) => Promise<StorageKeyWithSecret>;
  revoke: (id: string) => Promise<StorageKey>;
}

export function useStorageKeys(): UseStorageKeysReturn {
  const { execute, isLoading, error } = useApiOperation('useStorageKeys');

  const [keys, setKeys] = useState<StorageKey[]>([]);

  const list = useCallback(
    () =>
      execute<StorageKey[]>('list', async (client) => {
        const raw = await client.get(STORAGE_KEY_ENDPOINTS.LIST);
        const result = extractArray<StorageKey>(raw);
        setKeys(result);
        return result;
      }),
    [execute],
  );

  const create = useCallback(
    (input: CreateStorageKeyInput) =>
      execute<StorageKeyWithSecret>('create', async (client) => {
        const data = await client.post<StorageKeyWithSecret>(STORAGE_KEY_ENDPOINTS.CREATE, input);
        setKeys((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const revoke = useCallback(
    (id: string) =>
      execute<StorageKey>('revoke', async (client) => {
        const data = await client.delete<StorageKey>(STORAGE_KEY_ENDPOINTS.DELETE(id));
        setKeys((prev) => prev.filter((k) => k.id !== id));
        return data;
      }),
    [execute],
  );

  return { keys, isLoading, error, list, create, revoke };
}
