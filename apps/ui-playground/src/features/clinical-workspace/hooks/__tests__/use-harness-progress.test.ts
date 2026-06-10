/**
 * useHarnessProgress hook tests (TASK-348 — MAJ-8 / MAJ-4 / MIN-6).
 *
 * The hook owns all the async lifecycle risk of the live progress feed: it
 * mints a one-shot stream ticket, opens an EventSource, and must stay correct
 * across unmounts, consultation switches, terminal events and transient
 * drops. Because the one-shot ticket is consumed on connect, the browser's
 * native EventSource auto-reconnect can never succeed — the hook re-mints a
 * fresh ticket with bounded backoff instead (MAJ-4), stopping on the genuine
 * terminal event, unmount, or consultation change. A stale `closed:true`
 * snapshot replayed by the server (1h TTL) must not suppress a fresh run for
 * the same consultation (MIN-6).
 *
 * `fetchStreamTicket` / URL building are mocked (we assert wiring, not the
 * network); a fake EventSource captures handlers so tests drive the stream.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  fetchStreamTicket: vi.fn(),
  buildHarnessProgressStreamUrl: vi.fn(),
  // Stable reference: the real store returns the same client across renders.
  apiClient: { __fake: true },
}));

// The vitest config stubs @arcaai/vox; provide the store selector the hook uses.
vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: (s: { apiClient: unknown }) => unknown) => selector({ apiClient: h.apiClient }),
}));

vi.mock('../../api/clinical-workspace.api', () => ({
  fetchStreamTicket: h.fetchStreamTicket,
  buildHarnessProgressStreamUrl: h.buildHarnessProgressStreamUrl,
}));

// A minimal EventSource test double (jsdom has none). Captures handlers so the
// test can drive open/message/error and assert close() behaviour.
const instances: MockEventSource[] = [];
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  url: string;
  readyState: number = MockEventSource.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });
  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
}

vi.stubGlobal('EventSource', MockEventSource);

import { useHarnessProgress } from '../use-harness-progress';

const stageEntry = (overrides: Record<string, unknown> = {}) => ({
  stage: 'extracting_information',
  label: 'Extracting key information',
  ordinal: 1,
  status: 'active',
  attempt: 1,
  at: '2026-06-10T03:00:00.000Z',
  ...overrides,
});

const progressEvent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    consultationId: 'c1',
    jobId: 'job-1',
    total: 5,
    stages: [stageEntry()],
    updatedAt: '2026-06-10T03:00:00.000Z',
    closed: false,
    ...overrides,
  });

/** Flush fake timers by `ms` while draining real microtasks (ticket promises). */
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  instances.length = 0;
  h.fetchStreamTicket.mockReset();
  h.buildHarnessProgressStreamUrl.mockReset();
  h.fetchStreamTicket.mockResolvedValue({ ticket: 'tok-1' });
  h.buildHarnessProgressStreamUrl.mockImplementation(
    (_client: unknown, id: string, ticket: string) => `http://api/consultations/${id}/harness-progress/stream?ticket=${ticket}`,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useHarnessProgress — wiring', () => {
  it('mints a ticket for the harness-progress scope, opens the stream, and renders events', async () => {
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    expect(result.current.status).toBe('connecting');

    await waitFor(() =>
      expect(h.fetchStreamTicket).toHaveBeenCalledWith(expect.objectContaining({ __fake: true }), 'consultation_harness_progress:c1'),
    );
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].url).toBe('http://api/consultations/c1/harness-progress/stream?ticket=tok-1');

    act(() => instances[0].onopen?.(new Event('open')));
    expect(result.current.status).toBe('open');

    act(() => instances[0].onmessage?.({ data: progressEvent() } as MessageEvent));
    expect(result.current.stages).toHaveLength(1);
    expect(result.current.stages[0].stage).toBe('extracting_information');
    expect(result.current.total).toBe(5);
    expect(result.current.closed).toBe(false);
  });

  it('stays idle and never mints a ticket when disabled', () => {
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(h.fetchStreamTicket).not.toHaveBeenCalled();
    expect(instances).toHaveLength(0);
  });
});

describe('useHarnessProgress — lifecycle (MAJ-8)', () => {
  it('(a) never opens an EventSource when unmounted during the ticket fetch', async () => {
    let resolveTicket!: (v: { ticket: string }) => void;
    h.fetchStreamTicket.mockImplementationOnce(() => new Promise((res) => (resolveTicket = res)));

    const { unmount } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    expect(h.fetchStreamTicket).toHaveBeenCalledTimes(1);

    unmount();
    // The ticket arrives only after unmount — no EventSource may be created
    // (and the cancelled-guard means no state writes on the unmounted hook).
    await act(async () => {
      resolveTicket({ ticket: 'tok-late' });
      await Promise.resolve();
    });
    expect(instances).toHaveLength(0);
  });

  it('(b) the genuine terminal closed event closes the source and stops all further processing', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await tick();
    expect(instances).toHaveLength(1);

    // Live run observed on this connection, then the genuine terminal event.
    act(() => instances[0].onmessage?.({ data: progressEvent() } as MessageEvent));
    act(() =>
      instances[0].onmessage?.({
        data: progressEvent({ closed: true, stages: [stageEntry({ status: 'completed' })] }),
      } as MessageEvent),
    );

    expect(result.current.closed).toBe(true);
    expect(result.current.status).toBe('closed');
    expect(result.current.stages[0].status).toBe('completed');
    expect(instances[0].close).toHaveBeenCalled();

    // Anything after the terminal event is ignored: no state churn…
    act(() =>
      instances[0].onmessage?.({
        data: progressEvent({ stages: [stageEntry({ stage: 'ghost_stage', status: 'active' })] }),
      } as MessageEvent),
    );
    expect(result.current.stages[0].stage).toBe('extracting_information');
    expect(result.current.status).toBe('closed');

    // …and an error after the terminal event never triggers a reconnect.
    act(() => instances[0].onerror?.(new Event('error')));
    await tick(60_000);
    expect(h.fetchStreamTicket).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(result.current.status).toBe('closed');
  });

  it('(c) a consultation change mid-stream closes the old source, resets stages, and reconnects', async () => {
    const { result, rerender } = renderHook((props: { consultationId: string; enabled: boolean }) => useHarnessProgress(props), {
      initialProps: { consultationId: 'c1', enabled: true },
    });
    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => instances[0].onmessage?.({ data: progressEvent() } as MessageEvent));
    expect(result.current.stages).toHaveLength(1);

    rerender({ consultationId: 'c2', enabled: true });

    expect(instances[0].close).toHaveBeenCalled();
    // The previous consultation's checklist never bleeds into the new one.
    expect(result.current.stages).toEqual([]);
    expect(result.current.closed).toBe(false);

    await waitFor(() => expect(instances).toHaveLength(2));
    expect(h.fetchStreamTicket).toHaveBeenLastCalledWith(expect.anything(), 'consultation_harness_progress:c2');
    expect(instances[1].url).toContain('/consultations/c2/');
  });

  it('never reconnects after unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await tick();
    expect(instances).toHaveLength(1);

    unmount();
    expect(instances[0].close).toHaveBeenCalled();

    instances[0].onerror?.(new Event('error'));
    await tick(60_000);
    expect(h.fetchStreamTicket).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
  });
});

describe('useHarnessProgress — ticket-re-minting reconnect (MAJ-4)', () => {
  it('reconnects with a freshly minted ticket after a transient drop, keeping the last checklist', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await tick();
    expect(instances).toHaveLength(1);

    act(() => instances[0].onopen?.(new Event('open')));
    act(() => instances[0].onmessage?.({ data: progressEvent() } as MessageEvent));
    expect(result.current.stages).toHaveLength(1);

    // Transient drop: the dead source is closed (its ticket is spent) and the
    // hook re-mints + reopens instead of surfacing a hard error.
    act(() => instances[0].onerror?.(new Event('error')));
    expect(instances[0].close).toHaveBeenCalled();
    expect(result.current.status).toBe('connecting');
    // The last known checklist is kept while reconnecting (no blank flash).
    expect(result.current.stages).toHaveLength(1);

    await tick(1_000);
    expect(h.fetchStreamTicket).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(2);

    act(() => instances[1].onopen?.(new Event('open')));
    expect(result.current.status).toBe('open');
    act(() =>
      instances[1].onmessage?.({
        data: progressEvent({ stages: [stageEntry(), stageEntry({ stage: 'assembling_context', ordinal: 2 })] }),
      } as MessageEvent),
    );
    expect(result.current.stages).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('surfaces status error only after bounded retries (3) exhaust, with growing backoff', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await tick();
    expect(instances).toHaveLength(1);

    // Failure 1 → retry after 1s.
    act(() => instances[0].onerror?.(new Event('error')));
    expect(result.current.status).toBe('connecting');
    await tick(1_000);
    expect(instances).toHaveLength(2);

    // Failure 2 → backoff grows to 2s (1s is not enough).
    act(() => instances[1].onerror?.(new Event('error')));
    await tick(1_000);
    expect(instances).toHaveLength(2);
    await tick(1_000);
    expect(instances).toHaveLength(3);

    // Failure 3 → last retry after 4s.
    act(() => instances[2].onerror?.(new Event('error')));
    await tick(4_000);
    expect(instances).toHaveLength(4);

    // Failure 4 → budget exhausted: hard error, no further minting ever.
    act(() => instances[3].onerror?.(new Event('error')));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/disconnected/i);
    await tick(120_000);
    expect(h.fetchStreamTicket).toHaveBeenCalledTimes(4);
    expect(instances).toHaveLength(4);
  });

  it('retries when the ticket mint itself fails', async () => {
    vi.useFakeTimers();
    h.fetchStreamTicket.mockRejectedValueOnce(new Error('mint exploded'));

    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await tick();
    expect(instances).toHaveLength(0);
    expect(result.current.status).toBe('connecting');

    await tick(1_000);
    expect(h.fetchStreamTicket).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(1);
    act(() => instances[0].onopen?.(new Event('open')));
    expect(result.current.status).toBe('open');
  });

  it('restores the retry budget once the stream delivers data again', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await tick();

    // Burn the full budget minus one: three consecutive failures…
    act(() => instances[0].onerror?.(new Event('error')));
    await tick(1_000);
    act(() => instances[1].onerror?.(new Event('error')));
    await tick(2_000);
    act(() => instances[2].onerror?.(new Event('error')));
    await tick(4_000);
    expect(instances).toHaveLength(4);

    // …then a healthy connection delivering data resets the budget.
    act(() => instances[3].onopen?.(new Event('open')));
    act(() => instances[3].onmessage?.({ data: progressEvent() } as MessageEvent));

    act(() => instances[3].onerror?.(new Event('error')));
    expect(result.current.status).toBe('connecting');
    await tick(1_000);
    expect(instances).toHaveLength(5);
  });
});

describe('useHarnessProgress — stale terminal snapshot (MIN-6)', () => {
  it('a replayed closed snapshot does not suppress a fresh run for the same consultation', async () => {
    const { result } = renderHook(() => useHarnessProgress({ consultationId: 'c1', enabled: true }));
    await waitFor(() => expect(instances).toHaveLength(1));

    // First message on the connection: the server replays the previous run's
    // terminal snapshot (kept for 1h).
    act(() =>
      instances[0].onmessage?.({
        data: progressEvent({ closed: true, stages: [stageEntry({ status: 'completed' })] }),
      } as MessageEvent),
    );
    expect(result.current.closed).toBe(true);
    expect(result.current.status).toBe('closed');
    // The stream keeps listening: a new run may start for this consultation.
    expect(instances[0].close).not.toHaveBeenCalled();

    // The new run's first event arrives → terminal flags reset, stages render.
    act(() =>
      instances[0].onmessage?.({
        data: progressEvent({ jobId: 'job-2', stages: [stageEntry({ status: 'active', attempt: 1 })] }),
      } as MessageEvent),
    );
    expect(result.current.closed).toBe(false);
    expect(result.current.status).toBe('open');
    expect(result.current.stages).toHaveLength(1);
    expect(result.current.stages[0].status).toBe('active');
    expect(instances[0].close).not.toHaveBeenCalled();
  });
});
