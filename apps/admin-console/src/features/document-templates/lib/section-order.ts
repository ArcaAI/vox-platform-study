import type { DocumentSectionDeclaration } from '../api/types';

/**
 * Move one section by one position.
 *
 * Reordering is offered as a pair of Move up / Move down BUTTONS rather than a
 * drag handle. That is not a shortcut: WCAG 2.2 2.5.7 requires a single-pointer
 * alternative to any dragging motion, and a keyboard-native pair of buttons IS
 * that alternative — with no drag surface to also maintain, and no
 * pointer-precision floor for an admin reordering a ten-section discharge
 * summary.
 *
 * An out-of-range move returns the ORIGINAL array by reference, so pressing
 * Move up on the first section cannot mark the draft dirty or push a
 * no-op onto the publish diff.
 */
export function moveSection(sections: DocumentSectionDeclaration[], index: number, delta: -1 | 1): DocumentSectionDeclaration[] {
  const target = index + delta;
  if (index < 0 || index >= sections.length || target < 0 || target >= sections.length) return sections;

  const next = [...sections];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
