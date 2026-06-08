/**
 * TanStack Query hooks for the clinical workspace (TASK-330 P3).
 *
 * Server reads (context items, recordings, provenance) go through React Query so
 * the cockpit/artifacts/review panels get caching, loading/error states, and
 * imperative refetch. The SDK `apiClient` is pulled from the store and passed to
 * the thin api wrappers.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { useArcaStore, type AgenticClient } from '@arcaai/vox';
import { fetchContextItems, fetchProvenance, fetchRecordings } from './clinical-workspace.api';
import { selectLatestNote } from '../lib/artifacts';
import { type DraftWaitStatus, draftWaitStatus, nextDraftPollInterval } from '../lib/draft-polling';
import type { AudioRecordingItem, SummaryProvenanceResponse, WorkspaceContextItem } from '../types';

export const clinicalWorkspaceKeys = {
  context: (consultationId: string) => ['clinical-workspace', 'context', consultationId] as const,
  recordings: (consultationId: string) => ['clinical-workspace', 'recordings', consultationId] as const,
  provenance: (consultationId: string, noteId: string) => ['clinical-workspace', 'provenance', consultationId, noteId] as const,
};

type ContextQueryOptions = Pick<UseQueryOptions<WorkspaceContextItem[]>, 'refetchInterval'>;

export function useContextItemsQuery(consultationId: string | null, options?: ContextQueryOptions): UseQueryResult<WorkspaceContextItem[]> {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  return useQuery({
    queryKey: clinicalWorkspaceKeys.context(consultationId ?? 'none'),
    queryFn: () => fetchContextItems(apiClient!, consultationId!),
    enabled: !!apiClient && !!consultationId,
    ...options,
  });
}

export function useRecordingsQuery(consultationId: string | null): UseQueryResult<AudioRecordingItem[]> {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  return useQuery({
    queryKey: clinicalWorkspaceKeys.recordings(consultationId ?? 'none'),
    queryFn: () => fetchRecordings(apiClient!, consultationId!),
    enabled: !!apiClient && !!consultationId,
  });
}

export function useProvenanceQuery(consultationId: string | null, noteContextItemId: string | null): UseQueryResult<SummaryProvenanceResponse> {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  return useQuery({
    queryKey: clinicalWorkspaceKeys.provenance(consultationId ?? 'none', noteContextItemId ?? 'none'),
    queryFn: () => fetchProvenance(apiClient!, consultationId!, noteContextItemId!),
    enabled: !!apiClient && !!consultationId && !!noteContextItemId,
  });
}

export interface DraftReadiness {
  /** The consultation's context items (the artifact source the draft appears in). */
  items: WorkspaceContextItem[];
  /** The most authoritative drafted note, once one exists. */
  note: WorkspaceContextItem | null;
  noteId: string | null;
  /** Coarse status for the review surface: idle | generating | ready | timed-out. */
  status: DraftWaitStatus;
  /** Force an immediate re-check (manual refresh). */
  refetch: () => void;
}

/**
 * Draft-ready polling (TASK-339 FU2).
 *
 * After recording stops the harness drafts the SOAP asynchronously. While
 * `waiting`, this polls the consultation's context items (the same signal the
 * page already uses to detect the draft) on a backing-off interval and STOPS as
 * soon as the draft (a RAW_SUMMARY/MODIFIED_SUMMARY note) appears — or after a
 * hard timeout, so it never polls forever. It exposes the detected note plus a
 * coarse status the review surface renders ("generating draft…" → ready).
 */
export function useDraftReadiness({ consultationId, waiting }: { consultationId: string | null; waiting: boolean }): DraftReadiness {
  const startedAtRef = useRef<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Open the poll window when we start waiting; close it when we stop.
  useEffect(() => {
    if (waiting && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
      setNowTick(Date.now());
    } else if (!waiting) {
      startedAtRef.current = null;
    }
  }, [waiting]);

  const query = useContextItemsQuery(consultationId, {
    refetchInterval: (q) => {
      const items = (q.state.data ?? []) as WorkspaceContextItem[];
      const draftReady = selectLatestNote(items) !== null;
      return nextDraftPollInterval({ waiting, draftReady, startedAt: startedAtRef.current, now: Date.now() });
    },
  });

  const items = useMemo(() => query.data ?? [], [query.data]);
  const note = useMemo(() => selectLatestNote(items), [items]);
  const noteId = note?.id ?? null;

  const status = draftWaitStatus({ waiting, draftReady: noteId !== null, startedAt: startedAtRef.current, now: nowTick });

  // Tick once a second while generating so the status can reach "timed-out"
  // (and the poll stop) even when no new data arrives to trigger a re-render.
  const generating = status === 'generating';
  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [generating]);

  return { items, note, noteId, status, refetch: () => void query.refetch() };
}
