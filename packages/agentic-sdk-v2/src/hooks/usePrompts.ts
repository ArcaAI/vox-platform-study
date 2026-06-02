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
  TestPromptInput,
  PromptTestResult,
  PromptUsageAnalytics,
} from '../types';

/**
 * TASK-328 A4 — serialize a version's content + variables (JSON) into a single
 * text blob so the line diff reflects BOTH the prompt text and the variable
 * definitions. When `variables` is absent the blob is just the content (so the
 * existing content-only diff behaviour is preserved).
 */
function serializeVersionForDiff(content: string, variables?: unknown): string {
  if (variables === undefined || variables === null) return content;
  return `${content}\n\n--- variables ---\n${JSON.stringify(variables, null, 2)}`;
}

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
  /** TASK-328 A4 — run a quality/score test against the SMR service. */
  test: (id: string, input?: TestPromptInput) => Promise<PromptTestResult>;
  /** TASK-328 A4 — usage analytics grouped by department / doctor / day. */
  analytics: (filters?: { promptTemplateId?: string }) => Promise<PromptUsageAnalytics>;
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
        // TASK-328 A4 — diff content AND variables (JSON) so variable
        // definition changes are visible in the version diff.
        return computePromptDiff(
          serializeVersionForDiff(ver1.content, ver1.variables),
          serializeVersionForDiff(ver2.content, ver2.variables),
        );
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

  const test = useCallback(
    (id: string, input?: TestPromptInput) =>
      execute<PromptTestResult>('test', async (client) => {
        // OCC parity with update(): the server folds the `If-Match` header
        // over the body `expectedVersion`, or uses the body value directly.
        const data = await client.post<PromptTestResult>(PROMPT_TEMPLATE_ENDPOINTS.TEST(id), input ?? {});
        // Reflect the new score/output/version onto cached state.
        setPrompts((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, lastTestScore: data.score, lastTestOutput: data.output, lastTestAt: data.testedAt, version: data.version } : p,
          ),
        );
        setCurrentPrompt((prev) =>
          prev && prev.id === id ? { ...prev, lastTestScore: data.score, lastTestOutput: data.output, lastTestAt: data.testedAt, version: data.version } : prev,
        );
        return data;
      }),
    [execute],
  );

  const analytics = useCallback(
    (filters?: { promptTemplateId?: string }) =>
      execute<PromptUsageAnalytics>('analytics', (client) => {
        const url = filters?.promptTemplateId
          ? appendFilters(PROMPT_TEMPLATE_ENDPOINTS.USAGE_ANALYTICS, { promptTemplateId: filters.promptTemplateId })
          : PROMPT_TEMPLATE_ENDPOINTS.USAGE_ANALYTICS;
        return client.get<PromptUsageAnalytics>(url);
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
    test,
    analytics,
  };
}
