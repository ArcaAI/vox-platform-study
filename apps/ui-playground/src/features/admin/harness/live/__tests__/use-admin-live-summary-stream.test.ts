/**
 * TASK-341 B5 — admin live-summary SSE hook.
 *
 * Verifies the hook mints a one-shot ticket for the consultation scope, opens
 * an EventSource at the built URL, classifies `message` payloads via the reused
 * pure `reduceLiveSummaryMessage` reducer (summary → event, terminal closed →
 * `closed`), and only surfaces a hard error once the browser-managed
 * EventSource is CLOSED (it auto-reconnects otherwise). The admin api layer is
 * mocked so we assert the wiring, not the network.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  fetchStreamTicket: vi.fn(),
  buildLiveSummaryStreamUrl: vi.fn(),
}));

vi.mock('../../api/live', () => ({
  fetchStreamTicket: h.fetchStreamTicket,
  buildLiveSummaryStreamUrl: h.buildLiveSummaryStreamUrl,
}));

// A minimal EventSource test double (jsdom has none). Captures handlers so the
// test can drive open/message/error and assert close() + readyState behaviour.
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

import { useAdminLiveSummaryStream } from '../use-admin-live-summary-stream';

const summary = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    consultationId: 'c1',
    runningSummary: 'Patient reports chest pain.',
    sections: [{ title: 'Subjective', content: 'Patient reports chest pain.' }],
    entities: [],
    updatedAt: '2026-06-08T10:00:00.000Z',
    ...extra,
  });

beforeEach(() => {
  instances.length = 0;
  h.fetchStreamTicket.mockReset();
  h.buildLiveSummaryStreamUrl.mockReset();
  h.fetchStreamTicket.mockResolvedValue({ ticket: 'tok-1' });
  h.buildLiveSummaryStreamUrl.mockReturnValue('http://api/consultations/c1/live-summary/stream?ticket=tok-1');
});

describe('useAdminLiveSummaryStream', () => {
  it('mints a ticket for the consultation scope and opens the stream', async () => {
    const { result } = renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: true }));

    await waitFor(() => expect(h.fetchStreamTicket).toHaveBeenCalledWith('consultation_live_summary:c1', undefined));
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].url).toBe('http://api/consultations/c1/live-summary/stream?ticket=tok-1');

    act(() => instances[0].onopen?.(new Event('open')));
    expect(result.current.status).toBe('open');
  });

  it('forwards the selected tenant to the ticket mint (super-admin scope)', async () => {
    renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: true, tenantId: 't-9' }));
    await waitFor(() => expect(h.fetchStreamTicket).toHaveBeenCalledWith('consultation_live_summary:c1', 't-9'));
  });

  it('parses a summary message into event + lastUpdatedAt', async () => {
    const { result } = renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: true }));
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => instances[0].onmessage?.({ data: summary() } as MessageEvent));

    expect(result.current.event?.runningSummary).toBe('Patient reports chest pain.');
    expect(result.current.event?.sections).toHaveLength(1);
    expect(result.current.lastUpdatedAt).toBe('2026-06-08T10:00:00.000Z');
  });

  it('ignores heartbeats / invalid payloads without clobbering the event', async () => {
    const { result } = renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: true }));
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => instances[0].onmessage?.({ data: summary() } as MessageEvent));
    act(() => instances[0].onmessage?.({ data: '' } as MessageEvent)); // heartbeat
    act(() => instances[0].onmessage?.({ data: 'not-json' } as MessageEvent)); // invalid

    expect(result.current.event?.runningSummary).toBe('Patient reports chest pain.');
  });

  it('closes the stream on the terminal closed event', async () => {
    const { result } = renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: true }));
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => instances[0].onmessage?.({ data: summary({ closed: true }) } as MessageEvent));

    expect(result.current.status).toBe('closed');
    expect(instances[0].close).toHaveBeenCalled();
  });

  it('surfaces an error only once the EventSource is CLOSED (auto-reconnect otherwise)', async () => {
    const { result } = renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: true }));
    await waitFor(() => expect(instances).toHaveLength(1));

    // Transient blip: the browser auto-reconnects, so no hard error yet.
    act(() => {
      instances[0].readyState = MockEventSource.CONNECTING;
      instances[0].onerror?.(new Event('error'));
    });
    expect(result.current.status).not.toBe('error');

    // Permanent close → surface the error.
    act(() => {
      instances[0].readyState = MockEventSource.CLOSED;
      instances[0].onerror?.(new Event('error'));
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeTruthy();
  });

  it('stays idle when disabled and never mints a ticket', async () => {
    const { result } = renderHook(() => useAdminLiveSummaryStream({ consultationId: 'c1', enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(h.fetchStreamTicket).not.toHaveBeenCalled();
    expect(instances).toHaveLength(0);
  });
});
