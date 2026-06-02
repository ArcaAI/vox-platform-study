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
  /** TASK-328 A6 — whether this pipeline is the tenant's default. */
  isDefault?: boolean;
  /**
   * Row's optimistic-concurrency version (TASK-302 Stream D Phase E.4) —
   * `_version` in the database. Echo back via the `If-Match` header (or
   * the body's `expectedVersion`) on the next PATCH so the server can
   * run a Compare-And-Set.
   */
  version?: number;
  [key: string]: unknown;
}

/**
 * TASK-328 A6 — a single config-version snapshot of a pipeline. Written on
 * every YAML config change; surfaced for the versions list + diff/view UI.
 */
export interface PipelineVersion {
  id: string;
  asrPipelineId: string;
  versionNumber: number;
  configYaml: string;
  name?: string | null;
  description?: string | null;
  changeReason?: string | null;
  changedBy?: string | null;
  createdAt: string;
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
  /**
   * Optimistic-concurrency token (TASK-302 Stream D Phase E.4) — should
   * match the `version` the SDK read from the prior `get()`. The server
   * fails with `412 Precondition Failed` when the row drifted. When the
   * caller uses `If-Match` instead, the header wins.
   */
  expectedVersion?: number;
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
  /** TASK-328 A6 — mark a pipeline as the tenant default (unsets the previous). */
  setDefault: (pipelineId: string) => Promise<Pipeline>;
  /**
   * TASK-328 A6 — enable/disable a pipeline. OCC-guarded: pass the `version`
   * read from `list`/`get`; it is replayed as the `If-Match` header so the
   * server can run a Compare-And-Set (stale version → 412).
   */
  toggle: (pipelineId: string, enabled: boolean, expectedVersion: number) => Promise<Pipeline>;
  /** TASK-328 A6 — list config-version snapshots (newest first). */
  listVersions: (pipelineId: string) => Promise<PipelineVersion[]>;
  /** TASK-328 A6 — get one config-version snapshot by version number. */
  getVersion: (pipelineId: string, versionNumber: number) => Promise<PipelineVersion>;
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

  // TASK-328 A6 — mark a pipeline as the tenant default; reflect the flipped
  // `isDefault` flags locally (the newly-default one true, all others false).
  const setDefault = useCallback(
    (pipelineId: string) =>
      execute<Pipeline>('setDefault', async (client) => {
        const updated = await client.post<Pipeline>(PIPELINE_ENDPOINTS.SET_DEFAULT(pipelineId), {});
        setPipelines((prev) => prev.map((p) => (p.id === pipelineId ? { ...p, ...updated, isDefault: true } : { ...p, isDefault: false })));
        return updated;
      }),
    [execute],
  );

  // TASK-328 A6 — enable/disable. OCC: replay the row version as `If-Match`
  // (RFC 7232 strong validator) so the server runs a Compare-And-Set.
  const toggle = useCallback(
    (pipelineId: string, enabled: boolean, expectedVersion: number) =>
      execute<Pipeline>('toggle', async (client) => {
        const updated = await client.patchWithIfMatch<Pipeline>(PIPELINE_ENDPOINTS.TOGGLE(pipelineId), { enabled }, `"${expectedVersion}"`);
        setPipelines((prev) => prev.map((p) => (p.id === pipelineId ? updated : p)));
        return updated;
      }),
    [execute],
  );

  const listVersions = useCallback(
    (pipelineId: string) =>
      execute<PipelineVersion[]>('listVersions', async (client) => {
        const raw = await client.get(PIPELINE_ENDPOINTS.VERSIONS(pipelineId));
        return extractArray<PipelineVersion>(raw);
      }),
    [execute],
  );

  const getVersion = useCallback(
    (pipelineId: string, versionNumber: number) =>
      execute<PipelineVersion>('getVersion', (client) => client.get<PipelineVersion>(PIPELINE_ENDPOINTS.VERSION(pipelineId, versionNumber))),
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
    setDefault,
    toggle,
    listVersions,
    getVersion,
  };
}
