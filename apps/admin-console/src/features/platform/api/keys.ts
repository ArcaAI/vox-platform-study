export const platformKeys = {
  root: ['platform'] as const,
  metrics: () => [...platformKeys.root, 'metrics'] as const,
  sockets: () => [...platformKeys.root, 'sockets'] as const,
  consumption: (tenantId?: string) => [...platformKeys.root, 'consumption', tenantId ?? null] as const,
  tenantUsage: (tenantId: string | null) => [...platformKeys.root, 'tenant-usage', tenantId] as const,
};
