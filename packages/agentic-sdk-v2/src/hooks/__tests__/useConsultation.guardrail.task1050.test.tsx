/**
 * TASK-1050 W2d — `useConsultation` guardrail surface: notices read and deduplicated by noticeId, the hold fetch when
 * `processingReason` reports a hold, `If-Match` on ack and resume, approve additions, and `noteReady` while held.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConsultation } from '../useConsultation';
import type { GuardrailNotice } from '../../core/guardrail';

const apiClient = { get: vi.fn(), post: vi.fn(), postWithHeaders: vi.fn(), postFormData: vi.fn() };
const storeValue = { apiClient, logger: undefined, pluginManager: null, setConsultation: vi.fn() };

vi.mock('../../store', () => ({ useAgenticStore: () => storeValue }));

const session = {
  consultation: { id: 'c1', status: 'PAUSED', processing: 'AWAITING_REVIEW', processingReason: 'GUARDRAIL_HOLD', version: 6 } as Record<
    string,
    unknown
  > | null,
  error: null,
  open: vi.fn(),
  close: vi.fn(),
  reopen: vi.fn(),
  addContext: vi.fn(),
};
const audio = { isCapturing: false, level: 0, transcriptSegments: [] as unknown[], error: null, start: vi.fn(), stop: vi.fn() };
const summary = { generateSummaryAsync: vi.fn() };
vi.mock('../useArcaSession', () => ({ useArcaSession: () => session }));
vi.mock('../useArcaAudio', () => ({ useArcaAudio: () => audio }));
vi.mock('../useArcaSummary', () => ({ useArcaSummary: () => summary }));

const notice = (id: string, over: Record<string, unknown> = {}): GuardrailNotice =>
  ({
    schemaVersion: 1,
    noticeId: id,
    type: 'guardrail.blocked',
    direction: 'inbound',
    action: 'block',
    checks: [{ checkId: 'injection_judge', severity: 'high' }],
    itemIds: ['i1'],
    messageKey: 'guardrail.blocked.inbound',
    defaultMessage: 'A safety check stopped this request. Review the flagged input to continue.',
    requiresAcknowledgement: false,
    resumable: true,
    policyVersion: 'pv',
    occurredAt: 't',
    ...over,
  }) as unknown as GuardrailNotice;

beforeEach(() => {
  vi.clearAllMocks();
  session.consultation = { id: 'c1', status: 'PAUSED', processing: 'AWAITING_REVIEW', processingReason: 'GUARDRAIL_HOLD', version: 6 };
  apiClient.get.mockResolvedValue([notice('n1')]);
});

describe('useConsultation — guardrail hold', () => {
  it('reports the hold, is never noteReady while held, and reads the notices once', async () => {
    session.consultation = { id: 'c1', status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: 'GUARDRAIL_HOLD', version: 6 };
    const { result, rerender } = renderHook(() => useConsultation());

    expect(result.current.onGuardrailHold).toBe(true);
    expect(result.current.noteReady).toBe(false);
    await waitFor(() => expect(result.current.guardrailNotices.map((n) => n.noticeId)).toEqual(['n1']));
    rerender();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith('/consultations/c1/guardrail-notices');
  });

  it('a human-review AWAITING_REVIEW without a hold is still noteReady and reads no notices', async () => {
    session.consultation = { id: 'c1', status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: 'COVERAGE_GAPS', version: 6 };
    const { result } = renderHook(() => useConsultation());
    expect(result.current.onGuardrailHold).toBe(false);
    expect(result.current.noteReady).toBe(true);
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('deduplicates by noticeId across refresh and addGuardrailNotices', async () => {
    const { result } = renderHook(() => useConsultation());
    await waitFor(() => expect(result.current.guardrailNotices).toHaveLength(1));

    act(() => result.current.addGuardrailNotices([notice('n1'), notice('n2')]));
    expect(result.current.guardrailNotices.map((n) => n.noticeId)).toEqual(['n1', 'n2']);

    apiClient.get.mockResolvedValue({ notices: [notice('n2'), notice('n3')] });
    await act(async () => {
      await result.current.refreshGuardrailNotices();
    });
    expect(result.current.guardrailNotices.map((n) => n.noticeId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('resumeHold POSTs { noticeId, resolution } with the version as a strong If-Match and follows the answer', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ id: 'c1', status: 'STOPPED', processing: 'SUMMARIZING', processingReason: null, version: 7 });
    const { result } = renderHook(() => useConsultation());
    await waitFor(() => expect(result.current.guardrailNotices).toHaveLength(1));

    await act(async () => {
      await result.current.resumeHold({ noticeId: 'n1', resolution: 'item_excluded' });
    });

    expect(apiClient.postWithHeaders).toHaveBeenCalledWith(
      '/consultations/c1/guardrail-hold/resume',
      { noticeId: 'n1', resolution: 'item_excluded' },
      expect.objectContaining({ 'X-Hope-Lifecycle': '2', 'If-Match': '"6"' }),
    );
    expect(result.current.processing).toBe('SUMMARIZING');
    expect(result.current.onGuardrailHold).toBe(false);
  });

  it('acknowledgeNotice POSTs the ack route with If-Match and tolerates a thin answer', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ noticeId: 'n1', acknowledgedVia: 'ack' });
    const { result } = renderHook(() => useConsultation());
    await waitFor(() => expect(result.current.guardrailNotices).toHaveLength(1));

    await act(async () => {
      await result.current.acknowledgeNotice('n/1');
    });

    expect(apiClient.postWithHeaders).toHaveBeenCalledWith(
      '/consultations/c1/guardrail-notices/n%2F1/ack',
      {},
      expect.objectContaining({ 'If-Match': '"6"' }),
    );
    expect(storeValue.setConsultation).not.toHaveBeenCalled();
    expect(result.current.onGuardrailHold).toBe(true);
  });

  it('approve sends the acknowledge / resolveHold additions with If-Match and returns acknowledgedNotices', async () => {
    const acknowledged = [{ noticeId: 'n1', acknowledgedBy: 'u1', acknowledgedVia: 'approve', acknowledgedAt: 't' }];
    apiClient.postWithHeaders.mockResolvedValue({
      id: 'c1',
      status: 'APPROVED',
      processing: 'IDLE',
      processingReason: null,
      version: 7,
      acknowledgedNotices: acknowledged,
    });
    const { result } = renderHook(() => useConsultation());

    let response: { acknowledgedNotices?: unknown } | undefined;
    await act(async () => {
      response = await result.current.approve({ acknowledgeGuardrailNotices: true, resolveHold: { noticeId: 'n1', resolution: 'item_excluded' } });
    });

    expect(apiClient.postWithHeaders).toHaveBeenCalledWith(
      '/consultations/c1/approve',
      { acknowledgeGuardrailNotices: true, resolveHold: { noticeId: 'n1', resolution: 'item_excluded' } },
      expect.objectContaining({ 'If-Match': '"6"' }),
    );
    expect(response?.acknowledgedNotices).toEqual(acknowledged);
    expect(result.current.status).toBe('APPROVED');
  });

  it('a plain approve keeps its old body', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ id: 'c1', status: 'APPROVED', processing: 'IDLE', version: 7 });
    const { result } = renderHook(() => useConsultation());
    await act(async () => {
      await result.current.approve({ overrideSafetyFlag: true });
    });
    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/consultations/c1/approve', { overrideSafetyFlag: true }, expect.anything());
  });
});
