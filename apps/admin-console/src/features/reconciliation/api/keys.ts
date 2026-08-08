export const reconciliationKeys = {
  root: ['reconciliation'] as const,
  runs: (params?: Record<string, unknown>) => ['reconciliation', 'runs', params ?? {}] as const,
  latest: () => ['reconciliation', 'latest'] as const,
};
