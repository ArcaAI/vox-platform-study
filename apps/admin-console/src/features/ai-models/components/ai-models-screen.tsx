'use client';

import { useModelAccess } from '../api/hooks';
import { AiModelsSkeleton } from './ai-models-skeleton';
import { ManageModelsScreen } from './manage-models-screen';
import { ReadOnlyRegistryScreen } from './read-only-registry-screen';

/**
 * /ai-models (tier 20-29, TASK-1023). ONE route, two grids: `GET admin/ai-models/access` decides.
 * A platform admin gets the management grid; every other admin gets the read-only registry view.
 * A failed access read fails closed to the read-only view — least privilege, and the registry route
 * only needs `read:AiModel`, which every admin holds.
 */
export function AiModelsScreen() {
  const access = useModelAccess();
  if (access.isLoading) return <AiModelsSkeleton />;
  return access.data?.canManage ? <ManageModelsScreen /> : <ReadOnlyRegistryScreen />;
}
