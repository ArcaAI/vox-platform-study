export const securityPolicyKeys = {
  root: ['security-policy'] as const,
  policy: () => [...securityPolicyKeys.root, 'policy'] as const,
  /** TASK-886 — per-tenant guardrail availability, keyed by the tenant read. */
  guardrailCatalogue: () => [...securityPolicyKeys.root, 'guardrail', 'catalogue'] as const,
  guardrailAvailability: (tenantId: string) => [...securityPolicyKeys.root, 'guardrail', 'availability', tenantId] as const,
};
