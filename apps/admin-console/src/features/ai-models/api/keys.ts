import type { ListParams } from '@/shared/api';

export const aiModelKeys = {
  root: ['ai-models'] as const,
  /** Un-paginated GET /admin/ai-models (all rows). */
  all: () => [...aiModelKeys.root, 'all'] as const,
  list: (params?: ListParams) => [...aiModelKeys.root, 'list', params ?? {}] as const,
  detail: (id: string) => [...aiModelKeys.root, 'detail', id] as const,
  bySlug: (slug: string) => [...aiModelKeys.root, 'slug', slug] as const,
  /** Live merge view, keyed per provider filter. */
  discovery: (provider?: string) => [...aiModelKeys.root, 'discovery', provider ?? 'all'] as const,
  /** Download job state, per model. */
  download: (id: string) => [...aiModelKeys.root, 'download', id] as const,
  /** Read-only status of the SYSTEM `model-registry`/`s3` provider connection. */
  modelRegistryConnection: () => [...aiModelKeys.root, 'model-registry-connection'] as const,
  /** The most recent inventory report (written by the run mutation, read by the unregistered panel). */
  inventory: () => [...aiModelKeys.root, 'inventory'] as const,
};
