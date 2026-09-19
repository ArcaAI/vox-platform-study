/**
 * useDnaIngestJobProgress (playground SELF plane, F-6) — there is NO SSE on the ingest job
 * route (README §4.1, and the `useDnaWritingStyle` SDK hook it mirrors): a 2s poll
 * (`GET dna-writing-styles/ingest/jobs/:jobId`) is the ONLY transport, never an error fallback
 * the way `useDnaJobProgress`'s poll is. Exercised through the stubbed fetch + fake timers,
 * mirroring `use-dna-job-progress.test.tsx`'s poll half — no EventSource double needed here.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDnaIngestJobProgress } from '../hooks';

interface RecordedCall {
  url: string;
  method: string;
}

function stubNetwork(jobStatus: () => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return jobStatus();
    }),
  );
  return calls;
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useDnaIngestJobProgress (playground)', () => {
  it('polls GET ingest/jobs/:jobId every 2s (no ticket, no stream) until terminal, then invalidates once and notifies', async () => {
    vi.useFakeTimers();
    let call = 0;
    const responses = [
      { jobId: 'ing-1', status: 'queued', progress: 0 },
      { jobId: 'ing-1', status: 'processing', progress: 50 },
      { jobId: 'ing-1', status: 'completed', progress: 100, result: { reportId: 'rep-9' } },
    ];
    const calls = stubNetwork(() => Response.json(responses[Math.min(call++, responses.length - 1)]));
    const { Wrapper } = createWrapper();
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useDnaIngestJobProgress('ing-1', { onTerminal }), { wrapper: Wrapper });

    await vi.waitFor(() => expect(result.current.job?.status).toBe('queued'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'GET', url: '/api/hope/dna-writing-styles/ingest/jobs/ing-1' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await vi.waitFor(() => expect(result.current.job?.status).toBe('processing'));
    expect(result.current.isTerminal).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await vi.waitFor(() => expect(result.current.isTerminal).toBe(true));
    expect(result.current.job).toMatchObject({ status: 'completed', progress: 100 });
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
    expect(onTerminal.mock.calls[0][0]).toMatchObject({ status: 'completed' });

    // Polling stops once terminal — no further calls even after another interval elapses.
    const callsAtTerminal = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(calls.length).toBe(callsAtTerminal);
  });

  it('is idle without a job id (no fetch fired)', () => {
    const calls = stubNetwork(() => Response.json({ jobId: 'ing-1', status: 'queued', progress: 0 }));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useDnaIngestJobProgress(null), { wrapper: Wrapper });

    expect(result.current.job).toBeNull();
    expect(result.current.isTerminal).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a FAILED terminal state still notifies once, but does not invalidate the feature cache', async () => {
    vi.useFakeTimers();
    stubNetwork(() => Response.json({ jobId: 'ing-1', status: 'failed', progress: 40, error: 'boom' }));
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useDnaIngestJobProgress('ing-1', { onTerminal }), { wrapper: Wrapper });

    await vi.waitFor(() => expect(result.current.isTerminal).toBe(true));
    expect(result.current.job).toMatchObject({ status: 'failed', error: 'boom' });
    expect(invalidateSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
  });
});
