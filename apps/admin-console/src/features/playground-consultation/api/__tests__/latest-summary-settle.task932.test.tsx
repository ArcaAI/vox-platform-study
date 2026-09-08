/**
 * TASK-932 R-16a — the draft pane learns that the durable finalizer landed the note.
 *
 * Under a governing tenant workflow the interpreter's `n_finalize` persists the note tens of
 * seconds AFTER `recording/stop` returns, through a gateway write that carries no summary-job
 * id — so no SSE reaches this screen and `useLatestSummary` (a plain query that 404'd at open)
 * was never refetched: the clinician kept seeing the live scratch view while the finished note
 * sat in the database. Observed live: consultation `PENDING_REVIEW`, `RAW_SUMMARY` persisted,
 * `GET summary/latest` answering the note, the column still on "Running SOAP".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINALIZE_SETTLE_WINDOW_MS, useLatestSummary } from '../hooks';
import { getLatestSummary } from '../client';

vi.mock('../client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client')>()),
  getLatestSummary: vi.fn(),
}));

const mockedGetLatestSummary = vi.mocked(getLatestSummary);

const NOTE = { id: 'note-1', consultationId: 'c-1', type: 'RAW_SUMMARY', content: 'S: chest pain', structuredData: { dnaStyleId: 'dna-1' } };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useLatestSummary — bounded polling after a stop (TASK-932 R-16a)', () => {
  beforeEach(() => {
    mockedGetLatestSummary.mockReset();
  });
  afterEach(() => cleanup());

  it('does not poll at all when no stop is being settled', async () => {
    mockedGetLatestSummary.mockResolvedValue(null);
    const { result } = renderHook(() => useLatestSummary('c-1', true, { pollMs: 10 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(mockedGetLatestSummary).toHaveBeenCalledTimes(1);
  });

  it('polls while the note is absent after a stop, then stops the moment a draft exists', async () => {
    mockedGetLatestSummary.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(NOTE as never);
    const { result } = renderHook(() => useLatestSummary('c-1', true, { awaitingFinalizeSince: Date.now(), pollMs: 10 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual(NOTE));
    expect(mockedGetLatestSummary.mock.calls.length).toBeGreaterThanOrEqual(3);

    const settled = mockedGetLatestSummary.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockedGetLatestSummary).toHaveBeenCalledTimes(settled);
  });

  it('gives up once the settle window has elapsed — a consultation that never finalizes is not polled forever', async () => {
    mockedGetLatestSummary.mockResolvedValue(null);
    const { result } = renderHook(
      () => useLatestSummary('c-1', true, { awaitingFinalizeSince: Date.now() - FINALIZE_SETTLE_WINDOW_MS - 1, pollMs: 10 }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isFetched).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(mockedGetLatestSummary).toHaveBeenCalledTimes(1);
  });
});
