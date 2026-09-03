/**
 * @arcaai/vox - useSelectableAsrAgents Hook (TASK-865)
 *
 * Answers "which ASR Agents may I pass to `audio.start({ agentSlug })`?" — the
 * discovery side of the selector. Replaces `usePipelines().list()` (deprecated):
 * the client no longer chooses a pipeline, an engine, a model or a VAD; it names
 * the tenant's published transcription AGENT, or nothing and lets the tenant →
 * department assignment cascade decide.
 *
 * Backed by `GET /agents?task=SPEECH_TO_TEXT` (TASK-863, business plane), which
 * answers from the same predicate the stream-session route resolves `agentSlug`
 * with. So anything this hook returns is accepted at start, and anything it
 * omits is refused — the list cannot advertise a slug that then 404s.
 *
 * ## Fail-open, but never fail-INVENTIVE
 *
 * `refresh()` never throws and never rejects: an agent picker must not break a
 * capture screen. But failing open must not manufacture an answer either, so
 * the two "no agents on screen" outcomes stay different values:
 *
 *   * `null` — we could not ask (offline, 503, unauthorized). Render nothing, or a retry.
 *   * `[]` — we asked, and the tenant has published no ASR agent. The platform
 *            default governs; there is genuinely nothing to choose.
 *
 * Mirrors `useSelectableConsultationWorkflows` exactly, on purpose: the two
 * pickers sit side by side in the Scribe footer and must behave alike.
 */

import { useCallback, useEffect, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { AGENT_ENDPOINTS } from '../core/constants';
import type { SelectableAgent, SelectableAsrAgent } from '../types/agent';

export interface UseSelectableAsrAgentsReturn {
  /** The selectable set, or `null` when the read has not resolved — or failed. NEVER conflate `null` with `[]`. */
  agents: SelectableAsrAgent[] | null;
  /** The entry the tenant-level assignment names, for preselection. `null` when unknown or unassigned. */
  tenantDefault: SelectableAsrAgent | null;
  isLoading: boolean;
  /** Why the last read failed, if it did. Never thrown at the caller. */
  error: Error | null;
  /** Re-read. Resolves to `null` rather than rejecting when the read fails. */
  refresh: () => Promise<SelectableAsrAgent[] | null>;
}

function isAsrAgent(agent: SelectableAgent): agent is SelectableAsrAgent {
  return agent.task === 'SPEECH_TO_TEXT';
}

export function useSelectableAsrAgents(): UseSelectableAsrAgentsReturn {
  const { execute, isLoading, error } = useApiOperation('useSelectableAsrAgents');
  const [agents, setAgents] = useState<SelectableAsrAgent[] | null>(null);

  const refresh = useCallback(async (): Promise<SelectableAsrAgent[] | null> => {
    try {
      return await execute<SelectableAsrAgent[] | null>('listSelectableAsrAgents', async (client) => {
        const response = await client.get<{ data?: SelectableAgent[] }>(AGENT_ENDPOINTS.LIST('SPEECH_TO_TEXT'));

        // A payload without a `data` array is "we could not ask", not "the tenant has none" —
        // handing a non-array to a picker would either crash it or render a false empty state.
        // Rows of another task are dropped defensively: this picker is for ASR only.
        const data = Array.isArray(response?.data) ? response.data.filter(isAsrAgent) : null;
        setAgents(data);
        return data;
      });
    } catch {
      // Fail-open: `execute` has already recorded the reason on `error`.
      setAgents(null);
      return null;
    }
  }, [execute]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    agents,
    tenantDefault: agents?.find((agent) => agent.isTenantDefault) ?? null,
    isLoading,
    error,
    refresh,
  };
}
