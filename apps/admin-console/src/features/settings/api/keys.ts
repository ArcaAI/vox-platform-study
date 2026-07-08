import type { ListParams } from '@/shared/api';

export const settingKeys = {
    root: ['settings'] as const,
    list: (params?: ListParams) => [...settingKeys.root, 'list', params ?? {}] as const,
    byTenant: (tenantId: string, params?: ListParams) => [...settingKeys.root, 'by-tenant', tenantId, params ?? {}] as const,
    detail: (id: string) => [...settingKeys.root, 'detail', id] as const,
    history: (id: string) => [...settingKeys.root, 'history', id] as const,
};
