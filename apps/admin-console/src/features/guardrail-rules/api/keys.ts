export const guardrailRulesKeys = {
  root: ['guardrail-rules'] as const,
  policy: (tenantId: string) => [...guardrailRulesKeys.root, 'policy', tenantId] as const,
};
