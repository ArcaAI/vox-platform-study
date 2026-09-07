/**
 * useSandboxNodeStates tests (TASK-893 Contract C). The interesting behaviour here is the
 * documented gap in `../hooks.ts`'s own doc comment: `RunNodeRollup` carries no graph node id on
 * the wire today, so this hook must return an EMPTY map for every real trace rather than guess
 * from `nodeType`/`order` (which would risk attributing a run state to the wrong node). The
 * forward-compatible path — a row that DOES carry `nodeId` — is covered too, so the day the
 * gateway starts sending one this hook is already proven to light up correctly.
 */
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/test/render';
import { useSandboxNodeStates } from '../hooks';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function stubTrace(nodes: Record<string, unknown>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        run: { id: 'run-1', status: 'COMPLETED', isSandbox: true },
        nodes,
        stepCount: nodes.length,
        truncated: false,
        tracePruned: false,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSandboxNodeStates', () => {
  it('returns an empty map when runId is null, without fetching', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useSandboxNodeStates(null), { wrapper });

    expect(result.current.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map for a real trace today — no row carries a wire nodeId', async () => {
    stubTrace([
      {
        nodeType: 'summarize',
        order: 1,
        status: 'OK',
        startedAt: '2026-08-23T10:00:00.000Z',
        endedAt: '2026-08-23T10:00:01.000Z',
        durationMs: 1000,
        errorCode: null,
        attemptSeqs: [1],
        attemptCount: 1,
        attemptGroupingIsDerived: true,
        // no nodeId — this is every gateway response today.
      },
    ]);

    const { result } = renderHook(() => useSandboxNodeStates('run-1'), { wrapper });

    // Proves the hook actually queries (not trivially disabled) — the map stays empty either way.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  it('maps a row to its state and duration once the wire carries a nodeId (forward-compatible)', async () => {
    stubTrace([
      {
        nodeType: 'summarize',
        order: 1,
        status: 'OK',
        startedAt: '2026-08-23T10:00:00.000Z',
        endedAt: '2026-08-23T10:00:01.000Z',
        durationMs: 1000,
        errorCode: null,
        attemptSeqs: [1],
        attemptCount: 1,
        attemptGroupingIsDerived: true,
        nodeId: 'canvas-node-7',
      },
      {
        nodeType: 'guardrail',
        order: 2,
        status: 'ERROR',
        startedAt: '2026-08-23T10:00:01.000Z',
        endedAt: '2026-08-23T10:00:02.000Z',
        durationMs: 500,
        errorCode: 'TEXT_TIMEOUT',
        attemptSeqs: [2],
        attemptCount: 1,
        attemptGroupingIsDerived: true,
        nodeId: 'canvas-node-8',
      },
    ]);

    const { result } = renderHook(() => useSandboxNodeStates('run-1'), { wrapper });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('canvas-node-7')).toEqual({ state: 'ok', durationMs: 1000 });
    expect(result.current.get('canvas-node-8')).toEqual({ state: 'failed', durationMs: 500 });
  });
});
