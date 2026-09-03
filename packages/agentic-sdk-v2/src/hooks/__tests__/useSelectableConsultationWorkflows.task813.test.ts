/**
 * `useSelectableConsultationWorkflows`, the picker's data source.
 *
 * Two behaviours are worth pinning, and they pull in opposite directions:
 *
 *   * the read FAILS OPEN, like its sibling `useConsultationWorkflow` — an unreachable
 *     discovery read must never surface as an unhandled rejection in a consultation UI;
 *   * but failing open must not manufacture an ANSWER. `null` ("we could not ask") stays
 *     distinct from `[]` ("the tenant has published none, so the default engine governs"),
 *     because a picker that renders "no workflows available" on a network blip tells the
 *     clinician something false about their tenant.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSelectableConsultationWorkflows } from '../useSelectableConsultationWorkflows';
import type { SelectableConsultationWorkflow } from '../../types/consultationWorkflow';

const get = vi.fn();

vi.mock('../useApiOperation', () => ({
  useApiOperation: () => ({
    execute: async <T>(_name: string, fn: (client: { get: typeof get }) => Promise<T>) => fn({ get }),
    isLoading: false,
    error: null,
  }),
}));

const SELECTABLE: SelectableConsultationWorkflow[] = [
  { slug: 'clinic_intake_v1', name: 'Clinic Intake', description: 'The standard intake graph', isTenantDefault: true },
  { slug: 'telehealth_v2', name: 'Telehealth', description: null, isTenantDefault: false },
];

describe('useSelectableConsultationWorkflows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the tenant selectable set — no id, no tenant, no department in the request', async () => {
    get.mockResolvedValue({ data: SELECTABLE });
    const { result } = renderHook(() => useSelectableConsultationWorkflows());

    await waitFor(() => expect(result.current.workflows).toEqual(SELECTABLE));
    expect(get).toHaveBeenCalledWith('/consultations/workflows');
  });

  it('surfaces the tenant default so a picker can preselect it', async () => {
    get.mockResolvedValue({ data: SELECTABLE });
    const { result } = renderHook(() => useSelectableConsultationWorkflows());

    await waitFor(() => expect(result.current.workflows).not.toBeNull());
    expect(result.current.tenantDefault?.slug).toBe('clinic_intake_v1');
  });

  it('reports no default when the tenant has assigned nothing selectable', async () => {
    get.mockResolvedValue({ data: [{ ...SELECTABLE[1] }] });
    const { result } = renderHook(() => useSelectableConsultationWorkflows());

    await waitFor(() => expect(result.current.workflows).not.toBeNull());
    expect(result.current.tenantDefault).toBeNull();
  });

  it('keeps "the tenant published none" as a real, EMPTY answer', async () => {
    get.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useSelectableConsultationWorkflows());

    await waitFor(() => expect(result.current.workflows).toEqual([]));
    expect(result.current.tenantDefault).toBeNull();
  });

  it('FAILS OPEN to null — never rejecting, and never claiming the tenant has none', async () => {
    get.mockRejectedValue(new Error('gateway unreachable'));
    const { result } = renderHook(() => useSelectableConsultationWorkflows());

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current.workflows).toBeNull();
    // The distinction the fail-open posture must preserve: unknown is not empty.
    expect(result.current.workflows).not.toEqual([]);
    await expect(result.current.refresh()).resolves.toBeNull();
  });

  it('tolerates a malformed payload rather than handing a non-array to a picker', async () => {
    get.mockResolvedValue({});
    const { result } = renderHook(() => useSelectableConsultationWorkflows());

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current.workflows).toBeNull();
  });
});
