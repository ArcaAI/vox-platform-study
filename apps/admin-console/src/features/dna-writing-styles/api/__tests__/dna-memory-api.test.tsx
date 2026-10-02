/** TASK-1034 — DNA memory / ingest / schedule API layer, asserted as exact "METHOD /api/hope/<path>" calls. */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/test/render';
import {
  deleteDnaMemorySample,
  getDnaIngestJobStatus,
  getDnaSchedule,
  ingestDnaSamples,
  listDnaMemory,
  listDnaMemorySummary,
  runDnaSchedule,
  updateDnaSchedule,
} from '../client';
import { useDeleteDnaMemorySample, useDnaIngestJobProgress, useDnaMemorySummary, useRunDnaSchedule } from '../hooks';
import { dnaKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(response: (call: RecordedCall) => Response = () => Response.json({})): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return response(call);
    }),
  );
  return calls;
}

const line = (call: RecordedCall) => {
  const url = new URL(call.url, 'http://test.local');
  return `${call.method} ${url.pathname}${url.search}`;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DNA memory client', () => {
  it('maps every memory/ingest/schedule call to the pinned contract', async () => {
    const calls = installFetchMock((call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({})));
    await listDnaMemorySummary();
    await listDnaMemory({ doctorId: 'doc-1', source: 'EDIT', consumed: false, page: 2, limit: 20 });
    await deleteDnaMemorySample('s-1');
    await ingestDnaSamples({ clinicianUserId: 'doc-1', generate: false, items: [{ text: 'a', writtenAt: '2026-09-01T09:30:00Z' }] });
    await getDnaIngestJobStatus('job-9');
    await getDnaSchedule();
    await updateDnaSchedule({ enabled: true, cron: '0 2 * * 1', minNewSamples: 3 });
    await runDnaSchedule();

    expect(calls.map(line)).toEqual([
      'GET /api/hope/admin/dna-writing-styles/memory/summary',
      'GET /api/hope/admin/dna-writing-styles/memory?doctorId=doc-1&source=EDIT&consumed=false&page=2&limit=20',
      'DELETE /api/hope/admin/dna-writing-styles/memory/s-1',
      'POST /api/hope/dna-writing-styles/ingest',
      'GET /api/hope/dna-writing-styles/ingest/jobs/job-9',
      'GET /api/hope/admin/dna-writing-styles/schedule',
      'PUT /api/hope/admin/dna-writing-styles/schedule',
      'POST /api/hope/admin/dna-writing-styles/schedule/run',
    ]);
    expect(calls[3].body).toEqual({ clinicianUserId: 'doc-1', generate: false, items: [{ text: 'a', writtenAt: '2026-09-01T09:30:00Z' }] });
    expect(calls[6].body).toEqual({ enabled: true, cron: '0 2 * * 1', minNewSamples: 3 });
  });

  it('keys live under the feature root', () => {
    expect(dnaKeys.memorySummary()[0]).toBe('dna-writing-styles');
    expect(dnaKeys.memory({ doctorId: 'd' })).toContain('memory');
    expect(dnaKeys.schedule()).toEqual(['dna-writing-styles', 'schedule']);
  });
});

function wrapper() {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, Wrapper };
}

describe('DNA memory hooks', () => {
  it('useDnaMemorySummary loads the per-clinician rows', async () => {
    installFetchMock(() => Response.json([{ doctorId: 'doc-1', total: 4 }]));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useDnaMemorySummary(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ doctorId: 'doc-1', total: 4 }]));
  });

  it('useDeleteDnaMemorySample invalidates the memory queries', async () => {
    installFetchMock(() => new Response(null, { status: 204 }));
    const { client, Wrapper } = wrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteDnaMemorySample(), { wrapper: Wrapper });
    await act(() => result.current.mutateAsync('s-1'));
    expect(spy).toHaveBeenCalledWith({ queryKey: dnaKeys.memoryRoot() });
  });

  it('useRunDnaSchedule returns the run result and refreshes the schedule', async () => {
    installFetchMock(() => Response.json({ queued: 2, skipped: { noFeedback: 1, optedOut: 0, quota: 0, belowFloor: 3 }, jobs: [] }));
    const { client, Wrapper } = wrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRunDnaSchedule(), { wrapper: Wrapper });
    const out = await act(() => result.current.mutateAsync());
    expect(out.queued).toBe(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: dnaKeys.root });
  });

  it('useDnaIngestJobProgress polls until terminal and fires onTerminal once', async () => {
    let n = 0;
    installFetchMock(() => {
      n += 1;
      return Response.json({ jobId: 'job-1', status: n > 1 ? 'completed' : 'processing', progress: n > 1 ? 100 : 40 });
    });
    const onTerminal = vi.fn();
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useDnaIngestJobProgress('job-1', { onTerminal, pollMs: 10 }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.job?.status).toBe('completed'));
    expect(result.current.isTerminal).toBe(true);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});
