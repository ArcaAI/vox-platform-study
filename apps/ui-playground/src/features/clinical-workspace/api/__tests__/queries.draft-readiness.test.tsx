/**
 * useDraftReadiness tests (TASK-339 FU2) — polling-until-ready + transition.
 *
 * The query layer is mocked: `@tanstack/react-query`'s `useQuery` is replaced
 * with a controllable stub that records the options it receives (so we can probe
 * the `refetchInterval` the hook installs) and returns the data we drive. We then
 * assert the hook (a) reports "generating" and keeps polling while waiting with no
 * draft, (b) stops polling (refetchInterval → false) and transitions to "ready"
 * once the RAW_SUMMARY draft appears, and (c) is idle before a recording stops.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  data: [] as any[],
  lastOptions: undefined as any,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: any) => {
    h.lastOptions = options;
    return { data: h.data, refetch: h.refetch, isLoading: false, isError: false, isFetching: false };
  },
}));

vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: any) => selector({ apiClient: { __fake: true } }),
}));

vi.mock('../clinical-workspace.api', () => ({
  fetchContextItems: vi.fn(),
  fetchRecordings: vi.fn(),
  fetchProvenance: vi.fn(),
}));

import { useDraftReadiness } from '../queries';
import type { WorkspaceContextItem } from '../../types';

const draftItem: WorkspaceContextItem = { id: 'raw-1', type: 'RAW_SUMMARY', content: 'S: ...', createdAt: '2026-06-08T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.lastOptions = undefined;
});

describe('useDraftReadiness — polling until ready', () => {
  it('reports "generating" and keeps polling while waiting with no draft', () => {
    const { result } = renderHook(() => useDraftReadiness({ consultationId: 'c1', waiting: true }));

    expect(result.current.status).toBe('generating');
    expect(result.current.noteId).toBeNull();

    const interval = h.lastOptions.refetchInterval({ state: { data: [] } });
    expect(typeof interval).toBe('number');
    expect(interval).toBeGreaterThan(0);
  });

  it('stops polling and is "ready" once the draft is present', () => {
    h.data = [draftItem];
    const { result } = renderHook(() => useDraftReadiness({ consultationId: 'c1', waiting: true }));

    expect(result.current.noteId).toBe('raw-1');
    expect(result.current.status).toBe('ready');

    // refetchInterval returns false (stop) as soon as the draft is in the query data.
    expect(h.lastOptions.refetchInterval({ state: { data: [draftItem] } })).toBe(false);
  });

  it('is idle and never polls before a recording has stopped', () => {
    const { result } = renderHook(() => useDraftReadiness({ consultationId: 'c1', waiting: false }));

    expect(result.current.status).toBe('idle');
    expect(h.lastOptions.refetchInterval({ state: { data: [] } })).toBe(false);
  });

  it('transitions generating → ready when the draft arrives on a later poll', () => {
    const { result, rerender } = renderHook(({ waiting }: { waiting: boolean }) => useDraftReadiness({ consultationId: 'c1', waiting }), {
      initialProps: { waiting: true },
    });
    expect(result.current.status).toBe('generating');

    h.data = [draftItem];
    rerender({ waiting: true });

    expect(result.current.status).toBe('ready');
    expect(result.current.noteId).toBe('raw-1');
    expect(h.lastOptions.refetchInterval({ state: { data: [draftItem] } })).toBe(false);
  });
});
