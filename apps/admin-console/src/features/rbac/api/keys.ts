import type { PolicyListParams, RbacListParams } from './types';

export const rbacKeys = {
    root: ['rbac'] as const,
    roles: (params?: RbacListParams) => [...rbacKeys.root, 'roles', params ?? {}] as const,
    role: (id: string) => [...rbacKeys.root, 'role', id] as const,
    policies: (params?: PolicyListParams) => [...rbacKeys.root, 'policies', params ?? {}] as const,
    policy: (id: string) => [...rbacKeys.root, 'policy', id] as const,
};
