/**
 * @arcaai/vox - useConsultationWorkflow Hook (TASK-813)
 *
 * Answers "which engine is writing this consultation's document?" — the read
 * side of `OpenSessionInput.workflowDefinitionSlug`.
 *
 * ## Why a read-back exists at all
 *
 * Selecting a workflow at open does not guarantee it runs. Consultation-open
 * dispatch is best-effort BY DESIGN: a clinician must be able to open a
 * consultation while the harness is down, so a dispatch failure degrades to the
 * platform's default engine rather than failing the open. Without this hook a
 * client could not tell the two outcomes apart.
 *
 * ## Fail-open, like the schema bundle
 *
 * `refresh()` never throws and never rejects. A failed read leaves `workflow`
 * as `null` and reports the reason on `error`. Consultation capture must not
 * stop because an informational read failed — and `null` is honestly "we do not
 * know", never "the default engine governs", which is why the two are distinct
 * states rather than a boolean default.
 *
 * Unlike `useConsultationSchema`, this hook OWNS its fetch. The schema bundle is
 * session-pinned by the provider so every consumer observes one version; the
 * governing workflow is per-consultation and only exists after open, so there is
 * nothing for the provider to pin.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAgenticStore, selectConsultation } from '../store';
import { useApiOperation } from './useApiOperation';
import { CONSULTATION_ENDPOINTS } from '../core/constants';
import type { ConsultationWorkflow } from '../types/consultationWorkflow';

export interface UseConsultationWorkflowReturn {
  /** The governing-engine answer, or `null` before the first read resolves — or after one fails. */
  workflow: ConsultationWorkflow | null;
  /** `true` when a tenant-authored workflow governs. `false` while unknown, so never read it as "the default engine governs" — check `workflow !== null` first. */
  isGoverned: boolean;
  isLoading: boolean;
  /** Why the last read failed, if it did. Never thrown at the caller. */
  error: Error | null;
  /** Re-read. Resolves to `null` rather than rejecting when the read fails. */
  refresh: () => Promise<ConsultationWorkflow | null>;
}

/**
 * @param consultationId Defaults to the session's current consultation.
 */
export function useConsultationWorkflow(consultationId?: string): UseConsultationWorkflowReturn {
  const { execute, isLoading, error } = useApiOperation('useConsultationWorkflow');
  const sessionConsultation = useAgenticStore(selectConsultation);
  const targetId = consultationId ?? sessionConsultation?.id;

  const [workflow, setWorkflow] = useState<ConsultationWorkflow | null>(null);

  const refresh = useCallback(async (): Promise<ConsultationWorkflow | null> => {
    if (!targetId) {
      setWorkflow(null);
      return null;
    }

    try {
      return await execute<ConsultationWorkflow>('getGoverningWorkflow', async (client) => {
        const data = await client.get<ConsultationWorkflow>(CONSULTATION_ENDPOINTS.WORKFLOW(targetId));
        setWorkflow(data);
        return data;
      });
    } catch {
      // Fail-open: `execute` has already recorded the reason on `error`. Swallowing the throw is
      // the entire point — an unreachable discovery read must not surface as an unhandled
      // rejection in a consultation UI.
      setWorkflow(null);
      return null;
    }
  }, [execute, targetId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { workflow, isGoverned: workflow?.governed ?? false, isLoading, error, refresh };
}
