import type { ListParams } from '@/shared/api';

export const userKeys = {
    root: ['users'] as const,
    list: (params?: ListParams) => [...userKeys.root, 'list', params ?? {}] as const,
    byTenant: (tenantId: string, params?: ListParams) => [...userKeys.root, 'by-tenant', tenantId, params ?? {}] as const,
    detail: (id: string) => [...userKeys.root, 'detail', id] as const,
    roles: (id: string) => [...userKeys.root, 'roles', id] as const,
    departments: (id: string) => [...userKeys.root, 'departments', id] as const,
    settings: (id: string) => [...userKeys.root, 'settings', id] as const,
    profile: (id: string) => [...userKeys.root, 'profile', id] as const,
    voiceProfiles: (id: string) => [...userKeys.root, 'voice-profiles', id] as const,
    apiKeys: (id: string, params?: ListParams) => [...userKeys.root, 'api-keys', id, params ?? {}] as const,
};
