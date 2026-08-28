/** Query-key factory — every key roots at ['document-templates'] for coarse invalidation. */
export const documentTemplateKeys = {
  root: ['document-templates'] as const,
  list: () => [...documentTemplateKeys.root, 'list'] as const,
  detail: (id: string) => [...documentTemplateKeys.root, 'detail', id] as const,
  versions: (id: string) => [...documentTemplateKeys.root, 'versions', id] as const,
};
