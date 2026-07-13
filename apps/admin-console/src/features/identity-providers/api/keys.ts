/** Query-key factory — every key roots at ['identity-providers'] for coarse invalidation. */
export const identityProviderKeys = {
    root: ['identity-providers'] as const,
    list: () => [...identityProviderKeys.root, 'list'] as const,
    detail: (id: string) => [...identityProviderKeys.root, 'detail', id] as const,
    departments: () => [...identityProviderKeys.root, 'departments'] as const,
    roles: () => [...identityProviderKeys.root, 'roles'] as const,
};
