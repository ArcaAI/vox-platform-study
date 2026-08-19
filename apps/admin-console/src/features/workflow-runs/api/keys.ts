import type { ListWorkflowRunsParams } from './types';

export const workflowRunsKeys = {
  root: ['workflow-runs'] as const,
  list: (params?: ListWorkflowRunsParams) => [...workflowRunsKeys.root, 'list', params ?? {}] as const,
  detail: (runId: string) => [...workflowRunsKeys.root, 'detail', runId] as const,
  trace: (runId: string) => [...workflowRunsKeys.root, 'trace', runId] as const,
  gate: (runId: string) => [...workflowRunsKeys.root, 'gate', runId] as const,
  definitionVersion: (workflowVersionId: string) => [...workflowRunsKeys.root, 'definition-version', workflowVersionId] as const,
};
