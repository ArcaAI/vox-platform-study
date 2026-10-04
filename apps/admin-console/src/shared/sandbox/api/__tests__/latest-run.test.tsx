/**
 * TASK-1036 — the latest Test-tab run of a definition lives in the query cache (memory only, never
 * localStorage): the inspector's Last run tab and the picker samples read it; a Test tab remount
 * resumes it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient } from '@/test/render';
import { rememberLatestSandboxRun, useLatestSandboxRun } from '../latest-run';

function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, wrapper };
}

describe('latest sandbox run', () => {
  it('is empty before any run', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useLatestSandboxRun('def-1'), { wrapper });
    expect(result.current).toEqual({ runId: null, nodes: {} });
  });

  it('remembers the run per definition and updates every reader', async () => {
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => ({ one: useLatestSandboxRun('def-1'), two: useLatestSandboxRun('def-2') }), { wrapper });
    act(() => {
      rememberLatestSandboxRun(queryClient, 'def-1', { runId: 'run-9', nodes: { n: { inputs: {}, outputs: { text: 'hi' }, durationMs: 4, status: 'SUCCEEDED' } } });
    });
    await waitFor(() => expect(result.current.one.runId).toBe('run-9'));
    expect(result.current.one.nodes.n!.outputs).toEqual({ text: 'hi' });
    expect(result.current.two).toEqual({ runId: null, nodes: {} });
  });

  it('survives an invalidation of the sandbox namespace', async () => {
    const { queryClient, wrapper } = setup();
    rememberLatestSandboxRun(queryClient, 'def-1', { runId: 'run-9', nodes: {} });
    const { result } = renderHook(() => useLatestSandboxRun('def-1'), { wrapper });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['sandbox'] });
    });
    expect(result.current.runId).toBe('run-9');
  });
});
