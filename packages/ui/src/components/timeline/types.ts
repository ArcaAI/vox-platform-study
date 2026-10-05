/**
 * Types for HistoryTimelineList.
 *
 * A content-type-aware, reverse-chronological, virtualized history. The row model
 * is `TimelineItemModel`; consumers adapt their raw rows (SDK `ContextItem`,
 * `TimelineEventResponse`, …) via `mapItem`.
 */
import type * as React from 'react';
import type { AsyncCollection, AsyncStateProps, BaseSurfaceProps, Density } from '@/lib/shared';

export type TimelineContentVariant = 'markdown' | 'pdf' | 'image' | 'audio' | 'file' | 'mixed' | 'custom';

export interface TimelineBadge {
  label: string;
  icon?: React.ReactNode;
  /** Visual emphasis; maps onto the shared `Badge` variants. */
  variant?: 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost';
}

export interface TimelineWord {
  word: string;
  start: number;
  end: number;
  /** `null` for the Whisper engine — render the word anyway (D9). */
  confidence?: number | null;
}

export interface TimelineTranscriptSegment {
  id: string;
  text: string;
  start?: number;
  end?: number;
  speakerLabel?: string;
  words?: TimelineWord[];
}

export interface TimelineImage {
  id: string;
  /** Grid (and lightbox-fallback) source — typically a thumbnail. */
  src: string;
  /**
   * Optional full-resolution source for the zoom lightbox. When present, the
   * lightbox swaps to this on open (and restores `src` on close); when absent
   * the lightbox falls back to `src`. Additive / back-compatible.
   */
  zoomSrc?: string;
  alt: string;
  width: number;
  height: number;
  title?: string;
  caption?: string;
}

/** Discriminated union of per-variant content payloads. */
export type TimelineContent =
  | { type: 'markdown'; markdown: string }
  | { type: 'pdf'; url: string; name?: string }
  | { type: 'image'; images: TimelineImage[] }
  | { type: 'audio'; src: string; title?: string; transcript?: { segments: TimelineTranscriptSegment[] } }
  | { type: 'file'; url: string; name: string; size?: number; mimeType?: string }
  | { type: 'mixed'; parts: TimelineContent[] }
  | { type: 'custom'; render: () => React.ReactNode };

export interface TimelineItemModel {
  /** Absent (or `'item'`) for a content row; `'band'` rows are `TimelineBandModel`. */
  kind?: 'item';
  id: string;
  /** `ContextItem.createdAt`. */
  timestamp: string | Date;
  title?: React.ReactNode;
  variant: TimelineContentVariant;
  content: TimelineContent;
  badges?: TimelineBadge[];
  defaultExpanded?: boolean;
  /** Passthrough (e.g. the source `ContextItem`). */
  meta?: Record<string, unknown>;
}

/**
 * A non-content row that groups or interrupts the feed (an encounter section
 * heading, a time-gap marker). Rendered as a labelled `separator`.
 */
export interface TimelineBandModel {
  kind: 'band';
  id: string;
  /** Accessible name and visible text of the band. */
  label: string;
  description?: React.ReactNode;
  /** `section` = heading-like divider; `gap` = quieter elapsed-time marker. */
  tone?: 'section' | 'gap';
}

export type TimelineRow = TimelineItemModel | TimelineBandModel;

export interface TimelineRendererProps {
  item: TimelineItemModel;
  content: TimelineContent;
  expanded: boolean;
  density: Density;
  lazyMedia: boolean;
  /** Fired with the media index within the item (e.g. clicked image). */
  onMediaOpen?: (mediaIndex: number) => void;
}

export type TimelineRenderer = (props: TimelineRendererProps) => React.ReactNode;

export interface TimelineExpansion {
  value?: string[];
  onChange?: (ids: string[]) => void;
  mode?: 'single' | 'multiple';
}

export interface HistoryTimelineListProps<TItem = TimelineItemModel> extends BaseSurfaceProps, AsyncStateProps {
  /** Ordered per `inputOrder` (newest-first by default). Rows with `kind: 'band'` render as separators. */
  items: TItem[];
  /** Order the `items` are supplied in. Default `'desc'` (newest-first). */
  inputOrder?: 'desc' | 'asc';
  /** Displayed order. Defaults to `inputOrder`; the list only reverses when the two differ. */
  order?: 'desc' | 'asc';
  /** Adapter from a raw row (e.g. `ContextItem`) → `TimelineItemModel`. */
  mapItem?: (raw: TItem) => TimelineItemModel;
  /** Infinite-scroll source (`fetchNextPage`); transport-agnostic (D5). */
  collection?: AsyncCollection<TItem>;
  /** Override/extend the per-variant renderer registry. */
  renderers?: Partial<Record<TimelineContentVariant, TimelineRenderer>>;
  expansion?: TimelineExpansion;
  onItemExpand?: (id: string, expanded: boolean) => void;
  onMediaOpen?: (itemId: string, mediaIndex: number) => void;
  /** Currently selected item id (controlled). */
  selectedId?: string | null;
  /** When provided, each item gets a keyboard-accessible select control. */
  onItemSelect?: (id: string) => void;
  /** Per-item actions rendered beside the row header (e.g. edit, history). */
  actions?: (item: TimelineItemModel) => React.ReactNode;
  onRetry?: () => void;
  estimateItemHeight?: number;
  /** Defer heavy media (PDF/full-res image) until needed. Default `true`. */
  lazyMedia?: boolean;
  height?: number | string;
  'aria-label'?: string;
}
