import type {
  ListAgentEvalRunsParams,
  ListEvalGoldenCasesParams,
  ListEvalGoldenSetsParams,
  ListTemplatesParams,
  ListUsageRecordsParams,
} from './types';

/** Query-key factory — every key roots at ['prompt-templates'] for coarse invalidation. */
export const promptTemplateKeys = {
  root: ['prompt-templates'] as const,
  list: (params?: ListTemplatesParams) => [...promptTemplateKeys.root, 'list', params ?? {}] as const,
  detail: (id: string) => [...promptTemplateKeys.root, 'detail', id] as const,
  versions: (id: string) => [...promptTemplateKeys.root, 'versions', id] as const,
  version: (id: string, versionNumber: number) => [...promptTemplateKeys.root, 'version', id, versionNumber] as const,
  diff: (id: string, from: number, to: number) => [...promptTemplateKeys.root, 'diff', id, from, to] as const,
  usage: (id: string) => [...promptTemplateKeys.root, 'usage', id] as const,
  analytics: (promptTemplateId?: string) => [...promptTemplateKeys.root, 'analytics', promptTemplateId ?? null] as const,
  usageRecords: (params?: ListUsageRecordsParams) => [...promptTemplateKeys.root, 'usage-records', params ?? {}] as const,
  departments: () => [...promptTemplateKeys.root, 'departments'] as const,
};

/**
 * Eval-gated promotion query-key factory — rooted separately at
 * ['prompt-template-eval'] so `useRunGoldenSetEval`'s invalidation never touches the
 * unrelated PromptTemplate cache above.
 */
export const promptTemplateEvalKeys = {
  root: ['prompt-template-eval'] as const,
  goldenSets: (params?: ListEvalGoldenSetsParams) => [...promptTemplateEvalKeys.root, 'golden-sets', params ?? {}] as const,
  goldenCases: (goldenSetId: string, params?: ListEvalGoldenCasesParams) =>
    [...promptTemplateEvalKeys.root, 'golden-cases', goldenSetId, params ?? {}] as const,
  evalRuns: (params?: ListAgentEvalRunsParams) => [...promptTemplateEvalKeys.root, 'eval-runs', params ?? {}] as const,
};
