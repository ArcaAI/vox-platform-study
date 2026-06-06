import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { smrClient } from './smr-client';
// Type-only reuse — the end-user template shape is identical to the admin one.
// We deliberately import ONLY the types (no admin hooks / endpoints) so the
// clinician plane never reaches `/admin/prompt-templates`.
import type { PromptTemplate, PromptTemplateCategory } from '@/features/admin/api/prompts';

export type { PromptTemplate, PromptTemplateCategory } from '@/features/admin/api/prompts';

/**
 * TASK-331 doc-09 — clinician-facing prompt-template list.
 *
 * The Pre-Summary / Summary template selector must consume the END-USER plane,
 * `GET /prompt-templates/available`, served by the `PromptTemplateController`.
 * It returns the tenant + department defaults plus the caller's OWN personal
 * templates and requires only `read:PromptTemplate` (the clinician policy).
 *
 * This is the fix for the impersonated/direct doctor being bounced to `/403`:
 * the previous wiring used the admin `usePromptTemplates` hook → `adminClient`
 * → `/admin/prompt-templates`, which requires `manage:PromptTemplate`.
 *
 * The request is issued through `smrClient`, which (like `adminClient`) sends
 * the effective impersonation token + `X-Tenant-Id`, so it stays in the
 * impersonated tenant. The endpoint returns a plain array.
 */

interface AvailablePromptParams {
  category?: PromptTemplateCategory;
}

const AVAILABLE_STALE_TIME_MS = 60_000;
const AVAILABLE_GC_TIME_MS = 10 * 60_000;

const keys = {
  available: (tenantId?: string, params?: AvailablePromptParams) => ['summarization', 'prompts', 'available', tenantId ?? '', params ?? {}] as const,
};

function qs(params?: AvailablePromptParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export function usePromptTemplatesAvailable(
  tenantId: string,
  params?: AvailablePromptParams,
  options?: Omit<UseQueryOptions<PromptTemplate[]>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.available(tenantId, params),
    queryFn: () => smrClient.get<PromptTemplate[]>(`/prompt-templates/available${qs(params)}`),
    enabled: !!tenantId,
    staleTime: AVAILABLE_STALE_TIME_MS,
    gcTime: AVAILABLE_GC_TIME_MS,
    ...options,
  });
}

export { keys as availablePromptKeys };
