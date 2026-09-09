/**
 * useArcaLiveSummary Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaLiveSummary } from '../useArcaLiveSummary';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS, liveSummaryScopeFor } from '../../core/constants';
import type { LiveSummarySnapshot } from '../../types/liveSummary';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

/* eslint-disable @typescript-eslint/no-explicit-any -- SSE + store doubles model only the consumed surface */
let mockSSEInstance: any;
let sseConstructorSpy: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let handlers: { message?: (data: string) => void; open?: () => void; error?: (event: Event) => void; named: Record<string, (data: string) => void> };

vi.mock('../../core/SSEClient', () => {
  const MockSSEClient = function (this: any, ...args: unknown[]) {
    sseConstructorSpy(...args);
    Object.assign(this, mockSSEInstance);
    return this;
  } as any;
  MockSSEClient.prototype = {};
  return { SSEClient: MockSSEClient };
});

function snapshot(overrides: Partial<LiveSummarySnapshot> = {}): LiveSummarySnapshot {
  return { consultationId: 'c-1', runningSummary: 'S: cough', sections: [], entities: [], updatedAt: 'now', ...overrides };
}

describe('useArcaLiveSummary', () => {
  let mockStore: any;

  beforeEach(() => {
    sseConstructorSpy = vi.fn<(...args: unknown[]) => void>();
    handlers = { named: {} };
    mockSSEInstance = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onEvent: vi.fn((name: string, cb: (data: string) => void) => {
        handlers.named[name] = cb;
      }),
      onError: vi.fn((cb: (event: Event) => void) => {
        handlers.error = cb;
      }),
      onOpen: vi.fn((cb: () => void) => {
        handlers.open = cb;
      }),
      onMessage: vi.fn((cb: (data: string) => void) => {
        handlers.message = cb;
      }),
      isConnected: vi.fn().mockReturnValue(false),
    };
    mockStore = {
      apiClient: {
        getBaseUrl: vi.fn().mockReturnValue('http://localhost:3000/api/hope'),
        // BFF-split host: streams open against the gateway directly.
        getStreamBaseUrl: vi.fn().mockReturnValue('http://localhost:8868/api/v1'),
      },
      logger: createMockLogger(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('connects with the correct scope + URL and reports connecting', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));

    expect(sseConstructorSpy).toHaveBeenCalledTimes(1);
    expect(sseConstructorSpy.mock.calls[0]![0]).toBe(liveSummaryScopeFor('c-1'));
    expect(mockSSEInstance.connect).toHaveBeenCalledWith(`http://localhost:8868/api/v1${CONSULTATION_ENDPOINTS.LIVE_SUMMARY_STREAM('c-1')}`, {
      autoReconnect: true,
    });
    expect(result.current.status).toBe('connecting');
  });

  it('flips to open, then folds full-state snapshots', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));

    act(() => handlers.open?.());
    expect(result.current.status).toBe('open');

    act(() => handlers.message?.(JSON.stringify(snapshot({ runningSummary: 'S: productive cough' }))));
    expect(result.current.snapshot?.runningSummary).toBe('S: productive cough');
    expect(result.current.status).toBe('open');
  });

  // TASK-932 — the gateway publishes per-SECTION patches (`event: 'section.patch'`) and the
  // warm-start pre-summary lifecycle (`event: 'presummary'`) on the SAME channel as the full-state
  // snapshot. This hook models only the snapshot; folding a typed sub-plane event over it wiped
  // `entities` / `runningSummary` ~50 ms after every flush, so the console's entity chips and
  // running summary blinked out the moment a flush landed.
  it('ignores typed sub-plane events on the channel — a section.patch never replaces the snapshot', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => handlers.open?.());
    const full = snapshot({ entities: [{ text: 'aspirin', type: 'MEDICATION', start: 0, end: 7 } as any] });
    act(() => handlers.message?.(JSON.stringify(full)));
    act(() =>
      handlers.message?.(
        JSON.stringify({ event: 'section.patch', consultationId: 'c-1', documentKey: 'soap', sectionKey: 'plan', revision: 1, content: 'rest', updatedAt: 'later' }),
      ),
    );
    act(() => handlers.message?.(JSON.stringify({ event: 'presummary', consultationId: 'c-1', status: 'degraded' })));

    expect(result.current.snapshot).toEqual(full);
    expect(result.current.status).toBe('open');
  });

  // TASK-932 OD-10 — the gateway relay now ALSO tags these as NAMED SSE frames
  // (`section.patch`, `presummary`) instead of only multiplexing them onto the default
  // `message`. Additive, same 3.1.x release: this hook still models only the whole-document
  // snapshot, so both names are registered as deliberate no-ops rather than left unbound.
  it('registers named listeners for section.patch and presummary', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));

    expect(mockSSEInstance.onEvent).toHaveBeenCalledWith('section.patch', expect.any(Function));
    expect(mockSSEInstance.onEvent).toHaveBeenCalledWith('presummary', expect.any(Function));
  });

  it('a section.patch delivered on its named event never touches the snapshot', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => handlers.open?.());
    const full = snapshot({ runningSummary: 'S: productive cough' });
    act(() => handlers.message?.(JSON.stringify(full)));

    act(() =>
      handlers.named['section.patch']?.(
        JSON.stringify({
          event: 'section.patch',
          consultationId: 'c-1',
          documentKey: 'soap',
          sectionKey: 'plan',
          revision: 1,
          content: 'rest',
          updatedAt: 'later',
        }),
      ),
    );

    expect(result.current.snapshot).toEqual(full);
    expect(result.current.status).toBe('open');
  });

  it('closes on the terminal snapshot and disconnects', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => handlers.message?.(JSON.stringify(snapshot({ closed: true }))));

    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(result.current.status).toBe('closed');
  });

  it('ignores malformed events without throwing', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => handlers.message?.('not-json'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.status).toBe('connecting');
  });

  it('surfaces a connection error', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => handlers.error?.(new Event('error')));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('stop() disconnects and closes', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => result.current.stop());
    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(result.current.status).toBe('closed');
  });

  it('replaces a prior stream when start() is called again', () => {
    const { result } = renderHook(() => useArcaLiveSummary());
    act(() => result.current.start('c-1'));
    act(() => result.current.start('c-2'));
    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(sseConstructorSpy).toHaveBeenCalledTimes(2);
    expect(sseConstructorSpy.mock.calls[1]![0]).toBe(liveSummaryScopeFor('c-2'));
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
