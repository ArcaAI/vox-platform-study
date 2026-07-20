/**
 * @arcaai/vox - useApiKeys Hook (TASK-032 WS-G, refactored TASK-039)
 *
 * API key management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { API_KEY_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

export interface ApiKey {
  id: string;
  name: string;
  prefix?: string;
  type?: string;
  status?: string;
  scopes?: string[];
  lastUsedAt?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface ApiKeyWithRawKey extends ApiKey {
  rawKey: string;
}

export interface CreateApiKeyInput {
  name: string;
  type?: string;
  scopes?: string[];
  allowedIps?: string[];
  expiresAt?: string;
  [key: string]: unknown;
}

export interface UpdateApiKeyInput {
  name?: string;
  scopes?: string[];
  allowedIps?: string[];
  status?: string;
  [key: string]: unknown;
}

export interface ApiKeyUsage {
  totalRequests: number;
  lastUsedAt?: string;
  [key: string]: unknown;
}

export interface UseApiKeysReturn {
  apiKeys: ApiKey[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<ApiKey[]>;
  get: (id: string) => Promise<ApiKey>;
  create: (input: CreateApiKeyInput) => Promise<ApiKeyWithRawKey>;
  update: (id: string, input: UpdateApiKeyInput) => Promise<ApiKey>;
  remove: (id: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  /**
   * TASK-390 #23 (K5) — rotate the key: the server mints a NEW secret
   * (returned exactly once as `rawKey`) and keeps the OLD key valid for a 24h
   * grace window so clients can cut over without downtime.
   */
  rotate: (id: string) => Promise<ApiKeyWithRawKey>;
  getUsage: (id: string) => Promise<ApiKeyUsage>;
}

function normalizeApiKey(item: Record<string, unknown>): ApiKey {
  return {
    ...item,
    name: (item.name as string) ?? (item.keyName as string),
    prefix: (item.prefix as string) ?? (item.keyPrefix as string),
    type: (item.type as string) ?? (item.keyType as string),
    status: ((item.status as string) ?? (item.keyStatus as string) ?? '').toLowerCase(),
  } as ApiKey;
}

export function useApiKeys(): UseApiKeysReturn {
  const { execute, isLoading, error } = useApiOperation('useApiKeys');
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<ApiKey[]>('list', async (client) => {
        const raw = await client.get(appendPagination(API_KEY_ENDPOINTS.LIST, pagination));
        const items = extractArray<ApiKey>(raw).map((item) => normalizeApiKey(item as Record<string, unknown>));
        setApiKeys(items);
        return items;
      }),
    [execute],
  );

  const get = useCallback((id: string) => execute<ApiKey>('get', (client) => client.get<ApiKey>(API_KEY_ENDPOINTS.GET(id))), [execute]);

  const create = useCallback(
    (input: CreateApiKeyInput) =>
      execute<ApiKeyWithRawKey>('create', async (client) => {
        const extra = input as Record<string, unknown>;
        const apiPayload: Record<string, unknown> = {
          keyName: extra.keyName ?? input.name,
          keyType: extra.keyType ?? input.type?.toUpperCase() ?? 'SDK',
        };
        if (input.scopes) apiPayload.scopes = input.scopes;
        if (input.allowedIps) apiPayload.allowedIps = input.allowedIps;
        if (input.expiresAt) apiPayload.expiresAt = input.expiresAt;
        if (extra.description) apiPayload.description = extra.description;
        if (extra.environment) apiPayload.environment = extra.environment;
        if (extra.rateLimit !== undefined) apiPayload.rateLimit = extra.rateLimit;
        const data = await client.post<ApiKeyWithRawKey>(API_KEY_ENDPOINTS.CREATE, apiPayload);
        setApiKeys((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdateApiKeyInput) =>
      execute<ApiKey>('update', async (client) => {
        const updated = await client.patch<ApiKey>(API_KEY_ENDPOINTS.UPDATE(id), input);
        setApiKeys((prev) => prev.map((k) => (k.id === id ? updated : k)));
        return updated;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(API_KEY_ENDPOINTS.DELETE(id));
        setApiKeys((prev) => prev.filter((k) => k.id !== id));
      }),
    [execute],
  );

  const revoke = useCallback(
    (id: string) => execute<void>('revoke', (client) => client.post(API_KEY_ENDPOINTS.REVOKE(id), undefined) as Promise<void>),
    [execute],
  );

  const rotate = useCallback(
    (id: string) => execute<ApiKeyWithRawKey>('rotate', (client) => client.post<ApiKeyWithRawKey>(API_KEY_ENDPOINTS.ROTATE(id), undefined)),
    [execute],
  );

  const getUsage = useCallback(
    (id: string) => execute<ApiKeyUsage>('getUsage', (client) => client.get<ApiKeyUsage>(API_KEY_ENDPOINTS.USAGE(id))),
    [execute],
  );

  return { apiKeys, isLoading, error, list, get, create, update, remove, revoke, rotate, getUsage };
}
