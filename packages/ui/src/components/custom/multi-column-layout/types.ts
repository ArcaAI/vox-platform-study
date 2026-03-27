import type * as React from 'react';

// ---------------------------------------------------------------------------
// Column context passed to renderItem
// ---------------------------------------------------------------------------

export interface MultiColumnContext {
  selectedId: string | null;
  columnIndex: number;
}

// ---------------------------------------------------------------------------
// Header context passed to renderHeader on list columns
// ---------------------------------------------------------------------------

export interface MultiColumnHeaderContext {
  itemCount: number;
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// List column — selectable items with virtualized scroll
// ---------------------------------------------------------------------------

export interface MultiColumnConfig<TItem = unknown> {
  id: string;
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
  /** CSS grid column width, e.g. "280px", "minmax(240px, 1fr)". Default "1fr". */
  width?: string;
  /** Default panel size as a percentage (0–100). Used by ResizablePanelGroup. */
  defaultSize?: number;
  /** Minimum panel size as a percentage (0–100). Default 10. */
  minSize?: number;
  /** Maximum panel size as a percentage (0–100). */
  maxSize?: number;
  /** Whether this column can be resized by dragging. Default true. */
  resizable?: boolean;
  /** Render item count badge in the column header, e.g. "Reports (12)". */
  showItemCount?: boolean;

  // -- Header customization --
  /** Extra content rendered in the controls row below the title/subtitle. */
  headerControls?: React.ReactNode;
  /** Extra content rendered in the controls row (legacy alias). */
  headerActions?: React.ReactNode;
  /** Refresh callback shown as a button in the controls row. */
  onRefresh?: () => void;
  /** Forces refresh icon to spin while refetching. */
  isRefreshing?: boolean;
  /**
   * Replace the entire default header with a custom render function.
   * When provided, `title`, `subtitle`, `showItemCount`, `headerControls`, and `headerActions` are ignored.
   */
  renderHeader?: (context: MultiColumnHeaderContext) => React.ReactNode;

  // -- Skeleton --
  /** Number of skeleton rows shown during initial load. Default 5. */
  skeletonCount?: number;
  /** Tailwind height class for each skeleton row. Default "h-16". */
  skeletonHeight?: string;

  // -- Empty state --
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;

  // -- Item rendering --
  keyExtractor: (item: TItem) => string;
  renderItem: (item: TItem, context: MultiColumnContext) => React.ReactNode;
  /** Estimated pixel height of a single item for TanStack Virtual. Default 64. */
  estimateItemSize?: number;
}

// ---------------------------------------------------------------------------
// Content column — renders arbitrary content (forms, editors, custom views)
// ---------------------------------------------------------------------------

export interface MultiColumnContentConfig {
  type: 'content';
  id: string;
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
  width?: string;
  /** Default panel size as a percentage (0–100). Used by ResizablePanelGroup. */
  defaultSize?: number;
  /** Minimum panel size as a percentage (0–100). Default 10. */
  minSize?: number;
  /** Maximum panel size as a percentage (0–100). */
  maxSize?: number;
  /** Whether this column can be resized by dragging. Default true. */
  resizable?: boolean;

  // -- Header customization --
  headerControls?: React.ReactNode;
  headerActions?: React.ReactNode;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  renderHeader?: () => React.ReactNode;

  // -- Skeleton / empty --
  skeletonCount?: number;
  skeletonHeight?: string;
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;

  /** Render function for the column body. Receives full control over content. */
  renderContent: () => React.ReactNode;
}

// ---------------------------------------------------------------------------
// Union of all column types that go into the `columns` array
// ---------------------------------------------------------------------------

export type AnyColumnConfig = MultiColumnConfig | MultiColumnContentConfig;

// ---------------------------------------------------------------------------
// List column runtime state (controlled by parent)
// ---------------------------------------------------------------------------

export interface MultiColumnState<TItem = unknown> {
  data: TItem[];
  /** Show full-column skeleton (initial load). */
  isLoading: boolean;
  /** When false the column shows its empty/disabled placeholder. Default true. */
  enabled?: boolean;
  selectedId: string | null;
  /** Optional multi-select state. When provided, selected styles apply to all listed IDs. */
  selectedIds?: string[];
  onSelect: (id: string) => void;

  // -- Infinite scroll (all optional) --
  /** Whether more pages are available. */
  hasMore?: boolean;
  /** Called when the user scrolls near the bottom. */
  onLoadMore?: () => void;
  /** Show a spinner at the bottom while fetching the next page. */
  isLoadingMore?: boolean;
}

// ---------------------------------------------------------------------------
// Detail column (non-selectable, renders arbitrary content)
// ---------------------------------------------------------------------------

export interface MultiColumnDetailConfig {
  id: string;
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
  width?: string;
  /** Default panel size as a percentage (0–100). Used by ResizablePanelGroup. */
  defaultSize?: number;
  /** Minimum panel size as a percentage (0–100). Default 10. */
  minSize?: number;
  /** Maximum panel size as a percentage (0–100). */
  maxSize?: number;
  /** Whether this column can be resized by dragging. Default true. */
  resizable?: boolean;
  /** Extra content rendered in the controls row below the title/subtitle. */
  headerControls?: React.ReactNode;
  /** Extra content rendered after the title row (action buttons, toggles, etc.). */
  headerActions?: React.ReactNode;
  /** Refresh callback shown as a button in the controls row. */
  onRefresh?: () => void;
  /** Forces refresh icon to spin while refetching. */
  isRefreshing?: boolean;
  /** Replace the entire default header with a custom render function. */
  renderHeader?: () => React.ReactNode;
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
}

export interface MultiColumnDetailState {
  hasSelection: boolean;
  content: React.ReactNode;
  /** Show skeleton inside the detail pane while content is loading. */
  isLoading?: boolean;
  /** Number of skeleton rows in the detail pane. Default 4. */
  skeletonCount?: number;
}

// ---------------------------------------------------------------------------
// Top-level layout props
// ---------------------------------------------------------------------------

export interface MultiColumnLayoutProps {
  columns: AnyColumnConfig[];
  columnStates: MultiColumnState[];
  detailColumn?: MultiColumnDetailConfig;
  detailState?: MultiColumnDetailState;
  /** CSS height value for the layout container. Default "calc(100vh - 20rem)". */
  height?: string;
  className?: string;
  /**
   * Enable resizable columns via drag handles between panels.
   * Default true. Set to false to use fixed-width CSS grid columns.
   * Individual columns can override this via their own `resizable` prop.
   */
  resizable?: boolean;
}
