/**
 * @arcaai/vox - usePrompts Hook (SDK-207 WS-5, refactored TASK-039)
 *
 * Prompt Template management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { PROMPT_TEMPLATE_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendFilters } from '../utils/urlUtils';
import { toPromptTestMetricScores } from '../utils/promptMetrics';
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
  PromptTestMetrics,
  PromptUsageAnalytics,
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
  /**
   * TASK-331 doc-09 — end-user (clinician) read-only template list. Hits the
   * `prompt-templates/available` end-user route (NOT `/admin/*`), returning the
   * tenant + department defaults plus the caller's OWN personal templates.
   * Use this for clinician-facing selectors (Pre-Summary / Summary) so a doctor
   * without admin ability is not bounced to `/403`.
   */
  listAvailable: (filters?: { category?: string }) => Promise<PromptTemplate[]>;
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
              // TASK-388 #12 — admin scope/owner narrowing.
              scope: filters.scope,
              ownerUserId: filters.ownerUserId,
            })
          : PROMPT_TEMPLATE_ENDPOINTS.LIST;
        const raw = await client.get(url);
        const items = extractArray<PromptTemplate>(raw);
        setPrompts(items);
        return items;
      }),
    [execute],
  );

  const listAvailable = useCallback(
    (filters?: { category?: string }) =>
      execute<PromptTemplate[]>('listAvailable', async (client) => {
        const url = filters?.category
          ? appendFilters(PROMPT_TEMPLATE_ENDPOINTS.AVAILABLE, { category: filters.category })
          : PROMPT_TEMPLATE_ENDPOINTS.AVAILABLE;
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
      execute<void>('assignToDepartment', (client) => {
        // The backend `assign-department` DTO whitelists
        // `{ departmentId, preSummaryPromptId?, newPatientPromptId?, revisitPromptId?, expectedVersion }`
        // and reads the OCC token from the BODY (this POST has no If-Match gate).
        // Translate the ergonomic `{ promptTemplateId, field }` input onto that
        // contract so the unknown keys don't trip `forbidNonWhitelisted` (400).
        const body = {
          departmentId: input.departmentId,
          [input.field]: input.promptTemplateId,
          expectedVersion: input.expectedVersion,
        };
        return client.post(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, body) as Promise<void>;
      }),
    [execute],
  );

  const compareVersions = useCallback(
    (id: string, v1: number, v2: number) =>
      execute<DiffResult>('compareVersions', async (client) => {
        // TASK-389 #14 (AG8/A3) — one request to the server-side diff endpoint
        // (was: GET both versions + diff client-side). The server returns a
        // superset of DiffResult (per-field breakdown + the combined
        // content+variables line diff); map the combined `{changes,patch,stats}`
        // so the returned shape is unchanged for existing consumers.
        const result = await client.get<DiffResult>(PROMPT_TEMPLATE_ENDPOINTS.DIFF(id, v1, v2));
        return { changes: result.changes, patch: result.patch, stats: result.stats };
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
        // TASK-389 #15 (AG12/A5) — the server's `metrics` is the RAW backend
        // `PromptTestMetrics`; keep it on `metricDetail` and derive the flat
        // `[0,1]` display map the admin Test Playground consumes.
        const raw = await client.post<Omit<PromptTestResult, 'metrics' | 'metricDetail'> & { metrics?: PromptTestMetrics }>(
          PROMPT_TEMPLATE_ENDPOINTS.TEST(id),
          input ?? {},
        );
        const data: PromptTestResult = {
          id: raw.id,
          score: raw.score,
          output: raw.output,
          testedAt: raw.testedAt,
          version: raw.version,
          metricDetail: raw.metrics,
          metrics: toPromptTestMetricScores(raw.metrics),
        };
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
    listAvailable,
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
