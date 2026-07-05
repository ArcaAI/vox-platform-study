export const storageKeys = {
    root: ['storage'] as const,
    buckets: () => [...storageKeys.root, 'buckets'] as const,
    bucket: (id: string) => [...storageKeys.root, 'buckets', id] as const,
    defaults: () => [...storageKeys.root, 'defaults'] as const,
    tree: (bucketId: string, prefix?: string) => [...storageKeys.root, 'tree', bucketId, prefix ?? ''] as const,
    objects: (bucketId: string, prefix?: string) => [...storageKeys.root, 'objects', bucketId, prefix ?? ''] as const,
    configs: (includeDisabled?: boolean) => [...storageKeys.root, 'configs', includeDisabled ?? false] as const,
    effectiveConfig: (bucketId?: string) => [...storageKeys.root, 'effective-config', bucketId ?? null] as const,
    accessKeys: () => [...storageKeys.root, 'access-keys'] as const,
};
