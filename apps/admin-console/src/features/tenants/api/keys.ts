import type { ListParams } from '@/shared/api';

/** Query-key factory — every key roots at ['tenants'] for coarse invalidation. */
export const tenantKeys = {
    root: ['tenants'] as const,
    list: (params?: ListParams) => [...tenantKeys.root, 'list', params ?? {}] as const,
    detail: (id: string) => [...tenantKeys.root, 'detail', id] as const,
    usage: (id: string) => [...tenantKeys.root, 'usage', id] as const,
    tags: (id: string) => [...tenantKeys.root, 'tags', id] as const,
    configs: (identifier: string, params?: ListParams) => [...tenantKeys.root, 'configs', identifier, params ?? {}] as const,
    frontendConfig: (tenantId?: string) => [...tenantKeys.root, 'frontend-config', tenantId ?? null] as const,
};
