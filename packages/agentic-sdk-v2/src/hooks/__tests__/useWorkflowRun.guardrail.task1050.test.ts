/**
 * TASK-1050 W2d — the legacy `useWorkflowRun` stream: `guardrail.notice` frames reach `onGuardrailNotice` once per
 * notice id, and a `run.paused` frame neither finishes the run nor closes the stream.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorkflowRun } from '../useWorkflowRun';

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
};
vi.mock('../../store', () => ({ useAgenticStore: () => ({ apiClient, logger: undefined }) }));

let namedListeners: Map<string, (data: string) => void>;
let disconnectCount = 0;
vi.mock('../../core/SSEClient', () => ({
  SSEClient: class {
    constructor() {
      namedListeners = new Map();
    }
    onEvent(name: string, cb: (data: string) => void): void {
      namedListeners.set(name, cb);
    }
    onError(): void {}
    onOpen(): void {}
    connect(): void {}
    disconnect(): void {
      disconnectCount += 1;
    }
    getLastEventId(): string | null {
      return null;
    }
  },
}));

const NOTICE = {
  schemaVersion: 1,
  noticeId: 'n1',
  type: 'guardrail.warning',
  direction: 'inbound',
  action: 'warn',
  checks: [],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: 'A safety check flagged this content. Review it before you rely on it.',
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: 't',
};

function emit(type: string, field: 'data' | 'payload', body: Record<string, unknown>): void {
  const envelope = { schemaVersion: 1, id: 'e', tenantId: 't', type, occurredAt: 't', correlationId: 'run-1', causationId: null, idempotencyKey: 'k', [field]: body };
  act(() => {
    namedListeners.get(type)?.(JSON.stringify(envelope));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  disconnectCount = 0;
  apiClient.get.mockResolvedValue({ data: [] });
  apiClient.post.mockResolvedValue({ runId: 'run-1', status: 'started' });
  apiClient.postWithHeaders.mockResolvedValue({ runId: 'run-1', status: 'started' });
});
afterEach(() => vi.restoreAllMocks());

describe('useWorkflowRun — guardrail frames', () => {
  it('subscribes to guardrail.notice and run.paused', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));
    await act(async () => {
      await result.current.start('s', {});
    });
    expect(namedListeners.has('guardrail.notice')).toBe(true);
    expect(namedListeners.has('run.paused')).toBe(true);
  });

  it('announces each notice id once (data- or payload-shaped), and a paused run keeps running with the stream open', async () => {
    const seen: string[] = [];
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true, onGuardrailNotice: (n) => seen.push(n.noticeId) }));
    await act(async () => {
      await result.current.start('s', {});
    });
    const before = disconnectCount;

    emit('guardrail.notice', 'data', NOTICE);
    emit('guardrail.notice', 'payload', NOTICE);
    emit('guardrail.notice', 'data', { nope: true });
    emit('run.paused', 'data', { reason: 'guardrail_hold', noticeId: 'n1', nodeId: 'x' });

    expect(seen).toEqual(['n1']);
    expect(result.current.events.map((e) => e.type)).toEqual(['guardrail.notice', 'guardrail.notice', 'guardrail.notice', 'run.paused']);
    expect(result.current.isRunning).toBe(true);
    expect(disconnectCount).toBe(before);
  });
});
