import type { ConsultationAggregateParams, ListConsultationsParams } from './types';

export const consultationKeys = {
  root: ['consultations'] as const,
  list: (params?: ListConsultationsParams) => [...consultationKeys.root, 'list', params ?? {}] as const,
  aggregate: (params: ConsultationAggregateParams) => [...consultationKeys.root, 'aggregate', params] as const,
  detail: (id: string) => [...consultationKeys.root, 'detail', id] as const,
};
