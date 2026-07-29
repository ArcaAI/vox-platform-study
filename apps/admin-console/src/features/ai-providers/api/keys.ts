import type { ProviderService } from './types';

/** Query keys for the unified tenant BYO cloud-credential lane. */
export const providerConnectionKeys = {
  root: ['ai-providers'] as const,
  service: (service: ProviderService) => [...providerConnectionKeys.root, service] as const,
  row: (service: ProviderService, provider: string) => [...providerConnectionKeys.service(service), 'row', provider] as const,
};
