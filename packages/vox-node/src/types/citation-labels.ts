/**
 * Inline citation labels in a generated note ([S7 E1], [S8], [A2], [S4 E1 Patient 00:12]) and their
 * removal for text that leaves HOPE for an EMR or export. This package has zero runtime
 * dependencies, so the helpers are implemented here rather than imported from `@arcaai/types`;
 * both follow `tests/contracts/citation-labels.fixture.json` exactly.
 */

/** A bracket opening with S|A|R + digits, optionally followed by a space/tab and text up to `]` on the same line. */
export const CITATION_LABEL_PATTERN = '\\[[SAR]\\d+(?:[ \\t][^\\]\\n]*)?\\]';

/** Remove every label, keeping line breaks, indentation and all other text byte for byte. */
export function stripCitationLabels(text: string): string {
  return text
    .replace(new RegExp(`^([ \\t]*)(?:${CITATION_LABEL_PATTERN}[ \\t]*)+`, 'gm'), '$1')
    .replace(new RegExp(`[ \\t]*${CITATION_LABEL_PATTERN}`, 'g'), '');
}

/** The inner text of every label occurrence, in order, not de-duplicated. */
export function citationLabelsOf(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(CITATION_LABEL_PATTERN, 'g')), (m) => m[0].slice(1, -1));
}
