export const harnessPolicyKeys = {
  root: ['harness-policy'] as const,
  policy: () => [...harnessPolicyKeys.root, 'policy'] as const,
  globalPolicy: () => [...harnessPolicyKeys.root, 'global'] as const,
  liveConfig: () => [...harnessPolicyKeys.root, 'live-config'] as const,
};
