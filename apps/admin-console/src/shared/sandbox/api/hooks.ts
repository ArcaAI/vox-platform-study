'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelSandboxRun,
  createFixture,
  deleteFixture,
  getRunTrace,
  getSandboxRunStatus,
  listFixtures,
  startSandboxRun,
  updateFixture,
} from './client';
import { sandboxKeys } from './keys';
import type { CreateFixtureBody, SandboxNodeRunState, StartSandboxRunBody, UpdateFixtureBody } from './types';

/** RUNNING is the only non-terminal status the interpreter reports — same set `useRunTrace`
 *  and `features/workflow-runs` poll against. */
function isNonTerminal(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.toUpperCase() === 'RUNNING';
}

const TRACE_POLL_INTERVAL_MS = 3000;

export function useFixtures(params?: { page?: number; limit?: number }) {
  return useQuery({
    queryKey: sandboxKeys.fixtures(params),
    queryFn: () => listFixtures(params ?? { limit: 100 }),
  });
}

export function useCreateFixture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFixtureBody) => createFixture(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sandboxKeys.root }),
  });
}

export function useUpdateFixture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateFixtureBody }) => updateFixture(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sandboxKeys.root }),
  });
}

export function useDeleteFixture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFixture(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sandboxKeys.root }),
  });
}

/** Starting a run is a TanStack mutation (rule 13 §Data & State); live progress after start is
 *  `useEventStream`, not this hook's polling — see `components/sandbox-run-panel.tsx`. */
export function useStartSandboxRun() {
  return useMutation({
    mutationFn: ({ definitionId, body }: { definitionId: string; body: StartSandboxRunBody }) => startSandboxRun(definitionId, body),
  });
}

export function useCancelSandboxRun() {
  return useMutation({
    mutationFn: ({ definitionId, runId }: { definitionId: string; runId: string }) => cancelSandboxRun(definitionId, runId),
  });
}

/** One-shot status read — used to seed the run panel before the SSE stream opens, and as the
 *  fallback if the stream never connects. Not the live-progress channel itself. */
export function useSandboxRunStatus(definitionId: string | null, runId: string | null) {
  return useQuery({
    queryKey: sandboxKeys.sandboxRunStatus(definitionId ?? '', runId ?? ''),
    queryFn: () => getSandboxRunStatus(definitionId as string, runId as string),
    enabled: !!definitionId && !!runId,
  });
}

/**
 * The per-node inspector's data source — reuses `admin/workflow-runs/:runId/trace`
 * verbatim: a sandbox run is a `WorkflowRun` row like any other. Polls while the
 * run is live, matching `features/workflow-runs`' own cadence.
 */
export function useRunTrace(runId: string | null) {
  return useQuery({
    queryKey: sandboxKeys.runTrace(runId ?? ''),
    queryFn: () => getRunTrace(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => (isNonTerminal(query.state.data?.run.status) ? TRACE_POLL_INTERVAL_MS : false),
    refetchIntervalInBackground: false,
  });
}

/** `RunNodeRollup.status` -> the canvas overlay's closed state union. An unrecognized wire status
 *  is omitted rather than guessed (the codebase-wide rule: absent renders nothing, never a
 *  fabricated value) — `SandboxNodeRunState` has no "unknown" member to hold it honestly. */
function toSandboxNodeRunState(status: string): SandboxNodeRunState | null {
  switch (status.toUpperCase()) {
    case 'STARTED':
      return 'running';
    case 'OK':
      return 'ok';
    case 'ERROR':
    case 'TIMEOUT':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
    default:
      return null;
  }
}

/**
 * Per-node state for the canvas overlay (Contract C, INTERFACES.md §5).
 *
 * **Structural gap, not a bug to silently "fix" here (TASK-893 Lane C finding, flagged to the
 * orchestrator).** The contract asks for a `Map` keyed by graph node id, but `RunNodeRollup`
 * (`../api/types.ts`) documents that the interpreter never stamps a node id onto a trajectory
 * row — only `nodeType` (the node's TYPE) and `order` (its position in the run's execution
 * sequence), neither of which is a `WorkflowCanvasNode.id`. Guessing from `nodeType`+`order`
 * would silently mis-attribute a run state to the WRONG node whenever a graph has two nodes of
 * the same type (routine) or a loop body (repeats a type at multiple positions) — exactly the
 * graphs this redesign makes easy to build (OD-5). This platform's own standing rule is that a
 * fabricated value is worse than an absent one, so this hook does not guess.
 *
 * What it does today: reads `RunNodeRollup.nodeId` (typed optional, see `../api/types.ts`) when
 * present and skips rows where it is not. That makes the map EMPTY under every trace the gateway
 * currently returns — the wiring is real and forward-compatible, but the overlay will not light
 * up until the interpreter starts stamping node ids on trajectory rows (or this hook's signature
 * is deliberately widened to accept the graph's own id/type list, which the contract's exact
 * one-argument signature does not allow this lane to do unilaterally).
 */
export function useSandboxNodeStates(runId: string | null): Map<string, { state: SandboxNodeRunState; durationMs?: number }> {
  const traceQuery = useRunTrace(runId);

  return useMemo(() => {
    const map = new Map<string, { state: SandboxNodeRunState; durationMs?: number }>();
    if (!runId || !traceQuery.data) return map;

    for (const node of traceQuery.data.nodes) {
      if (!node.nodeId) continue; // see doc comment above — not on the wire today
      const state = toSandboxNodeRunState(node.status);
      if (!state) continue;
      map.set(node.nodeId, { state, durationMs: node.durationMs ?? undefined });
    }
    return map;
  }, [runId, traceQuery.data]);
}
