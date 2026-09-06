/**
 * TASK-890 J1 MINOR-7 — the last inventory report is FETCHED, not remembered.
 *
 * `useLastInventoryReport` was a session-only cache slot: `enabled: false` with
 * a `queryFn` that resolved `null`, populated only by `useRunModelInventory`'s
 * `setQueryData`. So on a fresh load `lastInventory.data` was `undefined`, the
 * "In bucket, not registered" button stayed disabled, and the only way to fill
 * it was to re-run a full bucket sweep — one listing plus a manifest read per
 * published row — for a list the gateway already had.
 *
 * Two clauses, and the second is the one that keeps the fix honest: a run must
 * still write into the SAME cache key, or the report the operator just produced
 * would be discarded in favour of a re-fetch.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLastInventoryReport, useRunModelInventory } from '../hooks';
import { aiModelKeys } from '../keys';

vi.mock('../client', () => ({
  getLastModelInventory: vi.fn(),
  runModelInventory: vi.fn(),
}));

const REPORT = {
  checkedAt: '2026-09-06T10:00:00.000Z',
  counts: { available: 2, missing: 1, partial: 0, notApplicable: 0 },
  rows: [],
  unregistered: [{ prefix: 'whisper/v1/', slug: 'whisper', version: 'v1', objects: 3, totalBytes: 10 }],
};

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useLastInventoryReport', () => {
  it('fetches the stored report on mount, so a fresh load has it', async () => {
    const { getLastModelInventory } = await import('../client');
    vi.mocked(getLastModelInventory).mockResolvedValue(REPORT as never);

    const { result } = renderHook(() => useLastInventoryReport(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.data).toEqual(REPORT));
    expect(getLastModelInventory).toHaveBeenCalledTimes(1);
  });

  it('reports null when the platform has stored none — a real answer, not an empty bucket', async () => {
    const { getLastModelInventory } = await import('../client');
    vi.mocked(getLastModelInventory).mockResolvedValue(null);

    const { result } = renderHook(() => useLastInventoryReport(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('is superseded by a run, which writes the fresh report into the same cache key', async () => {
    const { getLastModelInventory, runModelInventory } = await import('../client');
    vi.mocked(getLastModelInventory).mockResolvedValue(null);
    vi.mocked(runModelInventory).mockResolvedValue(REPORT as never);
    const client = makeClient();

    const { result } = renderHook(() => ({ last: useLastInventoryReport(), run: useRunModelInventory() }), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.last.isSuccess).toBe(true));
    result.current.run.mutate(undefined);

    await waitFor(() => expect(client.getQueryData(aiModelKeys.inventory())).toEqual(REPORT));
  });
});
