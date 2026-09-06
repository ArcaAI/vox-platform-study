'use client';

/**
 * TanStack Query read for the shared prompt-template picker. A thin, cached
 * list read over `GET admin/prompt-templates` — never a mutation surface (the
 * one authoritative editor for prompt templates stays `/prompt-templates`,
 * rule 13).
 */

import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';
import type { Paginated } from '@/shared/api';
import type { PromptPickerTemplate } from './types';

const PICKER_STALE_MS = 60 * 1000;
/** A tenant's prompt library is a small reference list; one page covers it. */
const PICKER_LIMIT = 200;

export interface PromptPickerListParams {
  category?: string;
  /** Filter to templates a resolver could actually serve today. */
  status?: PromptPickerTemplate['status'];
}

/** Options for the `<PromptTemplatePicker>` select, newest-content-first is not assumed — server order stands. */
export function usePromptTemplateOptions(params?: PromptPickerListParams) {
  return useQuery({
    queryKey: ['prompt-picker', 'list', params ?? {}],
    queryFn: () => getJson<Paginated<PromptPickerTemplate>>('admin/prompt-templates', { ...params, limit: PICKER_LIMIT }),
    staleTime: PICKER_STALE_MS,
    select: (res) => res.data,
  });
}

/** One template's quick-view projection, once a value is selected. */
export function usePromptTemplateQuickView(id: string | null) {
  return useQuery({
    queryKey: ['prompt-picker', 'detail', id],
    queryFn: () => getJson<PromptPickerTemplate>(`admin/prompt-templates/${encodeURIComponent(id as string)}`),
    enabled: !!id,
    staleTime: PICKER_STALE_MS,
  });
}
