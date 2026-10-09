'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateActionConfirmations } from '@/shared/action-confirmations/use-action-confirmation';
import { getActionConfirmations, putActionConfirmations } from './client';
import type { ActionConfirmationWrite } from './types';

/** Prefixed by the shared policy key, so `invalidateActionConfirmations` refreshes this too. */
export const actionConfirmationsAdminKey = ['action-confirmations', 'admin'] as const;

export function useActionConfirmationRows() {
  return useQuery({ queryKey: actionConfirmationsAdminKey, queryFn: getActionConfirmations, retry: false });
}

export function usePutActionConfirmations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cells: ActionConfirmationWrite[]) => putActionConfirmations(cells),
    // Also refreshes the session's own dialog policy, not just this screen.
    onSuccess: () => invalidateActionConfirmations(queryClient),
  });
}
