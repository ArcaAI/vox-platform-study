/**
 * TASK-1050 W3b round 2 — the TEXT task stream exposes guardrail notices: each `guardrail.notice` event
 * as it arrives (W2b relays the validated notice as the frame's data), plus the `guardrailNotices` of the
 * terminal `done` / `error` frame — deduplicated by noticeId, and re-validated (free text never surfaces).
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { useTaskStream } from '../use-task-stream';

const captured = vi.hoisted(() => ({ onEvent: null as null | ((type: string, data: string) => void), eventNames: [] as readonly string[] }));

vi.mock('../use-event-stream', () => ({
  useEventStream: (options: { onEvent: (type: string, data: string) => void; eventNames: readonly string[] }) => {
    captured.onEvent = options.onEvent;
    captured.eventNames = options.eventNames;
    return { status: 'open', error: null, close: vi.fn(), reopen: vi.fn() };
  },
}));

const notice = (noticeId: string, type: 'guardrail.warning' | 'guardrail.blocked' = 'guardrail.warning') => ({
  schemaVersion: 1,
  noticeId,
  type,
  direction: 'outbound',
  action: type === 'guardrail.blocked' ? 'block' : 'warn',
  checks: [{ checkId: 'clinical_safety_judge', category: 'dangerous_dosing', severity: 'high' }],
  itemIds: [],
  messageKey: type === 'guardrail.blocked' ? 'guardrail.blocked.outbound' : 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES[type === 'guardrail.blocked' ? 'guardrail.blocked.outbound' : 'guardrail.warning.generic'],
  requiresAcknowledgement: false,
  resumable: type === 'guardrail.blocked',
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
});

describe('useTaskStream — guardrail notices', () => {
  it('subscribes to guardrail.notice and exposes each notice as it arrives, once per noticeId', () => {
    const { result } = renderHook(() => useTaskStream('t-1'));
    expect(captured.eventNames).toContain('guardrail.notice');
    act(() => {
      captured.onEvent?.('guardrail.notice', JSON.stringify(notice('n-1')));
      captured.onEvent?.('guardrail.notice', JSON.stringify(notice('n-1')));
      captured.onEvent?.('guardrail.notice', JSON.stringify({ ...notice('n-x'), defaultMessage: 'free text' }));
    });
    expect(result.current.guardrailNotices.map((entry) => entry.noticeId)).toEqual(['n-1']);
    expect(result.current.status).toBe('streaming');
  });

  it('merges the done frame guardrailNotices', () => {
    const { result } = renderHook(() => useTaskStream('t-2'));
    act(() => {
      captured.onEvent?.('chunk', JSON.stringify({ type: 'chunk', content: 'Hello' }));
      captured.onEvent?.('guardrail.notice', JSON.stringify(notice('n-1')));
      captured.onEvent?.('done', JSON.stringify({ type: 'done', data: { finish_reason: 'stop', guardrailNotices: [notice('n-1'), notice('n-2')] } }));
    });
    expect(result.current.status).toBe('done');
    expect(result.current.content).toBe('Hello');
    expect(result.current.guardrailNotices.map((entry) => entry.noticeId)).toEqual(['n-1', 'n-2']);
  });

  it('keeps the notice of a failed (blocked) stream from its error frame', () => {
    const { result } = renderHook(() => useTaskStream('t-3'));
    act(() => {
      captured.onEvent?.(
        'error',
        JSON.stringify({ type: 'error', data: { error: 'Blocked by guardrail', guardrailNotice: notice('b-1', 'guardrail.blocked') } }),
      );
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.guardrailNotices.map((entry) => entry.type)).toEqual(['guardrail.blocked']);
  });
});
