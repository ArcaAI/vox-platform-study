/**
 * TASK-850 lane B — `useWorkflowRun`, the browser SDK's workflow invocation
 * surface.
 *
 * Paths and semantics are pinned to the routes lane A shipped
 * (`apps/api/route-manifest.json`); the reserved-key list is pinned to
 * `packages/applications/src/services/workflow-exposure/exposure-palette-policy.ts`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkflowRun, RESERVED_RUN_IDENTITY_KEYS, ReservedRunIdentityError } from '../useWorkflowRun';

// ---------------------------------------------------------------------------
// Store double — the hook reaches the client through `useApiOperation`.
// ---------------------------------------------------------------------------

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined }),
}));

// ---------------------------------------------------------------------------
// SSEClient double — records connects so resume/scope can be asserted.
// ---------------------------------------------------------------------------

interface RecordedConnect {
  url: string;
  options: Record<string, unknown>;
}

const connects: RecordedConnect[] = [];
const scopes: string[] = [];
let namedListeners: Map<string, (data: string) => void>;
let disconnectCount = 0;
let mockCursor: string | null = null;

vi.mock('../../core/SSEClient', () => ({
  SSEClient: class {
    constructor(scope: string) {
      scopes.push(scope);
      namedListeners = new Map();
    }
    onEvent(name: string, cb: (data: string) => void): void {
      namedListeners.set(name, cb);
    }
    onError(): void {}
    onOpen(): void {}
    connect(url: string, options: Record<string, unknown>): void {
      connects.push({ url, options });
    }
    disconnect(): void {
      disconnectCount += 1;
    }
    getLastEventId(): string | null {
      return mockCursor;
    }
  },
}));

/** Emit one frame into the hook's registered listener for `type`. */
function emit(type: string, payload: Record<string, unknown>, cursor?: string): void {
  if (cursor !== undefined) mockCursor = cursor;
  const envelope = {
    schemaVersion: 1,
    id: 'env-1',
    tenantId: 't',
    type,
    occurredAt: '2026-09-02T00:00:00.000Z',
    correlationId: String(payload.runId ?? 'run-1'),
    causationId: null,
    idempotencyKey: 'k',
    payload,
  };
  act(() => {
    namedListeners.get(type)?.(JSON.stringify(envelope));
  });
}

const HANDLE = {
  runId: 'run-1',
  status: 'started' as const,
  statusUrl: '/api/v1/workflows/visit-summary/runs/run-1',
  streamUrl: '/api/v1/workflows/visit-summary/runs/run-1/stream',
};

beforeEach(() => {
  vi.clearAllMocks();
  connects.length = 0;
  scopes.length = 0;
  disconnectCount = 0;
  mockCursor = null;
  apiClient.get.mockResolvedValue({ data: [] });
  apiClient.post.mockResolvedValue(HANDLE);
  apiClient.postWithHeaders.mockResolvedValue(HANDLE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('catalogue', () => {
  it('reads GET /workflows on mount', async () => {
    const summary = { slug: 'visit-summary', name: 'Visit Summary', description: null, paletteKey: 'summarization', versionNumber: 3 };
    apiClient.get.mockResolvedValue({ data: [summary] });

    const { result } = renderHook(() => useWorkflowRun());

    await waitFor(() => expect(result.current.workflows).toEqual([summary]));
    expect(apiClient.get).toHaveBeenCalledWith('/workflows');
  });

  it('reads the CONSULTATION-bound catalogue when a consultationId is given — it is the wider list', async () => {
    const { result } = renderHook(() => useWorkflowRun({ consultationId: 'con-1' }));

    await waitFor(() => expect(result.current.workflows).toEqual([]));
    expect(apiClient.get).toHaveBeenCalledWith('/consultations/con-1/workflows');
  });

  it('keeps `null` (could not ask) distinct from `[]` (tenant has none)', async () => {
    apiClient.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useWorkflowRun());

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    // Never `[]` — a false empty state would tell a user their tenant has no
    // workflows because one request blipped.
    expect(result.current.workflows).toBeNull();
  });
});

describe('starting a run', () => {
  it('POSTs the unbound plane and opens a resumable stream', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    await act(async () => {
      await result.current.start('visit-summary', { note: 'hi' });
    });

    expect(apiClient.post).toHaveBeenCalledWith('/workflows/visit-summary/runs', { input: { note: 'hi' } });
    expect(result.current.handle).toEqual(HANDLE);
    expect(result.current.isRunning).toBe(true);

    expect(connects).toHaveLength(1);
    expect(connects[0]!.url).toBe('https://api.example.com/api/v1/workflows/visit-summary/runs/run-1/stream');
    // The whole point: without this a reconnect drops the frames in the gap.
    expect(connects[0]!.options.resume).toBe(true);
    // The ticket scope names the RUN — the gateway mints per-run tickets.
    expect(scopes[0]).toBe('workflow_run:run-1');
  });

  it('POSTs the CONSULTATION plane when a consultationId is supplied — id in the URL, never the body', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    await act(async () => {
      await result.current.start('note-writer', { tone: 'brief' }, { consultationId: 'con-1' });
    });

    expect(apiClient.post).toHaveBeenCalledWith('/consultations/con-1/workflows/note-writer/runs', { input: { tone: 'brief' } });
    const [, body] = apiClient.post.mock.calls[0]!;
    expect(body).not.toHaveProperty('input.consultationId');
  });

  it('sends Idempotency-Key as a header so a retry JOINS the run instead of starting a second', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ ...HANDLE, status: 'already_running' });
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    await act(async () => {
      await result.current.start('visit-summary', {}, { idempotencyKey: 'submission-42' });
    });

    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/workflows/visit-summary/runs', { input: {} }, { 'Idempotency-Key': 'submission-42' });
    expect(result.current.handle!.status).toBe('already_running');
  });

  it('can start without streaming', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    await act(async () => {
      await result.current.start('visit-summary', {}, { stream: false });
    });

    expect(connects).toHaveLength(0);
  });
});

describe('reserved run-identity keys are refused before any request', () => {
  it.each(RESERVED_RUN_IDENTITY_KEYS)('refuses `%s`', async (key) => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    await expect(result.current.start('s', { [key]: 'x' })).rejects.toBeInstanceOf(ReservedRunIdentityError);
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(apiClient.postWithHeaders).not.toHaveBeenCalled();
  });

  it('names every offending key at once and mirrors the gateway list', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    const error = await result.current.start('s', { consultationId: 'c', jobId: 'j', keep: 1 }).catch((e: unknown) => e);

    expect((error as ReservedRunIdentityError).keys).toEqual(['consultationId', 'jobId']);
    expect(RESERVED_RUN_IDENTITY_KEYS).toEqual(['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId']);
  });
});

describe('the live stream', () => {
  it('collects frames, tracks the resume cursor, and finishes on the terminal frame', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));
    await act(async () => {
      await result.current.start('visit-summary', {});
    });

    emit('workflow.run.progress', { runId: 'run-1', slug: 'visit-summary', status: 'RUNNING', stages: [], startedAt: null, endedAt: null, workflowVersionNumber: 3 });
    expect(result.current.status!.status).toBe('RUNNING');
    expect(result.current.isRunning).toBe(true);

    emit('workflow.node.started', { runId: 'run-1', nodeId: 'n1' }, '1699-0');
    expect(result.current.lastEventId).toBe('1699-0');
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[1]!.resumeToken).toBe('1699-0');

    emit('workflow.run.completed', { runId: 'run-1', slug: 'visit-summary', status: 'COMPLETED', stages: [], startedAt: null, endedAt: null, workflowVersionNumber: 3, resultRef: { outputs: { text: 'done' } } }, '1699-1');
    expect(result.current.isRunning).toBe(false);
    expect(result.current.status!.status).toBe('COMPLETED');
    expect(result.current.status!.resultRef).toEqual({ outputs: { text: 'done' } });
    // A terminal run is not reconnected to.
    expect(disconnectCount).toBeGreaterThan(0);
  });

  it('watch() resumes an already-started run from a persisted cursor', () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    act(() => {
      result.current.watch('visit-summary', 'run-9', 'cursor-from-storage');
    });

    expect(connects[0]!.options.lastEventId).toBe('cursor-from-storage');
    expect(connects[0]!.options.resume).toBe(true);
    expect(scopes[0]).toBe('workflow_run:run-9');
  });

  it('caps retained events so a chatty run cannot grow memory without bound', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true, maxEvents: 3 }));
    await act(async () => {
      await result.current.start('visit-summary', {});
    });

    for (let i = 0; i < 6; i += 1) emit('workflow.token.delta', { runId: 'run-1', seq: i }, `c-${i}`);

    expect(result.current.events).toHaveLength(3);
    expect((result.current.events[2]!.payload as unknown as { seq: number }).seq).toBe(5);
  });

  it('survives an unparseable frame instead of tearing the stream down', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));
    await act(async () => {
      await result.current.start('visit-summary', {});
    });

    act(() => {
      namedListeners.get('workflow.node.started')?.('not json{');
    });
    expect(result.current.events).toHaveLength(0);

    emit('workflow.node.started', { runId: 'run-1' }, 'c-1');
    expect(result.current.events).toHaveLength(1);
  });

  it('stopWatching closes the view WITHOUT cancelling the durable run', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));
    await act(async () => {
      await result.current.start('visit-summary', {});
    });

    act(() => result.current.stopWatching());

    // Exactly one: `start()`'s internal watch() resets a stream only if one is
    // already open, and none was.
    expect(disconnectCount).toBe(1);
    // The run POST and NOTHING else — closing a view must never signal cancel.
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).not.toHaveBeenCalledWith(expect.stringContaining('/cancel'));
  });

  it('unmount closes the stream — no orphaned EventSource or ticket loop', async () => {
    const { result, unmount } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));
    await act(async () => {
      await result.current.start('visit-summary', {});
    });
    const before = disconnectCount;

    unmount();

    expect(disconnectCount).toBeGreaterThan(before);
  });
});

describe('status and cancel', () => {
  it('reads the run status on the shipped path', async () => {
    const status = { runId: 'run-1', slug: 'visit-summary', workflowVersionNumber: 3, status: 'RUNNING', stages: [], startedAt: null, endedAt: null, resultRef: null };
    apiClient.get.mockResolvedValue(status);
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    await act(async () => {
      await result.current.fetchStatus('visit-summary', 'run-1');
    });

    expect(apiClient.get).toHaveBeenCalledWith('/workflows/visit-summary/runs/run-1');
    expect(result.current.status!.status).toBe('RUNNING');
  });

  it('cancel sends the signal but does NOT declare the run stopped', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));
    await act(async () => {
      await result.current.start('visit-summary', {});
    });

    await act(async () => {
      await result.current.cancel('visit-summary', 'run-1');
    });

    expect(apiClient.post).toHaveBeenCalledWith('/workflows/visit-summary/runs/run-1/cancel');
    // Cancellation is REQUESTED, not complete — only the stream's terminal
    // frame may flip this.
    expect(result.current.isRunning).toBe(true);
  });
});
