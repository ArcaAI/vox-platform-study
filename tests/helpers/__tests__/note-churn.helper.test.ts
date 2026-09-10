/**
 * TASK-939 §6.1 — the churn checker itself, because a measuring instrument that is wrong is worse
 * than none: it would certify the defect as fixed.
 */
import { describe, expect, it } from 'vitest';

import { analyseNoteChurn, formatChurnReport, type ChurnPatch } from '../note-churn.helper';

const patch = (over: Partial<ChurnPatch> & Pick<ChurnPatch, 'revision' | 'content'>): ChurnPatch => ({
  documentKey: 'soap_note',
  sectionKey: 'subjective',
  ...over,
});

describe('analyseNoteChurn', () => {
  it('reports ZERO churn for a purely additive section', () => {
    const report = analyseNoteChurn([
      patch({ revision: 1, content: 'A.', appended: 'A.' }),
      patch({ revision: 2, content: 'A.\n\nB.', appended: 'B.' }),
      patch({ revision: 3, content: 'A.\n\nB.\n\nC.', appended: 'C.' }),
    ]);

    expect(report.churnedChars).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.cleanAppends).toBe(3);
    expect(report.finalChars['soap_note::subjective']).toBe('A.\n\nB.\n\nC.'.length);
  });

  it('charges the FULL prior length when a revision breaks the prefix rule', () => {
    const report = analyseNoteChurn([
      patch({ revision: 1, content: 'Temp 37.8.', appended: 'Temp 37.8.' }),
      patch({ revision: 2, content: 'Temp 39.1.' }),
    ]);

    expect(report.churnedChars).toBe('Temp 37.8.'.length);
    expect(report.replacements).toBe(1);
    expect(report.violations).toEqual([
      {
        documentKey: 'soap_note',
        sectionKey: 'subjective',
        revision: 2,
        previousRevision: 1,
        churnedChars: 'Temp 37.8.'.length,
        declaredReplace: true,
      },
    ]);
  });

  it('marks an "append" that broke the prefix rule as NOT a declared replace — the worse failure', () => {
    // A replace announces itself by carrying no `appended`. A patch that claimed to append and then
    // disturbed earlier text is a lying write, and the report must distinguish the two.
    const report = analyseNoteChurn([
      patch({ revision: 1, content: 'Original.', appended: 'Original.' }),
      patch({ revision: 2, content: 'Rewritten.', appended: 'Rewritten.' }),
    ]);

    expect(report.violations[0]!.declaredReplace).toBe(false);
  });

  it('sorts by revision, so out-of-order delivery is not mistaken for churn', () => {
    const report = analyseNoteChurn([
      patch({ revision: 3, content: 'A.\n\nB.\n\nC.', appended: 'C.' }),
      patch({ revision: 1, content: 'A.', appended: 'A.' }),
      patch({ revision: 2, content: 'A.\n\nB.', appended: 'B.' }),
    ]);

    expect(report.churnedChars).toBe(0);
  });

  it('ignores a duplicate delivery of the same revision', () => {
    const report = analyseNoteChurn([
      patch({ revision: 1, content: 'A.', appended: 'A.' }),
      patch({ revision: 1, content: 'A.', appended: 'A.' }),
    ]);

    expect(report.patchCount).toBe(1);
    expect(report.churnedChars).toBe(0);
  });

  it('skips DEGRADE patches — an outage must not be scored as a rewrite', () => {
    const report = analyseNoteChurn([
      patch({ revision: 1, content: 'A.', appended: 'A.' }),
      patch({ revision: 0, content: '', degradeReason: 'timed-out: 60000ms' }),
      patch({ revision: 2, content: 'A.\n\nB.', appended: 'B.' }),
    ]);

    expect(report.churnedChars).toBe(0);
    expect(report.patchCount).toBe(2);
  });

  it('keeps sections and documents independent', () => {
    const report = analyseNoteChurn([
      patch({ revision: 1, content: 'S1.', appended: 'S1.' }),
      patch({ sectionKey: 'objective', revision: 1, content: 'O1.', appended: 'O1.' }),
      patch({ documentKey: 'discharge_summary', sectionKey: 'subjective', revision: 1, content: 'D1.', appended: 'D1.' }),
    ]);

    expect(report.sectionCount).toBe(3);
    expect(report.churnedChars).toBe(0);
  });

  it('does not charge churn for a section that was empty before', () => {
    const report = analyseNoteChurn([patch({ revision: 1, content: '' }), patch({ revision: 2, content: 'First real content.' })]);

    expect(report.churnedChars).toBe(0);
  });

  it('renders a PHI-free one-line summary', () => {
    const line = formatChurnReport(analyseNoteChurn([patch({ revision: 1, content: 'Secret clinical text.', appended: 'Secret clinical text.' })]));

    expect(line).toBe('churnedChars=0 patches=1 sections=1 cleanAppends=1 replacements=0 violations=0');
    expect(line).not.toContain('Secret');
  });
});
