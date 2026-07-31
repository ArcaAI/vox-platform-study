'use client';

import { useQuery } from '@tanstack/react-query';
import { getProviderConnection } from './providers-client';
import { providerConnectionKeys } from './providers-keys';
import type { CloudByoProvider } from './providers-types';

// The BYO LLM credential WRITE surface moved to the `/ai-providers` feature (the
// one authoritative editor, rule 13). This lane is read-only now: the
// `/ai-configuration` "Cloud credentials" tab renders a masked status summary.
export function useProviderConnection(provider: CloudByoProvider) {
  return useQuery({
    queryKey: providerConnectionKeys.row(provider),
    queryFn: () => getProviderConnection(provider),
  });
}
