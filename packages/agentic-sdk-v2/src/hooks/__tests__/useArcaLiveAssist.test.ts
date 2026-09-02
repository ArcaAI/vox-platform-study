/**
 * useArcaLiveAssist Hook Tests (TASK-858 G2)
 *
 * The `agent.grammar` node publishes correction proposals and interpreter
 * suggestions to `GET /consultations/:id/live-assist/stream` — a FOURTH
 * consultation stream the SDK had zero references to. These tests pin the same
 * transport contract `useArcaLiveSummary` already established (ticket scope,
 * stream base URL, single-use tickets, cleanup) plus the two ways this feed
 * genuinely differs:
 *
 *   1. it carries TWO branches on one full-state snapshot, and a publish
 *      replaces only the branch it carries — so the hook must surface the
 *      snapshot as-is rather than merging its own history;
 *   2. it has NO terminal event — the client closes it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaLiveAssist } from '../useArcaLiveAssist';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS, liveAssistScopeFor } from '../../core/constants';
import type { LiveAssistEvent } from '../../types/liveAssist';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

/* eslint-disable @typescript-eslint/no-explicit-any -- SSE + store doubles model only the consumed surface */
let mockSSEInstance: any;
let sseConstructorSpy: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let handlers: { message?: (data: string) => void; open?: () => void; error?: (event: Event) => void };

vi.mock('../../core/SSEClient', () => {
  const MockSSEClient = function (this: any, ...args: unknown[]) {
    sseConstructorSpy(...args);
    Object.assign(this, mockSSEInstance);
    return this;
  } as any;
  MockSSEClient.prototype = {};
  return { SSEClient: MockSSEClient };
});

function event(overrides: Partial<LiveAssistEvent> = {}): LiveAssistEvent {
  return { consultationId: 'c-1', updatedAt: '2026-09-03T00:00:00.000Z', ...overrides };
}

const SUGGESTION = { suggestionId: 's-1', text: 'Ask about onset', category: 'history' };
const CORRECTIONS = {
  proposals: [{ proposalId: 'p-1', start: 10, end: 21, original: 'metoprolal', proposed: 'metoprolol', category: 'drugName' }],
  applied: false,
};

describe('useArcaLiveAssist', () => {
  let mockStore: any;

  beforeEach(() => {
    sseConstructorSpy = vi.fn<(...args: unknown[]) => void>();
    handlers = {};
    mockSSEInstance = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onEvent: vi.fn(),
      onError: vi.fn((cb: (e: Event) => void) => {
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
        getStreamBaseUrl: vi.fn().mockReturnValue('http://localhost:8868/api/v1'),
      },
      logger: createMockLogger(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  it('stays idle with no consultation id', () => {
    const { result } = renderHook(() => useArcaLiveAssist());
    expect(result.current.status).toBe('idle');
    expect(result.current.connected).toBe(false);
    expect(result.current.lastEvent).toBeNull();
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.corrections).toBeNull();
    expect(sseConstructorSpy).not.toHaveBeenCalled();
  });

  it('connects with the live-assist ticket scope and stream URL', () => {
    const { result } = renderHook(() => useArcaLiveAssist());
    act(() => result.current.start('c-1'));

    expect(sseConstructorSpy).toHaveBeenCalledTimes(1);
    expect(sseConstructorSpy.mock.calls[0]![0]).toBe(liveAssistScopeFor('c-1'));
    expect(mockSSEInstance.connect).toHaveBeenCalledWith(`http://localhost:8868/api/v1${CONSULTATION_ENDPOINTS.LIVE_ASSIST_STREAM('c-1')}`, {
      autoReconnect: true,
    });
    expect(result.current.status).toBe('connecting');
  });

  it('auto-connects when a consultation id is passed, and follows an id change', () => {
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useArcaLiveAssist(id), { initialProps: { id: 'c-1' } });

    expect(sseConstructorSpy).toHaveBeenCalledTimes(1);
    expect(sseConstructorSpy.mock.calls[0]![0]).toBe(liveAssistScopeFor('c-1'));

    rerender({ id: 'c-2' });
    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(sseConstructorSpy).toHaveBeenCalledTimes(2);
    expect(sseConstructorSpy.mock.calls[1]![0]).toBe(liveAssistScopeFor('c-2'));
    expect(result.current.status).toBe('connecting');
  });

  it('flips to open and reports connected', () => {
    const { result } = renderHook(() => useArcaLiveAssist('c-1'));
    act(() => handlers.open?.());
    expect(result.current.status).toBe('open');
    expect(result.current.connected).toBe(true);
  });

  it('surfaces both branches of a full-state snapshot', () => {
    const { result } = renderHook(() => useArcaLiveAssist('c-1'));
    act(() => handlers.message?.(JSON.stringify(event({ suggestions: [SUGGESTION], corrections: CORRECTIONS, model: 'a-model' }))));

    expect(result.current.suggestions).toEqual([SUGGESTION]);
    expect(result.current.corrections).toEqual(CORRECTIONS);
    expect(result.current.corrections?.applied).toBe(false);
    expect(result.current.lastEvent?.model).toBe('a-model');
  });

  it('takes each snapshot as the whole truth — a branch the server omits is cleared, never merged', () => {
    const { result } = renderHook(() => useArcaLiveAssist('c-1'));
    act(() => handlers.message?.(JSON.stringify(event({ suggestions: [SUGGESTION], corrections: CORRECTIONS }))));
    // The gateway folds both branches onto every publish, so an ABSENT branch
    // means "there are none" — a client-side merge would resurrect stale PHI.
    act(() => handlers.message?.(JSON.stringify(event({ suggestions: [SUGGESTION] }))));

    expect(result.current.suggestions).toEqual([SUGGESTION]);
    expect(result.current.corrections).toBeNull();
  });

  it('ignores malformed events without throwing (advisory feed fails open)', () => {
    const { result } = renderHook(() => useArcaLiveAssist('c-1'));
    act(() => handlers.message?.(JSON.stringify(event({ suggestions: [SUGGESTION] }))));
    act(() => handlers.message?.('not-json'));

    expect(result.current.suggestions).toEqual([SUGGESTION]);
    expect(result.current.status).toBe('connecting');
    expect(result.current.error).toBeNull();
  });

  it('surfaces a connection error without throwing', () => {
    const { result } = renderHook(() => useArcaLiveAssist('c-1'));
    act(() => handlers.error?.(new Event('error')));
    expect(result.current.status).toBe('error');
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('stop() disconnects and closes — the feed has no terminal event', () => {
    const { result } = renderHook(() => useArcaLiveAssist());
    act(() => result.current.start('c-1'));
    act(() => result.current.stop());
    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(result.current.status).toBe('closed');
  });

  it('replaces a prior stream when start() is called again (single-use tickets)', () => {
    const { result } = renderHook(() => useArcaLiveAssist());
    act(() => result.current.start('c-1'));
    act(() => result.current.start('c-2'));
    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(sseConstructorSpy).toHaveBeenCalledTimes(2);
    expect(sseConstructorSpy.mock.calls[1]![0]).toBe(liveAssistScopeFor('c-2'));
  });

  it('disconnects on unmount so a navigating consumer never leaks the connection', () => {
    const { unmount } = renderHook(() => useArcaLiveAssist('c-1'));
    unmount();
    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
  });

  it('throws when the SDK is not initialized', () => {
    mockStore.apiClient = null;
    (useAgenticStore as any).mockReturnValue(mockStore);
    const { result } = renderHook(() => useArcaLiveAssist());
    expect(() => result.current.start('c-1')).toThrow('SDK not initialized');
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
