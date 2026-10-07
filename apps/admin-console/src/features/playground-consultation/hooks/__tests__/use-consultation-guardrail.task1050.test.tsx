/**
 * TASK-1050 W3b — the consultation playground's guardrail orchestration (README OD-15, §9.7.5, §9.8.1):
 *   - a warning on the FINAL note opens the modal once; live / partial warnings toast once per check
 *     per consultation and never open the modal;
 *   - "Acknowledge and continue" acknowledges every listed notice;
 *   - an open block is the blocking notice, and resume posts the chosen resolution;
 *   - a failed generation or command that is a guardrail outcome is handled (no generic toast).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import { createTestQueryClient } from '@/test/render';
import { useConsultationGuardrail } from '../use-consultation-guardrail';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const warning = (noticeId: string, itemIds: string[], checkId = 'clinical_safety_judge') => ({
  schemaVersion: 1,
  noticeId,
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId, category: 'dangerous_dosing', severity: 'high' }],
  itemIds,
  messageKey: 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
  status: 'open',
});

const blocked = {
  ...warning('b-1', ['seg-1'], 'injection_judge'),
  type: 'guardrail.blocked',
  action: 'block',
  direction: 'inbound',
  messageKey: 'guardrail.blocked.inbound',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
  requiresAcknowledgement: false,
  resumable: true,
};

interface Call {
  method: string;
  path: string;
  ifMatch: string | null;
  body: unknown;
}

function stubFetch(notices: unknown[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://t').pathname;
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        ifMatch: new Headers(init?.headers).get('if-match'),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (method === 'GET' && path === '/api/hope/consultations/c-1/guardrail-notices')
        return Response.json({ notices, unacknowledgedNoticeIds: [] });
      if (method === 'GET' && path === '/api/hope/consultations/c-1') return Response.json({ id: 'c-1', version: 5 }, { headers: { etag: '"5"' } });
      if (method === 'POST') return Response.json({ ok: true });
      throw new Error(`unrouted ${method} ${path}`);
    }),
  );
  return calls;
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.warning.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('useConsultationGuardrail', () => {
  it('opens the modal for a warning on the final note, and does not toast it', async () => {
    stubFetch([warning('w-final', ['note-1'])]);
    const { result } = renderHook(() => useConsultationGuardrail({ consultationId: 'c-1', draftId: 'note-1', isRecording: false }), { wrapper });
    await waitFor(() => expect(result.current.dialog.open).toBe(true));
    expect(result.current.dialog.notices.map((notice) => notice.noticeId)).toEqual(['w-final']);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('toasts live warnings once per check per consultation and never opens the modal', async () => {
    stubFetch([warning('w-1', ['seg-1']), warning('w-2', ['seg-2']), warning('w-3', ['seg-3'], 'leakage_judge')]);
    const { result } = renderHook(() => useConsultationGuardrail({ consultationId: 'c-1', draftId: null, isRecording: false }), { wrapper });
    await waitFor(() => expect(result.current.liveWarnings).toHaveLength(3));
    expect(toastMock.warning).toHaveBeenCalledTimes(2);
    expect(result.current.dialog.open).toBe(false);
  });

  it('acknowledges every listed notice from the modal, each under a fresh If-Match', async () => {
    const calls = stubFetch([warning('w-a', ['note-1']), warning('w-b', ['note-1'], 'leakage_judge')]);
    const { result } = renderHook(() => useConsultationGuardrail({ consultationId: 'c-1', draftId: 'note-1', isRecording: false }), { wrapper });
    await waitFor(() => expect(result.current.dialog.open).toBe(true));
    act(() => result.current.dialog.onAcknowledge(['w-a', 'w-b']));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2));
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.path)).toEqual([
      '/api/hope/consultations/c-1/guardrail-notices/w-a/ack',
      '/api/hope/consultations/c-1/guardrail-notices/w-b/ack',
    ]);
    expect(posts.every((call) => call.ifMatch === '"5"')).toBe(true);
  });

  it('exposes an open block as the blocking notice and resumes it with the chosen resolution', async () => {
    const calls = stubFetch([blocked]);
    const onResumed = vi.fn();
    const { result } = renderHook(() => useConsultationGuardrail({ consultationId: 'c-1', draftId: null, isRecording: false, onResumed }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.blocking?.noticeId).toBe('b-1'));
    act(() => result.current.resume({ noticeId: 'b-1', resolution: 'item_excluded' }));
    await waitFor(() => expect(onResumed).toHaveBeenCalled());
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ noticeId: 'b-1', resolution: 'item_excluded' });
  });

  it('handles a guardrail error (no generic toast) and leaves other errors to the caller', async () => {
    stubFetch([]);
    const { result } = renderHook(() => useConsultationGuardrail({ consultationId: 'c-1', draftId: null, isRecording: false }), { wrapper });
    let handled = false;
    act(() => {
      handled = result.current.handleError(new GatewayError(422, 'x', undefined, { code: 'CONTENT_BLOCKED_NOT_MEDICAL' }));
    });
    expect(handled).toBe(true);
    expect(result.current.errorBlock).toMatchObject({ code: 'CONTENT_BLOCKED_NOT_MEDICAL' });
    expect(result.current.handleError(new GatewayError(500, 'boom'))).toBe(false);
  });

  it('a completed note job with warnings opens the modal; a guardrail-failed job is handled', async () => {
    stubFetch([]);
    const { result } = renderHook(() => useConsultationGuardrail({ consultationId: 'c-1', draftId: null, isRecording: false }), { wrapper });
    act(() => {
      result.current.handleJobTerminal({ jobId: 'j', status: 'COMPLETED', result: { guardrailNotices: [warning('w-job', [])] } });
    });
    await waitFor(() => expect(result.current.dialog.open).toBe(true));
    let handled = false;
    act(() => {
      handled = result.current.handleJobTerminal({ jobId: 'j2', status: 'FAILED', error: 'CONTENT_BLOCKED' });
    });
    expect(handled).toBe(true);
  });
});
