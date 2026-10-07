export const securityPolicyKeys = {
  root: ['security-policy'] as const,
  policy: () => [...securityPolicyKeys.root, 'policy'] as const,
};
