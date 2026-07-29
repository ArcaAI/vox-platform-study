/**
 * Content-diff util unit tests.
 *
 * `diffContent(old, new)` is the pure, dependency-light delta used to populate
 * the existing `ContextItemVersion.contentDiff` (a unified line diff) and
 * `ContextItemVersion.fieldChanges` (per-SOAP-section old/new map, with a
 * whole-document fallback) when a doctor edits / signs an AI draft. No schema
 * change — these columns already exist.
 */

import { describe, it, expect } from 'vitest';
import { diffContent } from '../content-diff.util';

describe('diffContent', () => {
  it('returns an empty delta (null/null) for identical content', () => {
    const delta = diffContent('Same note.\nLine two.', 'Same note.\nLine two.');
    expect(delta.contentDiff).toBeNull();
    expect(delta.fieldChanges).toBeNull();
  });

  it('treats null/undefined and "" as identical (no delta)', () => {
    expect(diffContent(null, '').contentDiff).toBeNull();
    expect(diffContent(undefined, undefined).fieldChanges).toBeNull();
  });

  it('produces a unified contentDiff for a single-line edit', () => {
    const oldContent = 'Patient reports headache.\nNo fever.\nFollow up in 1 week.';
    const newContent = 'Patient reports severe headache.\nNo fever.\nFollow up in 1 week.';

    const delta = diffContent(oldContent, newContent);

    expect(delta.contentDiff).toBeTruthy();
    // The changed line is captured as a removal + addition pair.
    expect(delta.contentDiff).toContain('- Patient reports headache.');
    expect(delta.contentDiff).toContain('+ Patient reports severe headache.');
    // Unchanged lines are retained as context (not duplicated as -/+).
    expect(delta.contentDiff).toContain('  No fever.');
    expect(delta.contentDiff).not.toContain('- No fever.');
  });

  it('produces fieldChanges {section:{old,new}} for a changed SOAP section', () => {
    const oldContent = [
      'Subjective:',
      'Patient reports headache.',
      'Objective:',
      'BP 120/80.',
      'Assessment:',
      'Tension headache.',
      'Plan:',
      'Rest and fluids.',
    ].join('\n');
    const newContent = [
      'Subjective:',
      'Patient reports severe headache.',
      'Objective:',
      'BP 120/80.',
      'Assessment:',
      'Tension headache.',
      'Plan:',
      'Rest and fluids.',
    ].join('\n');

    const delta = diffContent(oldContent, newContent);

    expect(delta.fieldChanges).not.toBeNull();
    // Only the Subjective section changed.
    expect(delta.fieldChanges).toEqual({
      subjective: { old: 'Patient reports headache.', new: 'Patient reports severe headache.' },
    });
    // Untouched sections are not reported.
    expect(Object.keys(delta.fieldChanges as object)).toEqual(['subjective']);
  });

  it('falls back to a whole-document fieldChange when the content is not SOAP-parseable', () => {
    const delta = diffContent('free text note one', 'free text note two');

    expect(delta.fieldChanges).toEqual({
      document: { old: 'free text note one', new: 'free text note two' },
    });
  });
});
