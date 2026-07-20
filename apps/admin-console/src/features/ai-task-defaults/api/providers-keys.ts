import type { CloudByoProvider } from './providers-types';

/** TASK-526 — query keys for the tenant BYO cloud-credential lane. */
export const providerConnectionKeys = {
  root: ['ai-provider-connections'] as const,
  row: (provider: CloudByoProvider) => [...providerConnectionKeys.root, 'row', provider] as const,
};
