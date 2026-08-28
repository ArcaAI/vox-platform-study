/**
 * Section ORDER is part of the contract, not presentation: the compiler emits
 * `sectionKeys` "in AUTHORED order" and the generated document follows it. So
 * reordering is an edit like any other, and these are its rules.
 */

import { describe, expect, it } from 'vitest';
import { moveSection } from '../section-order';
import type { DocumentSectionDeclaration } from '../../api/types';

const sections: DocumentSectionDeclaration[] = [
  { key: 'a', title: 'A', form: 'PROSE' },
  { key: 'b', title: 'B', form: 'PROSE' },
  { key: 'c', title: 'C', form: 'PROSE' },
];

const keys = (list: DocumentSectionDeclaration[]) => list.map((section) => section.key);

describe('moveSection', () => {
  it('moves a section up', () => {
    expect(keys(moveSection(sections, 1, -1))).toEqual(['b', 'a', 'c']);
  });

  it('moves a section down', () => {
    expect(keys(moveSection(sections, 1, 1))).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at the top edge, returning the SAME array so no spurious draft change is recorded', () => {
    expect(moveSection(sections, 0, -1)).toBe(sections);
  });

  it('is a no-op at the bottom edge', () => {
    expect(moveSection(sections, 2, 1)).toBe(sections);
  });

  it('never mutates the input', () => {
    const before = keys(sections);
    moveSection(sections, 0, 1);
    expect(keys(sections)).toEqual(before);
  });
});
