'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acknowledgeChangelog,
  createChangelogEntry,
  getChangelogEntryWithEtag,
  listChangelog,
  listUnseenChangelog,
  publishChangelogEntry,
  updateChangelogEntry,
} from './client';
import { changelogKeys } from './keys';
import type { ChangelogSeverity, CreateChangelogEntryRequest, UpdateChangelogEntryRequest } from './types';

/**
 * Drives the one-time What's New dialog. Callers gate rendering on
 * impersonation and on "already shown this session" themselves — this hook
 * only fetches. Disabled entirely via `enabled` while impersonating.
 */
export function useUnseenChangelog(enabled: boolean) {
  return useQuery({ queryKey: changelogKeys.unseen(), queryFn: listUnseenChangelog, enabled, staleTime: Number.POSITIVE_INFINITY });
}

export function useAcknowledgeChangelog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryIds: string[]) => acknowledgeChangelog(entryIds),
    onSuccess: () => {
      queryClient.setQueryData(changelogKeys.unseen(), []);
      void queryClient.invalidateQueries({ queryKey: changelogKeys.all });
    },
  });
}

export function useChangelogList(params?: { severity?: ChangelogSeverity; page?: number; version?: string }) {
  return useQuery({ queryKey: changelogKeys.list(params), queryFn: () => listChangelog(params) });
}

export function useChangelogEntryWithEtag(id: string | null) {
  return useQuery({
    queryKey: id ? changelogKeys.detail(id) : changelogKeys.detail('__none__'),
    queryFn: () => getChangelogEntryWithEtag(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateChangelogEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChangelogEntryRequest) => createChangelogEntry(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: changelogKeys.all }),
  });
}

export function useUpdateChangelogEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, etag }: { id: string; body: UpdateChangelogEntryRequest; etag: string }) => updateChangelogEntry(id, body, etag),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: changelogKeys.all }),
  });
}

export function usePublishChangelogEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag }: { id: string; etag: string }) => publishChangelogEntry(id, etag),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: changelogKeys.all }),
  });
}
