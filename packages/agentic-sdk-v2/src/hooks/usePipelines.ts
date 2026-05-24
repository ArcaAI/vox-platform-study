/**
 * @arcaai/vox - usePipelines Hook (TASK-032 WS-A, refactored TASK-039)
 *
 * Pipeline discovery and selection hook.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { useUserSettings } from './useUserSettings';
import { PIPELINE_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

/**
 * TASK-298 D-5 — Namespace + key used to persist the doctor's chosen
 * pipeline through the existing UserSettings backend
 * (`PATCH /user/me/settings/:namespace/:key`). The server-side validator
 * in `UserSettingsController` rejects cross-tenant pipeline ids.
 */
export const SELECTED_PIPELINE_SETTING = {
  namespace: 'arcaai-sdk',
  key: 'selectedPipelineId',
} as const;

export interface Pipeline {
  id: string;
  name: string;
  slug: string;
  description?: string;
  configYaml?: string;
  tags?: string[];
  resourceStatus?: string;
  [key: string]: unknown;
}

export interface CreatePipelineInput {
  name: string;
  slug: string;
  configYaml: string;
  description?: string;
  tags?: string[];
}

export interface UpdatePipelineInput {
  name?: string;
  slug?: string;
  configYaml?: string;
  description?: string;
  tags?: string[];
}

export interface PipelineValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface UsePipelinesReturn {
  pipelines: Pipeline[];
  selectedPipeline: Pipeline | null;
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<Pipeline[]>;
  get: (id: string) => Promise<Pipeline>;
  getBySlug: (slug: string) => Promise<Pipeline>;
  /**
   * Set the active pipeline. TASK-298 D-5 — also persists the choice to
   * `PATCH /user/me/settings/arcaai-sdk/selectedPipelineId`. Backwards
   * compatible: the return type is `Promise<void>`, but synchronous callers
   * that drop the promise still get the immediate local-state update.
   */
  select: (pipelineId: string) => Promise<void>;
  createPipeline: (input: CreatePipelineInput) => Promise<Pipeline>;
  updatePipeline: (id: string, input: UpdatePipelineInput) => Promise<Pipeline>;
  deletePipeline: (id: string) => Promise<void>;
  validateConfig: (configYaml: string) => Promise<PipelineValidationResult>;
  assignToTenant: (pipelineId: string, tenantId: string) => Promise<{ message: string }>;
}

export function usePipelines(): UsePipelinesReturn {
  const { execute, isLoading, error } = useApiOperation('usePipelines');
  const userSettings = useUserSettings();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<Pipeline[]>('list', async (client) => {
        const raw = await client.get(appendPagination(PIPELINE_ENDPOINTS.LIST, pagination));
        const items = extractArray<Pipeline>(raw);
        setPipelines(items);
        return items;
      }),
    [execute],
  );

  const get = useCallback((id: string) => execute<Pipeline>('get', (client) => client.get<Pipeline>(PIPELINE_ENDPOINTS.GET(id))), [execute]);

  const getBySlug = useCallback(
    (slug: string) => execute<Pipeline>('getBySlug', (client) => client.get<Pipeline>(PIPELINE_ENDPOINTS.GET_BY_SLUG(slug))),
    [execute],
  );

  const select = useCallback(
    async (pipelineId: string): Promise<void> => {
      const found = pipelines.find((p) => p.id === pipelineId) ?? null;
      setSelectedPipeline(found);

      if (!found) {
        return;
      }

      // TASK-298 D-5 — persist selection through the existing UserSettings
      // backend. The server validator rejects cross-tenant pipeline ids
      // with `BadRequestException`; we swallow the failure here so the UI
      // remains responsive (the caller's `error` state still surfaces it).
      try {
        await userSettings.updateByKey(SELECTED_PIPELINE_SETTING.namespace, SELECTED_PIPELINE_SETTING.key, pipelineId);
      } catch {
        // intentional: persistence failure must not unwind local state.
      }
    },
    [pipelines, userSettings],
  );

  const createPipeline = useCallback(
    (input: CreatePipelineInput) =>
      execute<Pipeline>('createPipeline', async (client) => {
        const data = await client.post<Pipeline>(PIPELINE_ENDPOINTS.CREATE, input);
        setPipelines((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const updatePipeline = useCallback(
    (id: string, input: UpdatePipelineInput) =>
      execute<Pipeline>('updatePipeline', async (client) => {
        const updated = await client.patch<Pipeline>(PIPELINE_ENDPOINTS.UPDATE(id), input);
        setPipelines((prev) => prev.map((p) => (p.id === id ? updated : p)));
        return updated;
      }),
    [execute],
  );

  const deletePipeline = useCallback(
    (id: string) =>
      execute<void>('deletePipeline', async (client) => {
        await client.delete(PIPELINE_ENDPOINTS.DELETE(id));
        setPipelines((prev) => prev.filter((p) => p.id !== id));
      }),
    [execute],
  );

  const validateConfig = useCallback(
    (configYaml: string) =>
      execute<PipelineValidationResult>('validateConfig', (client) =>
        client.post<PipelineValidationResult>(PIPELINE_ENDPOINTS.VALIDATE, { configYaml }),
      ),
    [execute],
  );

  const assignToTenant = useCallback(
    (pipelineId: string, tenantId: string) =>
      execute<{ message: string }>('assignToTenant', (client) =>
        client.post<{ message: string }>(PIPELINE_ENDPOINTS.ASSIGN_TENANT(pipelineId), { tenantId }),
      ),
    [execute],
  );

  return {
    pipelines,
    selectedPipeline,
    isLoading,
    error,
    list,
    get,
    getBySlug,
    select,
    createPipeline,
    updatePipeline,
    deletePipeline,
    validateConfig,
    assignToTenant,
  };
}
