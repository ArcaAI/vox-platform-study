import type { ListDepartmentAgentsParams, ListTemplatesParams, ListUsageRecordsParams } from './types';

/** Query-key factory — every key roots at ['agents'] for coarse invalidation. */
export const agentKeys = {
    root: ['agents'] as const,
    list: (params?: ListTemplatesParams) => [...agentKeys.root, 'list', params ?? {}] as const,
    detail: (id: string) => [...agentKeys.root, 'detail', id] as const,
    versions: (id: string) => [...agentKeys.root, 'versions', id] as const,
    version: (id: string, versionNumber: number) => [...agentKeys.root, 'version', id, versionNumber] as const,
    diff: (id: string, from: number, to: number) => [...agentKeys.root, 'diff', id, from, to] as const,
    usage: (id: string) => [...agentKeys.root, 'usage', id] as const,
    analytics: (promptTemplateId?: string) => [...agentKeys.root, 'analytics', promptTemplateId ?? null] as const,
    usageRecords: (params?: ListUsageRecordsParams) => [...agentKeys.root, 'usage-records', params ?? {}] as const,
    departments: () => [...agentKeys.root, 'departments'] as const,
};

/**
 * `DepartmentAgent` query-key factory — rooted separately at
 * ['department-agents'] so a mutation there never invalidates the unrelated
 * PromptTemplate/`agentKeys` cache (and vice versa).
 */
export const departmentAgentKeys = {
    root: ['department-agents'] as const,
    list: (params?: ListDepartmentAgentsParams) => [...departmentAgentKeys.root, 'list', params ?? {}] as const,
    detail: (id: string) => [...departmentAgentKeys.root, 'detail', id] as const,
};
