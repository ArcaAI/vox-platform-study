'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';

export interface TagSuggestion {
  tag: string;
  count: number;
}

const TAGS_PATH = 'admin/prompt-templates/tags';

/**
 * Ranked distinct tags over the caller tenant's Hope Prompts, filtered by `q`
 * (case-insensitive substring, server-side). Held off until the combobox opens.
 */
export function useTagSuggestions(q: string, enabled: boolean) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['prompt-templates', 'tags', trimmed] as const,
    queryFn: () => getJson<TagSuggestion[]>(TAGS_PATH, { q: trimmed || undefined, limit: 20 }),
    enabled,
    placeholderData: keepPreviousData,
  });
}
