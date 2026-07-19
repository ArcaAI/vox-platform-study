import type { ListTemplatesParams } from './types';

export const promptStudioKeys = {
    root: ['prompt-studio'] as const,
    list: (params?: ListTemplatesParams) => [...promptStudioKeys.root, 'list', params ?? {}] as const,
    detail: (id: string) => [...promptStudioKeys.root, 'detail', id] as const,
    versions: (id: string) => [...promptStudioKeys.root, 'versions', id] as const,
    diff: (id: string, from: number | null, to: number | null) => [...promptStudioKeys.root, 'diff', id, from, to] as const,
};
