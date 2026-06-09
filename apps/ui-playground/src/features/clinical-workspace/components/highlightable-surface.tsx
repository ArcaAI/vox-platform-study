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
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCreateHighlightMutation, useDeleteHighlightMutation, useHighlightsQuery } from '../api/queries';
import {
  buildHighlightSegments,
  computeAnchorFromSelection,
  resolveHighlights,
  type HighlightAnchor,
} from '../lib/highlight-anchoring';
import type { HighlightTargetKind, WorkspaceHighlight } from '../types';

/** A selectable highlight color (light enough to read dark text on). */
export interface HighlightColorOption {
  name: string;
  value: string;
}

/**
 * Preset colors a clinician can pick from at creation time. Kept small and
 * light; Blue mirrors the established manual-mark look so untinted legacy marks
 * and new ones read consistently.
 */
export const HIGHLIGHT_COLORS: readonly HighlightColorOption[] = [
  { name: 'Blue', value: '#7dd3fc' },
  { name: 'Yellow', value: '#fde047' },
  { name: 'Green', value: '#86efac' },
  { name: 'Pink', value: '#f9a8d4' },
  { name: 'Purple', value: '#d8b4fe' },
];

/** Default active color for a freshly-rendered surface. */
export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].value;

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
      {segments.map((segment, index) => {
        const highlight = segment.highlight;
        if (!highlight) return <span key={index}>{segment.text}</span>;
        // Render the stored color when present; otherwise keep the established
        // sky look. Either way the DOTTED UNDERLINE + `data-manual-highlight`
        // keep manual marks distinct from the solid amber AI-entity marks.
        const color = typeof highlight.color === 'string' && highlight.color.trim() ? highlight.color : null;
        return (
          <mark
            key={index}
            data-manual-highlight="true"
            data-highlight-color={color ?? undefined}
            title={highlight.note ?? highlight.label ?? undefined}
            style={color ? { backgroundColor: color, textDecorationColor: color } : undefined}
            className={cn(
              'group/mark rounded-sm px-0.5 underline decoration-dotted underline-offset-2',
              color ? 'text-zinc-900' : 'bg-sky-200/70 text-sky-950 decoration-sky-500 dark:bg-sky-400/25 dark:text-sky-50',
            )}
          >
            {segment.text}
            {!readOnly && onRemove && (
              <button
                type="button"
                aria-label="Remove highlight"
                data-testid={`remove-highlight-${highlight.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(highlight.id);
                }}
                className="ml-0.5 inline-flex size-3.5 translate-y-px items-center justify-center rounded-full bg-black/10 align-middle text-current opacity-0 transition-opacity hover:bg-black/20 group-hover/mark:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            )}
          </mark>
        );
      })}
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
  // The color the NEXT highlight is created with (set color at creation; there
  // is no update endpoint, so colors are chosen up-front, not edited per-mark).
  const [activeColor, setActiveColor] = useState<string>(DEFAULT_HIGHLIGHT_COLOR);

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
        color: activeColor,
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
    <div className={cn('flex flex-col gap-1.5', className)}>
      {!readOnly && <HighlightColorPicker value={activeColor} onChange={setActiveColor} />}
      <HighlightableSurface
        text={text}
        highlights={surfaceHighlights}
        onSelect={handleSelect}
        onRemove={handleRemove}
        readOnly={readOnly}
        data-testid={rest['data-testid']}
      />
    </div>
  );
}

/**
 * Compact preset-swatch picker for the active highlight color. Plain buttons
 * (matching the surface's dependency-light, primitive-based styling) keep the
 * connected surface trivially testable under the stubbed-SDK vitest config.
 */
function HighlightColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Highlight color">
      <span className="text-muted-foreground mr-0.5 text-[10px] font-medium uppercase tracking-wide">Color</span>
      {HIGHLIGHT_COLORS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={`Highlight color ${option.name}${active ? ' (selected)' : ''}`}
            title={option.name}
            data-active={active}
            data-testid={`highlight-color-${option.name.toLowerCase()}`}
            // Don't steal/clear the text selection when choosing a color.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(option.value)}
            style={{ backgroundColor: option.value }}
            className={cn(
              'size-4 rounded-full border border-black/10 transition-transform hover:scale-110',
              active && 'ring-foreground/60 scale-110 ring-2 ring-offset-1',
            )}
          />
        );
      })}
    </div>
  );
}
