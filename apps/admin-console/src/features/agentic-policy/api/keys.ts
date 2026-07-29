export const agenticPolicyKeys = {
  root: ['agentic-policy'] as const,
  globalPolicy: () => [...agenticPolicyKeys.root, 'global'] as const,
  liveConfig: () => [...agenticPolicyKeys.root, 'live-config'] as const,
  catalog: () => [...agenticPolicyKeys.root, 'catalog'] as const,
  /** One registry setting's effective value + backing-row version. */
  registrySetting: (key: string) => [...agenticPolicyKeys.root, 'registry', key] as const,
};
