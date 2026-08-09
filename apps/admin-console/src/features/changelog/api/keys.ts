import type { ChangelogSeverity } from './types';

export const changelogKeys = {
  all: ['changelog'] as const,
  unseen: () => [...changelogKeys.all, 'unseen'] as const,
  list: (params?: { severity?: ChangelogSeverity; page?: number; version?: string }) => [...changelogKeys.all, 'list', params ?? {}] as const,
  detail: (id: string) => [...changelogKeys.all, 'detail', id] as const,
};
