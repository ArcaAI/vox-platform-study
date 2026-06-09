/**
 * HighlightableSurface (TASK-344 Workstream B).
 *
 * Renders a PERSISTED clinical surface's plain text and lets the clinician
 * select-to-highlight and remove manual marks. Marks are rendered VISUALLY
 * DISTINCT from AI-entity marks (sky/teal + dotted underline vs the amber
 * provenance/NER marks) and are a SEPARATE concern from `NamedEntity` — they
 * never feed the NER aggregation.
 *
 *   - Presentational `HighlightableSurface` — text in, anchors out (unit-pure
 *     logic lives in `lib/highlight-anchoring`).
 *   - Connected `ManualHighlightSurface` — binds the surface to the
 *     `:id/highlights` React Query hooks (Phase 2 durable persistence).
 */
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useCreateHighlightMutation, useDeleteHighlightMutation, useHighlightsQuery } from '../api/queries';
import {
  buildHighlightSegments,
  computeAnchorFromSelection,
  resolveHighlights,
  type HighlightAnchor,
} from '../lib/highlight-anchoring';
import type { HighlightTargetKind, WorkspaceHighlight } from '../types';

interface HighlightableSurfaceProps {
  /** The persisted surface's plain text (the anchoring coordinate space). */
  text: string;
  /** Stored highlights for THIS surface (already filtered by caller). */
  highlights: WorkspaceHighlight[];
  /** Called with a freshly-computed anchor when the clinician selects text. */
  onSelect?: (anchor: HighlightAnchor) => void;
  /** Called when a mark's remove control is clicked. */
  onRemove?: (highlightId: string) => void;
  /** Disable select-to-highlight + remove (e.g. mid-recording, not yet persisted). */
  readOnly?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * Presentational highlightable text. Re-anchors stored highlights to the current
 * `text` (dropping orphans), renders distinct manual marks, and turns a DOM
 * selection into a dual-selector anchor on mouse-up. Never throws on an empty or
 * collapsed selection.
 */
export function HighlightableSurface({ text, highlights, onSelect, onRemove, readOnly, className, ...rest }: HighlightableSurfaceProps) {
  const containerRef = useRef<HTMLParagraphElement>(null);

  const resolved = useMemo(() => resolveHighlights(text, highlights), [text, highlights]);
  const segments = useMemo(() => buildHighlightSegments(text, resolved), [text, resolved]);

  const handleMouseUp = () => {
    if (readOnly || !onSelect) return;
    const anchor = computeAnchorFromSelection(containerRef.current, typeof window !== 'undefined' ? window.getSelection() : null);
    if (!anchor) return; // empty / collapsed / out-of-container selection
    onSelect(anchor);
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges();
  };

  return (
    <p
      ref={containerRef}
      onMouseUp={handleMouseUp}
      className={cn('text-sm leading-relaxed whitespace-pre-wrap', !readOnly && 'cursor-text', className)}
      data-testid={rest['data-testid']}
    >
      {segments.map((segment, index) =>
        segment.highlight ? (
          <mark
            key={index}
            data-manual-highlight="true"
            title={segment.highlight.note ?? segment.highlight.label ?? undefined}
            className="group/mark rounded-sm bg-sky-200/70 px-0.5 text-sky-950 underline decoration-sky-500 decoration-dotted underline-offset-2 dark:bg-sky-400/25 dark:text-sky-50"
          >
            {segment.text}
            {!readOnly && onRemove && (
              <button
                type="button"
                aria-label="Remove highlight"
                data-testid={`remove-highlight-${segment.highlight.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(segment.highlight!.id);
                }}
                className="ml-0.5 inline-flex size-3.5 translate-y-px items-center justify-center rounded-full bg-sky-600/15 align-middle text-sky-700 opacity-0 transition-opacity hover:bg-sky-600/30 group-hover/mark:opacity-100 dark:text-sky-200"
              >
                <X className="size-2.5" />
              </button>
            )}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

interface ManualHighlightSurfaceProps {
  consultationId: string;
  /** Which persisted surface this is (discriminates the stored highlights). */
  targetKind: HighlightTargetKind;
  /** The persisted ContextItem id this surface renders (anchor scope). */
  sourceContextItemId?: string;
  text: string;
  readOnly?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * Connected highlightable surface — Phase 2 durable persistence. Loads the
 * consultation's highlights, narrows them to THIS surface (by `targetKind` +
 * `sourceContextItemId`), and wires select/remove to the create/delete
 * mutations (which invalidate the highlights cache on success).
 */
export function ManualHighlightSurface({ consultationId, targetKind, sourceContextItemId, text, readOnly, className, ...rest }: ManualHighlightSurfaceProps) {
  const highlightsQuery = useHighlightsQuery(consultationId);
  const createMutation = useCreateHighlightMutation(consultationId);
  const deleteMutation = useDeleteHighlightMutation(consultationId);

  const surfaceHighlights = useMemo(
    () =>
      (highlightsQuery.data ?? []).filter(
        (h) => h.targetKind === targetKind && (sourceContextItemId ? h.sourceContextItemId === sourceContextItemId : !h.sourceContextItemId),
      ),
    [highlightsQuery.data, targetKind, sourceContextItemId],
  );

  const handleSelect = (anchor: HighlightAnchor) => {
    createMutation.mutate(
      {
        targetKind,
        sourceContextItemId,
        exact: anchor.quote.exact,
        prefix: anchor.quote.prefix,
        suffix: anchor.quote.suffix,
        startOffset: anchor.position.start,
        endOffset: anchor.position.end,
      },
      { onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to add highlight') },
    );
  };

  const handleRemove = (highlightId: string) => {
    deleteMutation.mutate(highlightId, {
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove highlight'),
    });
  };

  return (
    <HighlightableSurface
      text={text}
      highlights={surfaceHighlights}
      onSelect={handleSelect}
      onRemove={handleRemove}
      readOnly={readOnly}
      className={className}
      data-testid={rest['data-testid']}
    />
  );
}
