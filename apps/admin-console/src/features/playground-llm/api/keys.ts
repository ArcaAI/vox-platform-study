export const playgroundLlmKeys = {
  root: ['playground-llm'] as const,
  /** Catalog reads; `tenantKey` separates the __GLOBAL__ view (SUPER_ADMIN only). */
  providers: (tenantKey?: string) => [...playgroundLlmKeys.root, 'providers', tenantKey ?? 'tenant'] as const,
  guardrailProviders: (tenantKey?: string) => [...playgroundLlmKeys.root, 'guardrail-providers', tenantKey ?? 'tenant'] as const,
  /** Post-mortem task read after a dropped/failed stream. */
  task: (taskId: string) => [...playgroundLlmKeys.root, 'task', taskId] as const,
  /** Template picker search (assembled mode). */
  templates: (params?: { search?: string; limit?: number; page?: number }) => [...playgroundLlmKeys.root, 'templates', params ?? {}] as const,
};
