/**
 * @arcaai/vox - usePrompts Hook (SDK-207 WS-5, refactored TASK-039)
 *
 * Prompt Template management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { PROMPT_TEMPLATE_ENDPOINTS } from '../core/constants';
import { computePromptDiff } from '../utils/diffUtils';
import { extractArray } from '../utils/responseUtils';
import { appendFilters } from '../utils/urlUtils';
import type {
  PromptTemplate,
  PromptVersion,
  CreatePromptInput,
  UpdatePromptInput,
  PromptListFilters,
  AssignDepartmentPromptInput,
  DiffResult,
} from '../types';

export interface PromptUsageStats {
  totalUsages: number;
  lastUsedAt: string | null;
}

export interface UsePromptsReturn {
  prompts: PromptTemplate[];
  currentPrompt: PromptTemplate | null;
  isLoading: boolean;
  error: Error | null;
  create: (input: CreatePromptInput) => Promise<PromptTemplate>;
  list: (filters?: PromptListFilters) => Promise<PromptTemplate[]>;
  get: (id: string) => Promise<PromptTemplate>;
  update: (id: string, input: UpdatePromptInput) => Promise<PromptTemplate>;
  remove: (id: string) => Promise<void>;
  getVersions: (id: string) => Promise<PromptVersion[]>;
  getUsageStats: (id: string) => Promise<PromptUsageStats>;
  assignToDepartment: (input: AssignDepartmentPromptInput) => Promise<void>;
  compareVersions: (id: string, v1: number, v2: number) => Promise<DiffResult>;
  /** Activate (rollback to) a specific version of a prompt template. */
  activateVersion: (promptId: string, versionNumber: number) => Promise<PromptTemplate>;
}

export function usePrompts(): UsePromptsReturn {
  const { execute, isLoading, error } = useApiOperation('usePrompts');

  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState<PromptTemplate | null>(null);

  const create = useCallback(
    (input: CreatePromptInput) =>
      execute<PromptTemplate>('create', async (client) => {
        const data = await client.post<PromptTemplate>(PROMPT_TEMPLATE_ENDPOINTS.CREATE, input);
        setPrompts((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const list = useCallback(
    (filters?: PromptListFilters) =>
      execute<PromptTemplate[]>('list', async (client) => {
        const url = filters
          ? appendFilters(PROMPT_TEMPLATE_ENDPOINTS.LIST, {
              category: filters.category,
              departmentId: filters.departmentId,
              tags: filters.tags,
              search: filters.search || undefined,
            })
          : PROMPT_TEMPLATE_ENDPOINTS.LIST;
        const raw = await client.get(url);
        const items = extractArray<PromptTemplate>(raw);
        setPrompts(items);
        return items;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<PromptTemplate>('get', async (client) => {
        const data = await client.get<PromptTemplate>(PROMPT_TEMPLATE_ENDPOINTS.GET(id));
        setCurrentPrompt(data);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdatePromptInput) =>
      execute<PromptTemplate>('update', async (client) => {
        const data = await client.patch<PromptTemplate>(PROMPT_TEMPLATE_ENDPOINTS.UPDATE(id), input);
        setPrompts((prev) => prev.map((p) => (p.id === id ? data : p)));
        setCurrentPrompt(data);
        return data;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(PROMPT_TEMPLATE_ENDPOINTS.DELETE(id));
        setPrompts((prev) => prev.filter((p) => p.id !== id));
      }),
    [execute],
  );

  const getVersions = useCallback(
    (id: string) =>
      execute<PromptVersion[]>('getVersions', async (client) => {
        const raw = await client.get(PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(id));
        return extractArray<PromptVersion>(raw);
      }),
    [execute],
  );

  const getUsageStats = useCallback(
    (id: string) => execute<PromptUsageStats>('getUsageStats', (client) => client.get<PromptUsageStats>(PROMPT_TEMPLATE_ENDPOINTS.USAGE(id))),
    [execute],
  );

  const assignToDepartment = useCallback(
    (input: AssignDepartmentPromptInput) =>
      execute<void>('assignToDepartment', (client) => client.post(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, input) as Promise<void>),
    [execute],
  );

  const compareVersions = useCallback(
    (id: string, v1: number, v2: number) =>
      execute<DiffResult>('compareVersions', async (client) => {
        const [ver1, ver2] = await Promise.all([
          client.get<PromptVersion>(PROMPT_TEMPLATE_ENDPOINTS.VERSION(id, v1)),
          client.get<PromptVersion>(PROMPT_TEMPLATE_ENDPOINTS.VERSION(id, v2)),
        ]);
        return computePromptDiff(ver1.content, ver2.content);
      }),
    [execute],
  );

  const activateVersion = useCallback(
    (promptId: string, versionNumber: number) =>
      execute<PromptTemplate>('activateVersion', async (client) => {
        const data = await client.post<PromptTemplate>(PROMPT_TEMPLATE_ENDPOINTS.ACTIVATE_VERSION(promptId, versionNumber), {});
        setPrompts((prev) => prev.map((p) => (p.id === promptId ? data : p)));
        setCurrentPrompt(data);
        return data;
      }),
    [execute],
  );

  return {
    prompts,
    currentPrompt,
    isLoading,
    error,
    create,
    list,
    get,
    update,
    remove,
    getVersions,
    getUsageStats,
    assignToDepartment,
    compareVersions,
    activateVersion,
  };
}
