'use client';

import { useQuery } from '@tanstack/react-query';
import { getModelResidencyOperation, type ModelResidencyOperation, type ModelResidencyOperationStatus } from './api';

const TERMINAL_STATUSES: ReadonlySet<ModelResidencyOperationStatus> = new Set(['succeeded', 'failed']);

/** The load route is asynchronous (~100s for a 5GB LLM, past Cloudflare's 100s
 *  edge timeout — ticket §10.1), so every caller that starts a load polls this
 *  operation to a terminal state rather than waiting on the POST itself. */
const POLL_MS = 2_000;

/** A load that has not reached a terminal state after this long is treated as lost (the gateway may have restarted). */
export const RESIDENCY_OPERATION_TIMEOUT_MS = 5 * 60_000;

/**
 * Polls one model-residency operation until it reaches `succeeded`/`failed`,
 * then stops. `operationId: null` disables the query (nothing to poll yet).
 */
export function useModelResidencyOperation(operationId: string | null) {
  return useQuery<ModelResidencyOperation>({
    queryKey: ['model-residency', 'operation', operationId],
    queryFn: () => getModelResidencyOperation(operationId!),
    enabled: operationId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : POLL_MS;
    },
  });
}

export function isTerminalResidencyOperation(status: ModelResidencyOperationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
