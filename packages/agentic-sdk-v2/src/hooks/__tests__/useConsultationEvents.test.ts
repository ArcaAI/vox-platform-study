/**
 * useConsultationEvents Hook Tests (TASK-665)
 *
 * Modeled directly on `useArcaLiveSummary.test.ts` (the leaner SSE-hook
 * exemplar this hook copies).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConsultationEvents } from '../useConsultationEvents';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS, loopEventsScopeFor } from '../../core/constants';
import type { LoopEvent } from '../../types/loopEvent';

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

function loopEvent(overrides: Partial<LoopEvent> = {}): LoopEvent {
  return { consultationId: 'c-1', kind: 'action.started', publishedAt: '2026-08-12T00:00:00.000Z', ...overrides };
}

describe('useConsultationEvents', () => {
  let mockStore: any;

  beforeEach(() => {
    sseConstructorSpy = vi.fn<(...args: unknown[]) => void>();
    handlers = {};
    mockSSEInstance = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onEvent: vi.fn(),
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
        getStreamBaseUrl: vi.fn().mockReturnValue('http://localhost:8868/api/v1'),
      },
      logger: createMockLogger(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  it('starts idle with no events', () => {
    const { result } = renderHook(() => useConsultationEvents());
    expect(result.current.status).toBe('idle');
    expect(result.current.events).toEqual([]);
    expect(result.current.latestEvent).toBeNull();
  });

  it('connects with the loop scope + URL and reports connecting', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));

    expect(sseConstructorSpy).toHaveBeenCalledTimes(1);
    expect(sseConstructorSpy.mock.calls[0]![0]).toBe(loopEventsScopeFor('c-1'));
    expect(mockSSEInstance.connect).toHaveBeenCalledWith(`http://localhost:8868/api/v1${CONSULTATION_ENDPOINTS.LOOP_STREAM('c-1')}`, {
      autoReconnect: true,
    });
    expect(result.current.status).toBe('connecting');
  });

  it('flips to open, then appends each discrete event (not a fold)', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));
    act(() => handlers.open?.());
    expect(result.current.status).toBe('open');

    act(() => handlers.message?.(JSON.stringify(loopEvent({ kind: 'action.started', label: 'Draft SOAP note' }))));
    act(() => handlers.message?.(JSON.stringify(loopEvent({ kind: 'action.completed', label: 'Draft SOAP note' }))));

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]!.kind).toBe('action.started');
    expect(result.current.events[1]!.kind).toBe('action.completed');
    expect(result.current.latestEvent?.kind).toBe('action.completed');
  });

  it('ignores heartbeat pings — they never enter the event log', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));
    act(() => handlers.message?.(JSON.stringify({ type: 'heartbeat', ts: '2026-08-12T00:00:00.000Z' })));

    expect(result.current.events).toEqual([]);
    expect(result.current.latestEvent).toBeNull();
  });

  it('ignores malformed / non-LoopEvent-shaped messages without throwing', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));

    act(() => handlers.message?.('not-json'));
    act(() => handlers.message?.(JSON.stringify({ noKindField: true })));

    expect(result.current.events).toEqual([]);
    expect(result.current.status).toBe('connecting');
  });

  it('surfaces a connection error', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));
    act(() => handlers.error?.(new Event('error')));

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('stop() disconnects and closes', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));
    act(() => result.current.stop());

    expect(mockSSEInstance.disconnect).toHaveBeenCalled();
    expect(result.current.status).toBe('closed');
  });

  it('start() tears down any prior connection before opening a new one (no zombie EventSource)', () => {
    const { result } = renderHook(() => useConsultationEvents());
    act(() => result.current.start('c-1'));
    act(() => result.current.start('c-2'));

    expect(mockSSEInstance.disconnect).toHaveBeenCalledTimes(1);
    expect(sseConstructorSpy).toHaveBeenCalledTimes(2);
    expect(sseConstructorSpy.mock.calls[1]![0]).toBe(loopEventsScopeFor('c-2'));
  });
});
