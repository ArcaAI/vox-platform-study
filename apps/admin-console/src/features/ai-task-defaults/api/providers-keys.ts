import type { CloudByoProvider } from './providers-types';

/** Query keys for the tenant BYO cloud-credential lane. */
export const providerConnectionKeys = {
  root: ['ai-provider-connections'] as const,
  row: (provider: CloudByoProvider) => [...providerConnectionKeys.root, 'row', provider] as const,
};
