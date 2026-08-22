export const rateLimitKeys = {
  root: ['rate-limits'] as const,
  policy: () => [...rateLimitKeys.root, 'policy'] as const,
};

export const rateLimitRuleKeys = {
  root: ['rate-limit-rules'] as const,
  list: (scope?: string, tenantId?: string) => [...rateLimitRuleKeys.root, 'list', scope ?? 'all', tenantId ?? '-'] as const,
  routes: () => [...rateLimitRuleKeys.root, 'routes'] as const,
  explain: (tenantId: string | null, method: string, path: string) => [...rateLimitRuleKeys.root, 'explain', tenantId ?? '-', method, path] as const,
};

export const rateLimitPlanKeys = {
  root: ['rate-limit-plans'] as const,
  list: () => [...rateLimitPlanKeys.root, 'list'] as const,
};

export const rateLimitTenantKeys = {
  options: () => ['rate-limit-tenant-options'] as const,
};
