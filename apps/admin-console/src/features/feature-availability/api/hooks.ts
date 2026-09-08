'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEffectiveFeatures, getFeatureMatrix, putFeatureMatrix } from './client';
import { featureAvailabilityKeys } from './keys';
import type { FeatureMatrixWrite } from './types';

/**
 * The caller's feature gates. Cached for the session: they change only when a
 * platform admin edits the matrix, and that mutation invalidates them.
 */
export function useEffectiveFeatures(enabled = true) {
  return useQuery({
    queryKey: featureAvailabilityKeys.effective(),
    queryFn: () => getEffectiveFeatures(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/**
 * The cross-tenant matrix. A non-platform-admin gets a 403, which is a settled
 * answer rather than a transient one — so it is not retried.
 */
export function useFeatureMatrix(enabled = true) {
  return useQuery({
    queryKey: featureAvailabilityKeys.matrix(),
    queryFn: () => getFeatureMatrix(),
    enabled,
    retry: false,
  });
}

/**
 * Save a screenful of matrix edits as ONE batch.
 *
 * Invalidates the effective gates as well as the matrix: a save that hides a
 * console screen must be reflected in the navigation of the session that made
 * it, not on its next reload.
 */
export function usePutFeatureMatrix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cells: FeatureMatrixWrite[]) => putFeatureMatrix(cells),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: featureAvailabilityKeys.matrix() });
      await queryClient.invalidateQueries({ queryKey: featureAvailabilityKeys.effective() });
    },
  });
}
