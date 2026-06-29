import type { GridLayoutPersistenceAdapter } from '@arcaai/ui/components/data-grid';
import { useUserSettings } from '@arcaai/vox';
import { useMemo } from 'react';
import { createGridLayoutAdapter } from './grid-layout-adapter';

/**
 * Server-persisted grid-layout adapter (TASK-372 D8) backed by `useUserSettings`.
 *
 * Thin React wrapper over the pure {@link createGridLayoutAdapter} factory (which
 * carries the load/save logic and is unit-tested independently).
 */
export function useGridLayoutPersistence(): GridLayoutPersistenceAdapter {
    const settings = useUserSettings();
    return useMemo(() => createGridLayoutAdapter(settings), [settings]);
}
