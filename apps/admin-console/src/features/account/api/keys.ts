export const accountKeys = {
  root: ['account'] as const,
  tenant: () => [...accountKeys.root, 'tenant'] as const,
  entitlements: () => [...accountKeys.root, 'entitlements'] as const,
  settings: () => [...accountKeys.root, 'settings'] as const,
  preferences: () => [...accountKeys.root, 'preferences'] as const,
  departments: () => [...accountKeys.root, 'departments'] as const,
};
