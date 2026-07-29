import type { ListParams } from '@/shared/api';

export const apiKeyKeys = {
  root: ['api-keys'] as const,
  list: (params?: ListParams) => [...apiKeyKeys.root, 'list', params ?? {}] as const,
  detail: (id: string) => [...apiKeyKeys.root, 'detail', id] as const,
  usage: (id: string) => [...apiKeyKeys.root, 'usage', id] as const,
  scopes: () => [...apiKeyKeys.root, 'scopes'] as const,
};
