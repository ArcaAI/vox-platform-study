/**
 * @arcaai/vox - useConsultationChain Hook (TASK-329 P2)
 *
 * Fetches the full consultation chain (structural root + every descendant,
 * multi-hop) via `GET /consultations/:id/chain`. The server walks the entire
 * parent/child tree, so this surfaces linked re-visits/referrals for the
 * consultation playground's reference UI.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { CONSULTATION_ENDPOINTS } from '../core/constants';
import type { Consultation } from '../types';

export interface UseConsultationChainReturn {
  chain: Consultation[];
  isLoading: boolean;
  error: Error | null;
  /** Fetch the full chain for a consultation (any node in the tree). */
  fetchChain: (consultationId: string) => Promise<Consultation[]>;
}

export function useConsultationChain(): UseConsultationChainReturn {
  const { execute, isLoading, error } = useApiOperation('useConsultationChain');

  const [chain, setChain] = useState<Consultation[]>([]);

  const fetchChain = useCallback(
    (consultationId: string): Promise<Consultation[]> =>
      execute<Consultation[]>('fetchChain', async (client) => {
        const data = await client.get<Consultation[]>(CONSULTATION_ENDPOINTS.CHAIN(consultationId));
        const list = data ?? [];
        setChain(list);
        return list;
      }),
    [execute],
  );

  return { chain, isLoading, error, fetchChain };
}
