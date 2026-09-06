/**
 * TASK-890 L7 — `useWorkflowReview` and `useWorkflowRun().schema()`.
 *
 * A `core.humanReview` node parks a run on a person; every node downstream of a handle that
 * does not fire is skipped. Until now nothing outside the internal service-token plane could
 * read or release one. This is the browser client for the two new gateway routes.
 *
 * The distinction the tests exist to lock is between `exists: false` (the interpreter's own
 * answer: not reached yet, or already settled) and a FAILED read. A reviewer screen that
 * renders "nothing to approve" during an outage silently loses the work it was built to
 * protect, so the two must never collapse into one value.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkflowReview } from '../useWorkflowReview';
import { useWorkflowRun } from '../useWorkflowRun';

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined }),
}));

vi.mock('../../core/SSEClient', () => ({
  SSEClient: class {
    onEvent(): void {}
    connect(): void {}
    disconnect(): void {}
    getLastEventId(): string | null {
      return null;
    }
  },
}));

const WAITING = { runId: 'run-1', nodeId: 'n_review', exists: true, phase: 'WAITING', escalations: 0, decided: false, decision: null };

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockResolvedValue(WAITING);
  apiClient.post.mockResolvedValue({ runId: 'run-1', nodeId: 'n_review', decision: 'approved', signaled: true, reviewerId: 'user-9' });
});

describe('useWorkflowReview.fetchReview', () => {
  it('GETs …/runs/:runId/reviews/:nodeId and exposes the state', async () => {
    const { result } = renderHook(() => useWorkflowReview());

    await act(async () => {
      await result.current.fetchReview('triage', 'run-1', 'n_review');
    });

    expect(apiClient.get).toHaveBeenCalledWith('/workflows/triage/runs/run-1/reviews/n_review');
    await waitFor(() => expect(result.current.review).toEqual(WAITING));
  });

  it('percent-encodes each path segment', async () => {
    const { result } = renderHook(() => useWorkflowReview());
    await act(async () => {
      await result.current.fetchReview('a/b', 'run 1', 'n/1');
    });
    expect(apiClient.get.mock.calls[0]![0]).toBe('/workflows/a%2Fb/runs/run%201/reviews/n%2F1');
  });

  it('keeps `exists: false` as a real answer — it is state, not absence', async () => {
    apiClient.get.mockResolvedValue({
      runId: 'run-1',
      nodeId: 'n_review',
      exists: false,
      phase: null,
      escalations: null,
      decided: false,
      decision: null,
    });
    const { result } = renderHook(() => useWorkflowReview());

    await act(async () => {
      await result.current.fetchReview('triage', 'run-1', 'n_review');
    });

    await waitFor(() => expect(result.current.review).toMatchObject({ exists: false }));
    expect(result.current.review).not.toBeNull();
  });

  it('a FAILED read resolves to null and records the error — never a false "nothing to decide"', async () => {
    apiClient.get.mockRejectedValue(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => useWorkflowReview());

    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.fetchReview('triage', 'run-1', 'n_review');
    });

    expect(returned).toBeNull();
    await waitFor(() => expect(result.current.review).toBeNull());
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  });
});

describe('useWorkflowReview.decide', () => {
  it('POSTs the decision to …/decide and refreshes the state it holds', async () => {
    const { result } = renderHook(() => useWorkflowReview());

    let out: unknown;
    await act(async () => {
      out = await result.current.decide('triage', 'run-1', 'n_review', { decision: 'approved', comment: 'ok' });
    });

    expect(apiClient.post).toHaveBeenCalledWith('/workflows/triage/runs/run-1/reviews/n_review/decide', { decision: 'approved', comment: 'ok' });
    expect(out).toMatchObject({ signaled: true, reviewerId: 'user-9' });
  });

  it('never puts a reviewer identity on the wire, even when one is handed in', async () => {
    const { result } = renderHook(() => useWorkflowReview());

    await act(async () => {
      await result.current.decide('triage', 'run-1', 'n', { decision: 'rejected', reviewerId: 'someone-else' } as never);
    });

    expect(apiClient.post.mock.calls[0]![1]).toEqual({ decision: 'rejected' });
  });

  it('forwards an editedPayload when the caller supplies one', async () => {
    const { result } = renderHook(() => useWorkflowReview());

    await act(async () => {
      await result.current.decide('triage', 'run-1', 'n', { decision: 'approved', editedPayload: { summary: 'fixed' } });
    });

    expect(apiClient.post.mock.calls[0]![1]).toEqual({ decision: 'approved', editedPayload: { summary: 'fixed' } });
  });

  it('REJECTS on failure — unlike the read, a decision that did not land must not look like one that did', async () => {
    apiClient.post.mockRejectedValue(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => useWorkflowReview());

    await expect(result.current.decide('triage', 'run-1', 'n', { decision: 'approved' })).rejects.toThrow();
  });
});

describe('useWorkflowRun().schema', () => {
  it('GETs /workflows/:slug/schema', async () => {
    const description = {
      slug: 'triage',
      versionNumber: 2,
      triggerKinds: ['api'],
      protocols: ['http-sse'],
      modes: ['async', 'stream'],
      components: {},
      asyncapi: {},
    };
    apiClient.get.mockResolvedValue(description);

    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    let out: unknown;
    await act(async () => {
      out = await result.current.schema('triage');
    });

    expect(apiClient.get).toHaveBeenCalledWith('/workflows/triage/schema');
    expect(out).toEqual(description);
  });

  it('resolves to null rather than rejecting when the read fails — a contract panel must not break its screen', async () => {
    apiClient.get.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    let out: unknown = 'unset';
    await act(async () => {
      out = await result.current.schema('triage');
    });

    expect(out).toBeNull();
  });
});
