import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from '@/features/admin/api/admin-client';
// Type-only reuse — the doctor "My Prompts" template shape is identical to the
// admin one (plus `scope`, surfaced in Phase 6). We import ONLY the types so the
// doctor plane never reaches `/admin/prompt-templates`.
import type { CreatePromptInput, PromptTemplate, PromptTemplateCategory } from '@/features/admin/api/prompts';

export type { PromptTemplate, PromptTemplateCategory } from '@/features/admin/api/prompts';

/** TASK-356 Phase 6 — scope marking the caller's OWN editable personal prompts. */
export const USER_PERSONAL_SCOPE = 'USER_PERSONAL';

export interface PreferredPromptTemplate {
  preferredPromptTemplateId: string | null;
}

export interface UpdatePersonalPromptInput {
  id: string;
  content?: string;
  description?: string;
  tags?: string[];
  changeReason?: string;
  // Echoed from the loaded template's `version` (OCC). Sent both as the body
  // `expectedVersion` and the RFC 7232 `If-Match: "<v>"` header (the route is
  // `@RequiresIfMatch()`; the header wins server-side).
  expectedVersion: number;
}

/** A prompt the caller may use; `scope === USER_PERSONAL` ⇒ owned + editable. */
export type AvailablePrompt = PromptTemplate & { scope?: string };

const keys = {
  all: ['my-prompts'] as const,
  available: (category?: string) => [...keys.all, 'available', category ?? ''] as const,
};

function qs(category?: string): string {
  return category ? `?category=${encodeURIComponent(category)}` : '';
}

/** TASK-356 Phase 6 (S1) — list templates the caller may use (defaults + own personals). */
export function useAvailablePrompts(
  category?: PromptTemplateCategory,
  options?: Omit<UseQueryOptions<AvailablePrompt[]>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.available(category),
    queryFn: () => adminClient.get<AvailablePrompt[]>(`/prompt-templates/available${qs(category)}`),
    ...options,
  });
}

/** TASK-356 Phase 6 (S1) — create a personal prompt owned by the caller. */
export function useCreatePersonalPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePromptInput) => adminClient.post<PromptTemplate>('/prompt-templates', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

/** TASK-356 Phase 6 (S1) — update a personal prompt the caller owns (OCC). */
export function useUpdatePersonalPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedVersion, ...body }: UpdatePersonalPromptInput) =>
      adminClient.patch<PromptTemplate>(`/prompt-templates/${id}`, { ...body, expectedVersion }, { ifMatch: `"${expectedVersion}"` }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

/** TASK-356 Phase 6 (S1) — soft-delete a personal prompt the caller owns. */
export function useDeletePersonalPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<PromptTemplate>(`/prompt-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

/** TASK-356 Phase 6 (S2) — set (or clear with null) the caller's preferred template. */
export function useSetPreferredPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string | null) => adminClient.put<PreferredPromptTemplate>('/prompt-templates/preferred', { templateId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

export { keys as myPromptKeys };
