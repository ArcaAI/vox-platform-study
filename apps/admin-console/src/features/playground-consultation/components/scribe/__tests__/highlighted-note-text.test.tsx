/**
 * TASK-797 W3 — inline entity highlighting in the case note.
 *
 * Requirement: "highlight detected details/entities/important information". Before this
 * the console listed entities as chips only; the offsets needed to mark them in the text
 * were on the wire but stripped from the console's local type.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it } from 'vitest';
import { HighlightedNoteText } from '../highlighted-note-text';

afterEach(cleanup);

const TEXT = 'Patient reports chest pain. Started metformin 500mg twice daily.';

/**
 * The VISIBLE text — i.e. with the screen-reader-only entity annotations removed. The
 * "reassembles exactly" invariant is about what the clinician reads on screen; the
 * `.sr-only` siblings are additive context for assistive tech, asserted separately.
 * (Character-exact reassembly of the raw segments is pinned in `lib/__tests__/entity-highlights.test.ts`.)
 */
function visibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

const ENTITIES = [
  { text: 'chest pain', type: 'CONDITION', start: 16, end: 26, icd10: 'R07.9' },
  { text: 'metformin', type: 'MEDICATION', start: 36, end: 45 },
];

describe('HighlightedNoteText (TASK-797 W3)', () => {
  it('renders every character of the source text exactly once', () => {
    const { container } = render(<HighlightedNoteText text={TEXT} entities={ENTITIES} label="Live running summary" />);
    expect(visibleText(container)).toBe(TEXT);
  });

  it('marks each verified entity span', () => {
    const { container } = render(<HighlightedNoteText text={TEXT} entities={ENTITIES} label="Live running summary" />);
    const marks = [...container.querySelectorAll('mark')];
    expect(marks.map((mark) => mark.textContent)).toEqual(['chest pain', 'metformin']);
  });

  it('conveys the entity class in text, not by colour alone', () => {
    const { container } = render(<HighlightedNoteText text={TEXT} entities={ENTITIES} label="Live running summary" />);
    const mark = container.querySelector('mark') as HTMLElement;
    expect(mark.getAttribute('title')).toMatch(/CONDITION/);
    // Announced to assistive tech too — a <mark> alone is not reliably conveyed.
    expect(mark.textContent).toMatch(/chest pain/);
    expect(screen.getAllByText(/CONDITION/).length).toBeGreaterThan(0);
  });

  it('surfaces the ICD-10 code when the linker matched one', () => {
    const { container } = render(<HighlightedNoteText text={TEXT} entities={ENTITIES} label="Live running summary" />);
    expect((container.querySelector('mark') as HTMLElement).getAttribute('title')).toMatch(/R07\.9/);
  });

  it('renders unmarked text when no entity offsets verify — never approximates a span', () => {
    const { container } = render(
      // Wrong offsets: [14,24) is not "chest pain".
      <HighlightedNoteText text={TEXT} entities={[{ text: 'chest pain', type: 'CONDITION', start: 14, end: 24 }]} label="Live running summary" />,
    );
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(visibleText(container)).toBe(TEXT);
  });

  it('renders plain text when there are no entities at all', () => {
    const { container } = render(<HighlightedNoteText text={TEXT} entities={[]} label="Live running summary" />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(visibleText(container)).toBe(TEXT);
  });

  it('0 axe violations', async () => {
    const { container } = render(<HighlightedNoteText text={TEXT} entities={ENTITIES} label="Live running summary" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
