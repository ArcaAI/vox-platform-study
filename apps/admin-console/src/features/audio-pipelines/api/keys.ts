export const audioPipelineKeys = {
  root: ['audio-pipelines'] as const,
  list: () => [...audioPipelineKeys.root, 'list'] as const,
  page: (params?: { page?: number; limit?: number }) => [...audioPipelineKeys.root, 'page', params ?? {}] as const,
  detail: (id: string) => [...audioPipelineKeys.root, 'detail', id] as const,
  bySlug: (slug: string) => [...audioPipelineKeys.root, 'slug', slug] as const,
  versions: (id: string) => [...audioPipelineKeys.root, 'versions', id] as const,
  version: (id: string, versionNumber: number) => [...audioPipelineKeys.root, 'versions', id, versionNumber] as const,
};
