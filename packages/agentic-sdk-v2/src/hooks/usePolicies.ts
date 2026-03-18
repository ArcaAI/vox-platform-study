/**
 * @arcaai/vox - usePolicies Hook (TASK-218)
 *
 * Policy management hook for admin RBAC operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { POLICY_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

export interface Policy {
  id: string;
  name: string;
  description?: string;
  scope?: string;
  rules: unknown[];
  resourceStatus?: string;
  [key: string]: unknown;
}

export interface CreatePolicyInput {
  name: string;
  description?: string;
  scope?: string;
  rules: unknown[];
  [key: string]: unknown;
}

export interface UpdatePolicyInput {
  name?: string;
  description?: string;
  scope?: string;
  rules?: unknown[];
  [key: string]: unknown;
}

export interface PolicyValidationResult {
  valid: boolean;
  errors?: string[];
  [key: string]: unknown;
}

export interface UsePoliciesReturn {
  policies: Policy[];
  currentPolicy: Policy | null;
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<Policy[]>;
  get: (id: string) => Promise<Policy>;
  create: (input: CreatePolicyInput) => Promise<Policy>;
  update: (id: string, input: UpdatePolicyInput) => Promise<Policy>;
  remove: (id: string) => Promise<void>;
  validate: (input: CreatePolicyInput) => Promise<PolicyValidationResult>;
}

export function usePolicies(): UsePoliciesReturn {
  const { execute, isLoading, error } = useApiOperation('usePolicies');

  const [policies, setPolicies] = useState<Policy[]>([]);
  const [currentPolicy, setCurrentPolicy] = useState<Policy | null>(null);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<Policy[]>('list', async (client) => {
        const raw = await client.get(appendPagination(POLICY_ENDPOINTS.LIST, pagination));
        const result = extractArray<Policy>(raw);
        setPolicies(result);
        return result;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<Policy>('get', async (client) => {
        const data = await client.get<Policy>(POLICY_ENDPOINTS.GET(id));
        setCurrentPolicy(data);
        return data;
      }),
    [execute],
  );

  const create = useCallback(
    (input: CreatePolicyInput) =>
      execute<Policy>('create', async (client) => {
        const data = await client.post<Policy>(POLICY_ENDPOINTS.CREATE, input);
        setPolicies((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdatePolicyInput) =>
      execute<Policy>('update', async (client) => {
        const updated = await client.put<Policy>(POLICY_ENDPOINTS.UPDATE(id), input);
        setCurrentPolicy(updated);
        setPolicies((prev) => prev.map((p) => (p.id === id ? updated : p)));
        return updated;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(POLICY_ENDPOINTS.DELETE(id));
        setPolicies((prev) => prev.filter((p) => p.id !== id));
      }),
    [execute],
  );

  const validate = useCallback(
    (input: CreatePolicyInput) =>
      execute<PolicyValidationResult>('validate', (client) =>
        client.post<PolicyValidationResult>(POLICY_ENDPOINTS.VALIDATE, input),
      ),
    [execute],
  );

  return { policies, currentPolicy, isLoading, error, list, get, create, update, remove, validate };
}
