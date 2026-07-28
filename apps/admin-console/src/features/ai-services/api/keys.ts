import type { AgenticInstructionsParams } from './types';

export const aiServicesKeys = {
  root: ['ai-services'] as const,
  guardrailStatus: () => [...aiServicesKeys.root, 'guardrail', 'status'] as const,
  guardrailConfig: () => [...aiServicesKeys.root, 'guardrail', 'config'] as const,
  nlpStatus: () => [...aiServicesKeys.root, 'nlp', 'status'] as const,
  // Tenant-scoped read — the working tenant is part of the key so switching
  // tenants refetches rather than serving the previous tenant's document.
  instructions: (params: AgenticInstructionsParams) => [...aiServicesKeys.root, 'instructions', params] as const,
};
