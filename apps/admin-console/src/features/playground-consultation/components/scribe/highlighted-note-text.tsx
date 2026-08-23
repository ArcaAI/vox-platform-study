'use client';

/**
 * TASK-797 W3 — the case note's text, with detected clinical entities marked inline.
 *
 * The splitting and, crucially, the VERIFICATION of every offset lives in
 * `../../lib/entity-highlights` so the safety property is testable without React: a span
 * whose `[start, end)` does not slice out its own text is dropped, never re-anchored.
 * This component only renders what survived.
 *
 * Accessibility (rule 11 §11): `<mark>` is not reliably announced, and highlight colour
 * alone must never carry meaning, so each mark also carries a `title` and a visually
 * hidden parenthetical naming the entity class (and the ICD-10 code when the NLP
 * OntologyLinker matched one). Sighted users get an underline in addition to the tint.
 */

import { cn } from '@arcaai/ui';
import { buildEntityHighlights, verifiedEntitySpans, type EntityCandidate } from '../../lib/entity-highlights';

export interface HighlightedNoteTextProps {
  text: string;
  /** Live-summary entities. Those without verifiable offsets are simply not marked. */
  entities: readonly EntityCandidate[];
  /** Accessible name for the passage. */
  label: string;
  className?: string;
}

function describeEntity(type: string, icd10?: string): string {
  return icd10 ? `${type} · ${icd10}` : type;
}

export function HighlightedNoteText({ text, entities, label, className }: HighlightedNoteTextProps) {
  const segments = buildEntityHighlights(text, verifiedEntitySpans(text, entities));

  return (
    <p className={cn('text-sm leading-relaxed whitespace-pre-wrap', className)} aria-label={label}>
      {segments.map((segment, index) =>
        segment.entity ? (
          <span key={index}>
            <mark
              data-entity-type={segment.entity.type}
              title={describeEntity(segment.entity.type, segment.entity.icd10)}
              className="bg-ai/15 text-foreground decoration-ai/60 rounded-sm px-0.5 underline decoration-dotted underline-offset-2"
            >
              {segment.text}
            </mark>
            {/* Sibling, not a child: the mark's own text stays exactly the clinical span,
                while the class (and code) are still readable text rather than colour alone. */}
            <span className="sr-only"> ({describeEntity(segment.entity.type, segment.entity.icd10)})</span>
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
