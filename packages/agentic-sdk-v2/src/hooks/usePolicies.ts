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
  /**
   * TASK-409 — true for the anti-lockout protected system policies
   * (seed-managed, read-only; the API refuses delete/detach/disable).
   */
  isProtected?: boolean;
  [key: string]: unknown;
}

/**
 * TASK-409 — break-glass step-up confirmation for dangerous RBAC mutations.
 * The API replies 428 when it is required but missing, 401 on a wrong
 * password, and 400 on a confirmation-name mismatch.
 */
export interface BreakGlassCredentials {
  /** Caller's CURRENT password (re-authentication; never logged). */
  password: string;
  /** Exact name of the policy/role being mutated (type-to-confirm). */
  confirmationName: string;
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
  /**
   * TASK-409 — required when editing the rules of a policy attached to more
   * than one role (the API replies 428 until it is supplied).
   */
  breakGlass?: BreakGlassCredentials;
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
  /** TASK-409 — deletion requires break-glass confirmation (428 without it). */
  remove: (id: string, breakGlass?: BreakGlassCredentials) => Promise<void>;
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
    (id: string, breakGlass?: BreakGlassCredentials) =>
      execute<void>('remove', async (client) => {
        // Conditional arity keeps the pre-TASK-409 wire shape for callers
        // that pass no confirmation (the API then replies 428).
        if (breakGlass) {
          await client.delete(POLICY_ENDPOINTS.DELETE(id), { data: breakGlass });
        } else {
          await client.delete(POLICY_ENDPOINTS.DELETE(id));
        }
        setPolicies((prev) => prev.filter((p) => p.id !== id));
      }),
    [execute],
  );

  const validate = useCallback(
    (input: CreatePolicyInput) =>
      execute<PolicyValidationResult>('validate', (client) => client.post<PolicyValidationResult>(POLICY_ENDPOINTS.VALIDATE, input)),
    [execute],
  );

  return { policies, currentPolicy, isLoading, error, list, get, create, update, remove, validate };
}
