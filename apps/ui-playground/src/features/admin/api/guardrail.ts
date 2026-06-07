import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * TASK-338 — a Guardrail provider entry returned by
 * `GET /api/v1/text/guardrail-providers`. Mirrors the SMR `SmrProvider`
 * shape so the admin console can reuse the same provider/model selector
 * pattern. `is_default` marks the tenant's currently-selected provider.
 */
export interface GuardrailProvider {
  name: string;
  models: Array<string | { name?: string; id?: string; size?: string }>;
  is_available: boolean;
  is_default?: boolean;
  default_model?: string;
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

const guardrailKeys = {
  all: ['admin', 'guardrail'] as const,
  providers: () => [...guardrailKeys.all, 'providers'] as const,
};

/**
 * Fetch the configured Guardrail providers/models for the active tenant
 * (admin console). Backed by the API gateway, which derives the list from the
 * tenant's `guardrail-provider-models` catalog + `default-guardrail-*` settings.
 */
export function useGuardrailProviders(options?: Omit<UseQueryOptions<GuardrailProvider[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: guardrailKeys.providers(),
    queryFn: () => adminClient.get<GuardrailProvider[]>('/text/guardrail-providers'),
    staleTime: 60_000,
    retry: 1,
    ...options,
  });
}

export { guardrailKeys };
