/**
 * `useConsultationWorkflow`, the discovery hook.
 *
 * The behaviour worth pinning is the FAIL-OPEN posture. A consultation UI must
 * not break because an informational read failed, so a failed read resolves to
 * `null` instead of rejecting — and `null` must stay distinguishable from
 * "the default engine governs", which is a real, known answer.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useConsultationWorkflow } from '../useConsultationWorkflow';
import type { ConsultationWorkflow } from '../../types/consultationWorkflow';

const get = vi.fn();
let sessionConsultation: { id: string } | null = null;

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = { consultation: sessionConsultation };
    return typeof selector === 'function' ? selector(state) : state;
  }),
  selectConsultation: (s: { consultation: { id: string } | null }) => s.consultation,
}));

vi.mock('../useApiOperation', () => ({
  useApiOperation: () => ({
    execute: async <T>(_name: string, fn: (client: { get: typeof get }) => Promise<T>) => fn({ get }),
    isLoading: false,
    error: null,
  }),
}));

const GOVERNED: ConsultationWorkflow = {
  consultationId: 'c-1',
  governed: true,
  workflowDefinitionSlug: 'caller_picked_v1',
  workflowRunId: 'run-1',
  decidedAt: '2026-08-29T00:00:00.000Z',
  name: 'Caller Picked',
  description: null,
  paletteKey: 'consultation',
  activeVersionNumber: 3,
  inputSchema: null,
};

describe('useConsultationWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionConsultation = null;
  });

  it('reads the explicit consultation id', async () => {
    get.mockResolvedValue(GOVERNED);
    const { result } = renderHook(() => useConsultationWorkflow('c-1'));

    await waitFor(() => expect(result.current.workflow).toEqual(GOVERNED));
    expect(get).toHaveBeenCalledWith('/consultations/c-1/workflow');
    expect(result.current.isGoverned).toBe(true);
  });

  it('falls back to the session consultation when no id is passed', async () => {
    sessionConsultation = { id: 'session-c' };
    get.mockResolvedValue({ ...GOVERNED, consultationId: 'session-c' });

    const { result } = renderHook(() => useConsultationWorkflow());

    await waitFor(() => expect(result.current.workflow).not.toBeNull());
    expect(get).toHaveBeenCalledWith('/consultations/session-c/workflow');
  });

  it('reads nothing at all when there is no consultation yet', async () => {
    const { result } = renderHook(() => useConsultationWorkflow());

    await waitFor(() => expect(result.current.workflow).toBeNull());
    expect(get).not.toHaveBeenCalled();
  });

  it('FAILS OPEN — a failed read resolves to null instead of rejecting', async () => {
    get.mockRejectedValue(new Error('gateway unreachable'));
    const { result } = renderHook(() => useConsultationWorkflow('c-1'));

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current.workflow).toBeNull();
    await expect(result.current.refresh()).resolves.toBeNull();
  });

  it('keeps "unknown" distinct from "the default engine governs"', async () => {
    get.mockResolvedValue({ ...GOVERNED, governed: false, workflowDefinitionSlug: null, workflowRunId: null });
    const { result } = renderHook(() => useConsultationWorkflow('c-1'));

    await waitFor(() => expect(result.current.workflow).not.toBeNull());
    // A resolved answer of "the default engine governs" — NOT the same state as a failed read.
    expect(result.current.workflow?.governed).toBe(false);
    expect(result.current.isGoverned).toBe(false);
  });

  it('re-reads when the consultation changes', async () => {
    get.mockResolvedValue(GOVERNED);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useConsultationWorkflow(id), { initialProps: { id: 'c-1' } });

    await waitFor(() => expect(result.current.workflow).not.toBeNull());
    rerender({ id: 'c-2' });

    await waitFor(() => expect(get).toHaveBeenCalledWith('/consultations/c-2/workflow'));
  });
});
