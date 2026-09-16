/** Query-key factory — every key roots at ['context-schemas'] for coarse invalidation. */
export const contextSchemaKeys = {
  root: ['context-schemas'] as const,
  list: () => [...contextSchemaKeys.root, 'list'] as const,
  detail: (id: string) => [...contextSchemaKeys.root, 'detail', id] as const,
  versions: (id: string) => [...contextSchemaKeys.root, 'versions', id] as const,
  usages: (id: string, againstVersion?: number) => [...contextSchemaKeys.root, 'usages', id, againstVersion ?? null] as const,
  departments: () => [...contextSchemaKeys.root, 'departments'] as const,
};
