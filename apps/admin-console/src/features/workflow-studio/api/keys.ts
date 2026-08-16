/** Query-key factory — every key roots at ['workflow-studio'] for coarse invalidation (rule 13
 *  §Data & State). The node registry gets its own leaf, `registry()`, since it invalidates on a
 *  different cadence (code-owned, effectively static) than definition rows. */
export const workflowStudioKeys = {
  root: ['workflow-studio'] as const,
  list: () => [...workflowStudioKeys.root, 'list'] as const,
  detail: (id: string) => [...workflowStudioKeys.root, 'detail', id] as const,
  versions: (id: string) => [...workflowStudioKeys.root, 'versions', id] as const,
  registry: () => [...workflowStudioKeys.root, 'registry'] as const,
};
