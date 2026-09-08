export const storageBrowserKeys = {
  root: ['storage-browser'] as const,
  buckets: () => [...storageBrowserKeys.root, 'buckets'] as const,
  /** "All tenants" listing (TASK-932 Lane T) — kept separate so switching scope never serves a stale cached page. */
  bucketsAllTenants: () => [...storageBrowserKeys.root, 'buckets', 'all-tenants'] as const,
  bucket: (name: string) => [...storageBrowserKeys.root, 'bucket', name] as const,
  objects: (bucketName: string, prefix?: string) => [...storageBrowserKeys.root, 'objects', bucketName, prefix ?? ''] as const,
  health: () => [...storageBrowserKeys.root, 'health'] as const,
};
