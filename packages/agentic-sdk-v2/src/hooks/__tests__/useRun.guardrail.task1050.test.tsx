/**
 * TASK-1050 W2d — `useRun` and guardrail notices: `onGuardrailNotice` once per notice id, the `guardrailNotices` slice
 * (deduplicated), and `run.paused` is NOT terminal — the EventSource stays open and the run goes on to complete.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { FakeEventSource } from '../../__tests__/mocks/fakeEventSource';
import { useRun } from '../useRun';

const apiClient = {
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  get: vi.fn(),
  requestRaw: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined }),
}));

const notice = (id: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  noticeId: id,
  type: 'guardrail.blocked',
  direction: 'outbound',
  action: 'block',
  checks: [{ checkId: 'leakage_judge', severity: 'high' }],
  itemIds: [],
  messageKey: 'guardrail.blocked.outbound',
  defaultMessage: 'A safety check withheld the generated content. Review it to continue.',
  requiresAcknowledgement: true,
  resumable: true,
  policyVersion: 'pv-1',
  occurredAt: '2026-10-07T09:15:00.000Z',
  ...over,
});
const warning = (id: string) =>
  notice(id, { type: 'guardrail.warning', action: 'warn', messageKey: 'guardrail.warning.generic', defaultMessage: 'A safety check flagged this content. Review it before you rely on it.', resumable: false });

const tuning = { reconnectDelayMs: 0 };
const lastSource = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  apiClient.postWithHeaders.mockResolvedValue({ runId: 'run-1', status: 'started' });
  apiClient.post.mockImplementation(async () => ({ ticket: 'tk', sseUrl: '/api/v1/workflows/note-writer/runs/run-1/stream?protocol=2&ticket=tk' }));
  apiClient.requestRaw.mockImplementation(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'x-hope-result-kind': 'inline' } }));
});
afterEach(() => vi.unstubAllGlobals());

async function started(onGuardrailNotice?: (n: unknown) => void) {
  const hook = renderHook(() => useRun({ workflow: 'note-writer', onGuardrailNotice: onGuardrailNotice as never, ...tuning }));
  await act(async () => {
    await hook.result.current.start({ note: 'n' });
  });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = lastSource();
  act(() => source.open());
  return { ...hook, source };
}

describe('useRun — guardrail notices', () => {
  it('subscribes to the new public events by name', async () => {
    const { source } = await started();
    expect(source.listeners.has('guardrail.notice')).toBe(true);
    expect(source.listeners.has('run.paused')).toBe(true);
  });

  it('calls onGuardrailNotice once per notice id and keeps a deduplicated slice', async () => {
    const seen: string[] = [];
    const { result, source } = await started((n) => seen.push((n as { noticeId: string }).noticeId));

    act(() => {
      source.emitV2('guardrail.notice', 1, warning('w1'), 'n_note');
      source.emitV2('guardrail.notice', 2, warning('w1'), 'n_note'); // same notice again
      source.emitV2('guardrail.notice', 3, warning('w2'));
      source.emitV2('run.completed', 4, { status: 'COMPLETED', durationMs: 5, tokens: { in: 1, out: 2 }, guardrailNotices: [warning('w1'), warning('w3')] });
    });

    expect(seen).toEqual(['w1', 'w2', 'w3']);
    expect(result.current.guardrailNotices.map((n) => n.noticeId)).toEqual(['w1', 'w2', 'w3']);
    await waitFor(() => expect(result.current.result).toEqual({ text: 'ok' }));
  });

  it('run.paused is not terminal: status stays RUNNING, the stream stays open, and the run later completes', async () => {
    const { result, source } = await started();

    act(() => {
      source.emitV2('guardrail.notice', 1, notice('b1'), 'n_note');
      source.emitV2('run.paused', 2, { reason: 'guardrail_hold', noticeId: 'b1', nodeId: 'n_note' });
    });

    expect(result.current.status).toBe('RUNNING');
    expect(result.current.paused).toEqual({ noticeId: 'b1', nodeId: 'n_note', reason: 'guardrail_hold' });
    expect(source.closed).toBe(false);
    expect(apiClient.requestRaw).not.toHaveBeenCalled();

    act(() => {
      source.emitV2('node.started', 3, { kind: 'core.agent' }, 'n_note');
    });
    expect(result.current.paused).toBeNull();

    act(() => {
      source.emitV2('run.completed', 4, { status: 'COMPLETED', durationMs: 5, tokens: { in: 1, out: 2 } });
    });
    expect(result.current.status).toBe('COMPLETED');
    expect(source.closed).toBe(true);
  });
});
