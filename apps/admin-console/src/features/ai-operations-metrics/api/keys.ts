import type { GenerationMetricsParams, ListSessionsParams } from './types';

export const aiMetricsKeys = {
  root: ['ai-operations-metrics'] as const,
  sessions: (params?: ListSessionsParams) => [...aiMetricsKeys.root, 'sessions', params ?? {}] as const,
  steps: (sessionId: string, runId: string) => [...aiMetricsKeys.root, 'steps', sessionId, runId] as const,
  generation: (params?: GenerationMetricsParams) => [...aiMetricsKeys.root, 'generation', params ?? {}] as const,
  gateQueue: () => [...aiMetricsKeys.root, 'gate-queue'] as const,
};
