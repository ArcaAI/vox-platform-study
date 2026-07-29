import type { ListDnaReportsParams } from './types';

export const dnaKeys = {
  root: ['dna-writing-styles'] as const,
  list: (params?: ListDnaReportsParams) => [...dnaKeys.root, 'list', params ?? {}] as const,
  dashboard: () => [...dnaKeys.root, 'dashboard'] as const,
  doctor: (doctorId: string) => [...dnaKeys.root, 'doctor', doctorId] as const,
  versions: (reportId: string) => [...dnaKeys.root, 'versions', reportId] as const,
  job: (jobId: string) => [...dnaKeys.root, 'job', jobId] as const,
};
