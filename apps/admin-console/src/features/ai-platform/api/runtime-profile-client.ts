'use client';

/**
 * The runtime-tuning plane, READ ONLY.
 *
 * A deliberate, minimal copy of one GET — the same posture `model-store-client.ts`
 * and `shared/catalog/document-templates.ts` take, and for the same reason
 * (rule 13: features never import each other). `features/ai-runtime-profiles`
 * remains the one authoritative EDITOR; step 4 only retires it as a
 * top-level rail entry and re-homes its entry point inside the provider
 * configuration it tunes. This module never writes.
 */

import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';

export interface RuntimeProfileSummary {
  provider: string;
  modelSlug: string;
  version: number;
}

export function useRuntimeProfileSummary(enabled: boolean) {
  return useQuery({
    queryKey: ['ai-platform', 'runtime-profiles', 'summary'],
    queryFn: () => getJson<RuntimeProfileSummary[]>('admin/ai-runtime-profiles'),
    enabled,
    // Super-admin-only on the gateway; a tenant admin gets 403 and the section
    // says so once rather than retrying three times first.
    retry: false,
  });
}
