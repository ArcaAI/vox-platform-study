'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';

export interface TagSuggestion {
  tag: string;
  count: number;
}

const TAGS_PATH = 'admin/prompt-templates/tags';

/**
 * Ranked distinct tags over the caller tenant's prompts, filtered by `q`
 * (case-insensitive substring, server-side). Held off until the combobox opens.
 */
export function useTagSuggestions(q: string, enabled: boolean, path: string = TAGS_PATH) {
  const trimmed = q.trim();
  return useQuery({
    // The path is part of the key: two suggestion sources (prompts, agents) must never share a cache entry.
    queryKey: path === TAGS_PATH ? (['prompt-templates', 'tags', trimmed] as const) : (['tag-suggestions', path, trimmed] as const),
    queryFn: () => getJson<TagSuggestion[]>(path, { q: trimmed || undefined, limit: 20 }),
    enabled,
    placeholderData: keepPreviousData,
  });
}
