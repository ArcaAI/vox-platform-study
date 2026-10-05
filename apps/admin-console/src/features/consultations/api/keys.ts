import type { ActivityFilters } from './activity';
import type { ConsultationAggregateParams, ListConsultationsParams } from './types';

export const consultationKeys = {
  root: ['consultations'] as const,
  list: (params?: ListConsultationsParams) => [...consultationKeys.root, 'list', params ?? {}] as const,
  aggregate: (params: ConsultationAggregateParams) => [...consultationKeys.root, 'aggregate', params] as const,
  detail: (id: string) => [...consultationKeys.root, 'detail', id] as const,
  composedPrompts: (id: string) => [...consultationKeys.root, 'composed-prompts', id] as const,
  composedPrompt: (recordId: string) => [...consultationKeys.root, 'composed-prompt', recordId] as const,
  activity: (id: string, filters: ActivityFilters = {}) =>
    [...consultationKeys.root, 'activity', id, { ...filters, kinds: filters.kinds ? [...filters.kinds].sort() : undefined }] as const,
  itemVersions: (id: string, itemId: string) => [...consultationKeys.root, 'item-versions', id, itemId] as const,
  itemVersion: (id: string, itemId: string, n: number) => [...consultationKeys.root, 'item-version', id, itemId, n] as const,
  itemDiff: (id: string, itemId: string, n: number, against: number) => [...consultationKeys.root, 'item-diff', id, itemId, n, against] as const,
  itemRuns: (id: string, itemId: string, version?: number) => [...consultationKeys.root, 'item-runs', id, itemId, version ?? null] as const,
};
