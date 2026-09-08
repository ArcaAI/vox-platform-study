'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateFeatureGates } from '@/shared/feature-gates/use-feature-gates';
import { getFeatureMatrix, putFeatureMatrix } from './client';
import { featureAvailabilityKeys } from './keys';
import type { FeatureMatrixWrite } from './types';

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
      // The shell's own gate cache (`['feature-gates']`) is a SEPARATE query
      // from the matrix screen's own `effective()` key above — invalidating
      // one never invalidated the other, so a save never refreshed the nav
      // until the next reload (M1).
      await invalidateFeatureGates(queryClient);
    },
  });
}
