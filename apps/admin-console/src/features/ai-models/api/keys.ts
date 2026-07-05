import type { ListParams } from '@/shared/api';

export const aiModelKeys = {
    root: ['ai-models'] as const,
    /** Un-paginated GET /admin/ai-models (all rows). */
    all: () => [...aiModelKeys.root, 'all'] as const,
    list: (params?: ListParams) => [...aiModelKeys.root, 'list', params ?? {}] as const,
    detail: (id: string) => [...aiModelKeys.root, 'detail', id] as const,
    bySlug: (slug: string) => [...aiModelKeys.root, 'slug', slug] as const,
};
