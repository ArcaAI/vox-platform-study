import type { ListParams } from '@/shared/api';
import type { ListDepartmentsParams } from './types';

export const departmentKeys = {
    root: ['departments'] as const,
    list: (params?: ListDepartmentsParams) => [...departmentKeys.root, 'list', params ?? {}] as const,
    roots: () => [...departmentKeys.root, 'roots'] as const,
    detail: (id: string) => [...departmentKeys.root, 'detail', id] as const,
    children: (id: string) => [...departmentKeys.root, 'children', id] as const,
    users: (id: string, params?: ListParams) => [...departmentKeys.root, 'users', id, params ?? {}] as const,
    /** Prompt-template catalog for the prompt-config Selects. */
    promptTemplates: () => [...departmentKeys.root, 'prompt-templates'] as const,
};
