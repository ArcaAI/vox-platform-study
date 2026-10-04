'use client';

/**
 * The latest Test-tab run of each workflow definition (TASK-1036 §10.1 "Last run in the
 * inspector"). Held in the TanStack Query cache — memory only, never `localStorage` (a trace holds
 * PHI) — so the Composer's inspector, the picker samples and a remounted Test tab all read the
 * SAME entry the Test tab writes. Nothing fetches it: the Test tab is its only writer.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { sandboxKeys } from './keys';
import type { SandboxNodeLastRun } from './run-fold';

export interface LatestSandboxRun {
  runId: string | null;
  /** Per-node feed of the latest COMPLETED run (empty while the first run is still going). */
  nodes: Record<string, SandboxNodeLastRun>;
}

const EMPTY: LatestSandboxRun = Object.freeze({ runId: null, nodes: Object.freeze({}) }) as LatestSandboxRun;

export function rememberLatestSandboxRun(queryClient: QueryClient, definitionId: string, run: LatestSandboxRun): void {
  queryClient.setQueryData(sandboxKeys.latestRun(definitionId), run);
}

export function useLatestSandboxRun(definitionId: string): LatestSandboxRun {
  const queryClient = useQueryClient();
  const key = sandboxKeys.latestRun(definitionId);
  const query = useQuery({
    queryKey: key,
    // Client-held: "fetching" only ever returns what the cache already holds.
    queryFn: () => queryClient.getQueryData<LatestSandboxRun>(key) ?? EMPTY,
    // Seeded, so a first mount never fetches — an in-flight "fetch" resolving AFTER the Test tab's
    // write would otherwise overwrite it with the empty value.
    initialData: EMPTY,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    enabled: definitionId.length > 0,
  });
  return query.data ?? EMPTY;
}

/** For writers that want the hook form. */
export function useRememberLatestSandboxRun(): (definitionId: string, run: LatestSandboxRun) => void {
  const queryClient = useQueryClient();
  return (definitionId, run) => rememberLatestSandboxRun(queryClient, definitionId, run);
}
