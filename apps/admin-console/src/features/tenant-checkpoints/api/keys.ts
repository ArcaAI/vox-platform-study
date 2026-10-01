import type { ListParams } from '@/shared/api';

export const checkpointKeys = {
  root: ['tenant-checkpoints'] as const,
  tenant: (tenantId: string) => [...checkpointKeys.root, tenantId] as const,
  list: (tenantId: string, params?: ListParams) => [...checkpointKeys.tenant(tenantId), 'list', params ?? {}] as const,
  detail: (tenantId: string, id: string) => [...checkpointKeys.tenant(tenantId), 'detail', id] as const,
  restores: (tenantId: string, params?: ListParams) => [...checkpointKeys.tenant(tenantId), 'restores', params ?? {}] as const,
};
