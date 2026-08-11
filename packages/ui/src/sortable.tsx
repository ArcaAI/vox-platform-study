'use client';

// Expose the diceui Sortable primitives under the
// `@arcaai/ui/sortable` subpath so consumers (e.g. a draggable admin
// nav) can import drag-reorder primitives without pulling the whole
// barrel or adding @dnd-kit directly. The Vite
// subpath resolver (`resolveArcaUiSubpaths`) resolves
// `@arcaai/ui/sortable` to this file; type-check resolves the same
// names through the built `dist/index.d.ts` barrel, which already
// re-exports the diceui registry.
export {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
  type SortableProps,
} from './components/registries/diceui/sortable';
