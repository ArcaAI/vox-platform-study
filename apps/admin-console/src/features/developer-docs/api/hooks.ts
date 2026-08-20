'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * The gateway's own reported build version, from its public `GET /health`.
 *
 * The portal shows it because a developer must be able to tell WHICH build the
 * reference in front of them describes. It deliberately does not come from the
 * OpenAPI document's `info.version`: that is the CONTRACT version and is a
 * committed constant, because `openapi.json` is drift-gated and could not be
 * reproducible otherwise (see `apps/api/src/swagger.config.ts`). Build identity
 * is a property of the running image, so it is read from the running image.
 */
export function useGatewayVersion() {
  return useQuery({
    queryKey: ['developer-docs', 'gateway-version'],
    queryFn: async (): Promise<string | null> => {
      const response = await fetch('/api/hope/health', { cache: 'no-store' });
      if (!response.ok) return null;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === 'string' ? body.version : null;
    },
    staleTime: 5 * 60 * 1000,
  });
}
