/** Query-key factory — every key roots at ['knowledge-documents'] for coarse invalidation. */
export const knowledgeKeys = {
  root: ['knowledge-documents'] as const,
  list: (params?: Record<string, unknown>) => [...knowledgeKeys.root, 'list', params ?? {}] as const,
  detail: (id: string) => [...knowledgeKeys.root, 'detail', id] as const,
  chunks: (id: string, params?: Record<string, unknown>) => [...knowledgeKeys.root, 'chunks', id, params ?? {}] as const,
};
