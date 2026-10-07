import type { GuardrailEvaluationQuery, GuardrailMetricsWindow } from './types';

export const guardrailControlKeys = {
  root: ['guardrail-control'] as const,
  catalogue: () => [...guardrailControlKeys.root, 'catalogue'] as const,
  availability: (tenantId: string) => [...guardrailControlKeys.root, 'availability', tenantId] as const,
  policyKeys: () => [...guardrailControlKeys.root, 'policy-keys'] as const,
  /** Prefix `revisions(key)` matches every row's history of `key`; a label threshold adds its row. */
  revisions: (key: string, taskKey?: string) => [...guardrailControlKeys.root, 'revisions', key, ...(taskKey ? [taskKey] : [])] as const,
  judgeMeta: (modelId: string) => [...guardrailControlKeys.root, 'judge-meta', modelId] as const,
  judgeLanes: () => [...guardrailControlKeys.root, 'judge-lanes'] as const,
  model: (modelId: string) => [...guardrailControlKeys.root, 'model', modelId] as const,
  activity: (window: GuardrailMetricsWindow) => [...guardrailControlKeys.root, 'metrics', 'activity', window] as const,
  performance: () => [...guardrailControlKeys.root, 'metrics', 'performance'] as const,
  health: () => [...guardrailControlKeys.root, 'metrics', 'health'] as const,
  evaluations: (query: GuardrailEvaluationQuery) => [...guardrailControlKeys.root, 'metrics', 'evaluations', query] as const,
};
