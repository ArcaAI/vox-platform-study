export const playgroundLlmKeys = {
  root: ['playground-llm'] as const,
  /** Catalog reads; `tenantKey` separates the __GLOBAL__ view (GLOBAL_ADMIN only). */
  providers: (tenantKey?: string) => [...playgroundLlmKeys.root, 'providers', tenantKey ?? 'tenant'] as const,
  guardrailProviders: (tenantKey?: string) => [...playgroundLlmKeys.root, 'guardrail-providers', tenantKey ?? 'tenant'] as const,
  /** Post-mortem task read after a dropped/failed stream. */
  task: (taskId: string) => [...playgroundLlmKeys.root, 'task', taskId] as const,
};
