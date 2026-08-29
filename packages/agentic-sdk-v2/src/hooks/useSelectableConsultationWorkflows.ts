/**
 * @arcaai/vox - useSelectableConsultationWorkflows Hook (TASK-813 §8)
 *
 * Answers "which workflows may I pass to `session.open({ workflowDefinitionSlug })`?" — the
 * discovery side of the selector, and the half that shipped missing: selection was authorized
 * from day one, but nothing returned the SET that would be authorized, so a client had to learn
 * slugs out of band and find out by trying.
 *
 * Backed by `GET /consultations/workflows`, which is gated by the same ability as the open call
 * itself and answers from the same predicate the open call authorizes with. So anything this
 * hook returns is accepted by `open`, and anything it omits is refused — the list cannot
 * advertise a slug that then 403s.
 *
 * ## Fail-open, but never fail-INVENTIVE
 *
 * `refresh()` never throws and never rejects: a workflow picker must not break a consultation
 * screen. But failing open must not manufacture an answer either, so the two "no workflows on
 * screen" outcomes stay different values:
 *
 *   * `null`  — we could not ask (offline, 503, unauthorized). Render nothing, or a retry.
 *   * `[]`    — we asked, and the tenant has published no consultation workflow. The platform
 *               default engine governs; there is genuinely nothing to choose.
 *
 * Collapsing those would tell a clinician their tenant has no workflows because a request
 * blipped. Mirrors `useConsultationWorkflow`, where `null` is likewise distinct from
 * `governed: false`.
 *
 * Unlike that hook this one takes no consultation id: the set is tenant-wide and is needed
 * BEFORE a consultation exists — that is the point of it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { CONSULTATION_ENDPOINTS } from '../core/constants';
import type { SelectableConsultationWorkflow } from '../types/consultationWorkflow';

export interface UseSelectableConsultationWorkflowsReturn {
  /** The selectable set, or `null` when the read has not resolved — or failed. NEVER conflate `null` with `[]`. */
  workflows: SelectableConsultationWorkflow[] | null;
  /** The entry the tenant-level assignment names, for preselection. `null` when unknown or unassigned. */
  tenantDefault: SelectableConsultationWorkflow | null;
  isLoading: boolean;
  /** Why the last read failed, if it did. Never thrown at the caller. */
  error: Error | null;
  /** Re-read. Resolves to `null` rather than rejecting when the read fails. */
  refresh: () => Promise<SelectableConsultationWorkflow[] | null>;
}

export function useSelectableConsultationWorkflows(): UseSelectableConsultationWorkflowsReturn {
  const { execute, isLoading, error } = useApiOperation('useSelectableConsultationWorkflows');
  const [workflows, setWorkflows] = useState<SelectableConsultationWorkflow[] | null>(null);

  const refresh = useCallback(async (): Promise<SelectableConsultationWorkflow[] | null> => {
    try {
      return await execute<SelectableConsultationWorkflow[] | null>('listSelectableConsultationWorkflows', async (client) => {
        const response = await client.get<{ data?: SelectableConsultationWorkflow[] }>(CONSULTATION_ENDPOINTS.SELECTABLE_WORKFLOWS);

        // A payload without a `data` array is "we could not ask", not "the tenant has none" —
        // handing a non-array to a picker would either crash it or render a false empty state.
        const data = Array.isArray(response?.data) ? response.data : null;
        setWorkflows(data);
        return data;
      });
    } catch {
      // Fail-open: `execute` has already recorded the reason on `error`.
      setWorkflows(null);
      return null;
    }
  }, [execute]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    workflows,
    tenantDefault: workflows?.find((workflow) => workflow.isTenantDefault) ?? null,
    isLoading,
    error,
    refresh,
  };
}
