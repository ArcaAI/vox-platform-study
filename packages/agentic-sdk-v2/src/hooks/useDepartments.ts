/**
 * @arcaai/vox - useDepartments Hook (SDK-207 WS-5, refactored TASK-039)
 *
 * Department management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { DEPARTMENT_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';

export interface Department {
  id: string;
  name: string;
  code?: string;
  defaultDnaStyleId?: string;
  defaultSummaryTemplate?: string;
  newPatientPromptId?: string;
  revisitPromptId?: string;
  summaryPromptId?: string;
  promptMetadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UseDepartmentsReturn {
  departments: Department[];
  currentDepartment: Department | null;
  isLoading: boolean;
  error: Error | null;
  list: () => Promise<Department[]>;
  get: (id: string) => Promise<Department>;
  create: (data: Partial<Department>) => Promise<Department>;
  update: (id: string, data: Partial<Department>) => Promise<Department>;
  remove: (id: string) => Promise<void>;
  getRoots: () => Promise<Department[]>;
  getChildren: (id: string) => Promise<Department[]>;
  getByCode: (code: string) => Promise<Department>;
  updatePromptConfig: (id: string, data: Record<string, unknown>) => Promise<Department>;
}

export function useDepartments(): UseDepartmentsReturn {
  const { execute, isLoading, error } = useApiOperation('useDepartments');

  const [departments, setDepartments] = useState<Department[]>([]);
  const [currentDepartment, setCurrentDepartment] = useState<Department | null>(null);

  const list = useCallback(
    () =>
      execute<Department[]>('list', async (client) => {
        const raw = await client.get(DEPARTMENT_ENDPOINTS.LIST);
        const items = extractArray<Department>(raw);
        setDepartments(items);
        return items;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<Department>('get', async (client) => {
        const data = await client.get<Department>(DEPARTMENT_ENDPOINTS.GET(id));
        setCurrentDepartment(data);
        return data;
      }),
    [execute],
  );

  const create = useCallback(
    (data: Partial<Department>) =>
      execute<Department>('create', async (client) => {
        const created = await client.post<Department>(DEPARTMENT_ENDPOINTS.CREATE, data);
        setDepartments((prev) => [...prev, created]);
        return created;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, data: Partial<Department>) =>
      execute<Department>('update', async (client) => {
        const updated = await client.patch<Department>(DEPARTMENT_ENDPOINTS.UPDATE(id), data);
        setCurrentDepartment(updated);
        setDepartments((prev) => prev.map((d) => (d.id === id ? updated : d)));
        return updated;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(DEPARTMENT_ENDPOINTS.DELETE(id));
        setDepartments((prev) => prev.filter((d) => d.id !== id));
      }),
    [execute],
  );

  const getRoots = useCallback(
    () =>
      execute<Department[]>('getRoots', async (client) => {
        const raw = await client.get(DEPARTMENT_ENDPOINTS.ROOTS);
        return extractArray<Department>(raw);
      }),
    [execute],
  );

  const getChildren = useCallback(
    (id: string) =>
      execute<Department[]>('getChildren', async (client) => {
        const raw = await client.get(DEPARTMENT_ENDPOINTS.CHILDREN(id));
        return extractArray<Department>(raw);
      }),
    [execute],
  );

  const getByCode = useCallback(
    (code: string) => execute<Department>('getByCode', (client) => client.get<Department>(DEPARTMENT_ENDPOINTS.BY_CODE(code))),
    [execute],
  );

  const updatePromptConfig = useCallback(
    (id: string, data: Record<string, unknown>) =>
      execute<Department>('updatePromptConfig', (client) => client.patch<Department>(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id), data)),
    [execute],
  );

  return {
    departments,
    currentDepartment,
    isLoading,
    error,
    list,
    get,
    create,
    update,
    remove,
    getRoots,
    getChildren,
    getByCode,
    updatePromptConfig,
  };
}
