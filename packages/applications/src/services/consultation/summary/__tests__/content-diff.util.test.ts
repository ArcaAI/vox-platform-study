/**
 * Content-diff util unit tests.
 *
 * `diffContent(old, new, compiled?)` is the pure, dependency-light delta used to
 * populate the existing `ContextItemVersion.contentDiff` (a unified line diff)
 * and `ContextItemVersion.fieldChanges` (a per-SECTION old/new map, with a
 * whole-document fallback) when a doctor edits / signs an AI draft. No schema
 * change — these columns already exist.
 *
 * TASK-810 carry-over A: the section vocabulary is now supplied by the caller's
 * COMPILED DOCUMENT TEMPLATE instead of a private four-key SOAP tuple. The
 * cases below lock both halves of that contract: with a shape the map is keyed
 * on that shape's section keys (whatever they are, however many), and with NO
 * shape the util degrades to the whole-document fallback it always documented.
 */

import { describe, it, expect } from 'vitest';
import { diffContent } from '../content-diff.util';
import { compileDocumentTemplate } from '../../../document-template/document-template-compiler';
import { SOAP_NOTE_SHAPE } from '../../../document-template/platform-document-shapes';
import type { DocumentTemplateShape } from '../../../document-template/document-template-shape';

const SOAP = compileDocumentTemplate(SOAP_NOTE_SHAPE);

/**
 * A deliberately NON-SOAP shape: five sections, none of them called
 * Subjective/Objective/Assessment/Plan, and one whose title ("Follow-up")
 * differs from its key (`follow_up`). If anything in the util still knows the
 * word SOAP, or still assumes four sections, this shape exposes it.
 */
const DISCHARGE_SHAPE: DocumentTemplateShape = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [
    { key: 'admission_reason', title: 'Reason for Admission', form: 'PROSE' },
    { key: 'hospital_course', title: 'Hospital Course', form: 'PROSE' },
    { key: 'discharge_medications', title: 'Discharge Medications', form: 'BULLETS' },
    { key: 'follow_up', title: 'Follow-up', form: 'PROSE' },
    { key: 'red_flags', title: 'Red Flags', form: 'PROSE' },
  ],
};
const DISCHARGE = compileDocumentTemplate(DISCHARGE_SHAPE);

const soapNote = (subjective: string): string =>
  ['Subjective:', subjective, 'Objective:', 'BP 120/80.', 'Assessment:', 'Tension headache.', 'Plan:', 'Rest and fluids.'].join('\n');

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

  describe('shape-driven fieldChanges', () => {
    it('produces fieldChanges {section:{old,new}} for a changed section of the SUPPLIED shape', () => {
      const delta = diffContent(soapNote('Patient reports headache.'), soapNote('Patient reports severe headache.'), SOAP);

      expect(delta.fieldChanges).not.toBeNull();
      // Only the Subjective section changed. The key is the SHAPE's section
      // key, which for the platform SOAP shape is the same `subjective` this
      // util emitted when the four names were hardcoded — existing
      // `fieldChanges` rows stay comparable.
      expect(delta.fieldChanges).toEqual({
        subjective: { old: 'Patient reports headache.', new: 'Patient reports severe headache.' },
      });
      expect(Object.keys(delta.fieldChanges as object)).toEqual(['subjective']);
    });

    it('keys fieldChanges on a NON-SOAP shape with more than four sections', () => {
      const before = [
        'Reason for Admission:',
        'Chest pain.',
        'Hospital Course:',
        'Troponin negative.',
        'Discharge Medications:',
        '- Aspirin 75mg',
        'Follow-up:',
        'GP in 2 weeks.',
        'Red Flags:',
        'Return if pain recurs.',
      ].join('\n');
      const after = before.replace('Troponin negative.', 'Troponin negative; serial ECGs unchanged.');

      const delta = diffContent(before, after, DISCHARGE);

      expect(delta.fieldChanges).toEqual({
        hospital_course: { old: 'Troponin negative.', new: 'Troponin negative; serial ECGs unchanged.' },
      });
    });

    it('matches a section by its TITLE and reports it under the section KEY', () => {
      // "Follow-up" (title, hyphenated) is what a model writes; `follow_up`
      // (key) is what the map must be keyed on.
      const before = ['Hospital Course:', 'Uneventful.', 'Follow-up:', 'GP in 2 weeks.'].join('\n');
      const after = ['Hospital Course:', 'Uneventful.', 'Follow-up:', 'GP in 1 week.'].join('\n');

      const delta = diffContent(before, after, DISCHARGE);

      expect(delta.fieldChanges).toEqual({ follow_up: { old: 'GP in 2 weeks.', new: 'GP in 1 week.' } });
    });

    it('matches a section by its KEY when the model emits the key as the heading', () => {
      const before = ['## hospital_course', 'Uneventful.', '## follow_up', 'GP in 2 weeks.'].join('\n');
      const after = ['## hospital_course', 'Uneventful.', '## follow_up', 'GP in 1 week.'].join('\n');

      const delta = diffContent(before, after, DISCHARGE);

      expect(delta.fieldChanges).toEqual({ follow_up: { old: 'GP in 2 weeks.', new: 'GP in 1 week.' } });
    });

    it('reports a section that only exists on ONE side as an add / remove', () => {
      const before = ['Hospital Course:', 'Uneventful.'].join('\n');
      const after = ['Hospital Course:', 'Uneventful.', 'Red Flags:', 'Return if pain recurs.'].join('\n');

      const delta = diffContent(before, after, DISCHARGE);

      expect(delta.fieldChanges).toEqual({ red_flags: { old: null, new: 'Return if pain recurs.' } });
    });

    it('does not leak a SOAP heading into a shape that does not declare it', () => {
      // The note is a SOAP note; the resolved shape is the discharge summary.
      // Nothing recognisable ⇒ whole-document fallback, NOT a `subjective` key
      // the tenant's template never declared.
      const delta = diffContent(soapNote('A.'), soapNote('B.'), DISCHARGE);

      expect(Object.keys(delta.fieldChanges as object)).toEqual(['document']);
    });
  });

  describe('whole-document fallback', () => {
    it('falls back when NO shape is supplied, even for a SOAP-shaped note', () => {
      // Carry-over A: without a resolved template this util has no section
      // vocabulary at all. It must not fall back to a private hardcoded SOAP
      // tuple — that assumption is exactly what TASK-810 removes.
      const before = soapNote('Patient reports headache.');
      const after = soapNote('Patient reports severe headache.');

      const delta = diffContent(before, after);

      expect(delta.fieldChanges).toEqual({ document: { old: before, new: after } });
    });

    it('falls back when the supplied shape is null or undefined', () => {
      const delta = diffContent('free text note one', 'free text note two', null);
      expect(delta.fieldChanges).toEqual({ document: { old: 'free text note one', new: 'free text note two' } });
    });

    it('falls back when the supplied shape declares no sections', () => {
      const empty = compileDocumentTemplate({ schemaVersion: '1.0', title: 'Empty', sections: [] });
      const delta = diffContent(soapNote('A.'), soapNote('B.'), empty);
      expect(Object.keys(delta.fieldChanges as object)).toEqual(['document']);
    });

    it('falls back when the content is not parseable against the supplied shape', () => {
      const delta = diffContent('free text note one', 'free text note two', SOAP);

      expect(delta.fieldChanges).toEqual({
        document: { old: 'free text note one', new: 'free text note two' },
      });
    });

    it('falls back when a change lands OUTSIDE every recognised section', () => {
      // A preamble edit: the sections themselves are byte-identical, so the
      // section map yields no changes and the whole-document delta is the only
      // honest record of what the clinician touched.
      const before = ['Draft v1', soapNote('Patient reports headache.')].join('\n');
      const after = ['Draft v2', soapNote('Patient reports headache.')].join('\n');

      const delta = diffContent(before, after, SOAP);

      expect(delta.fieldChanges).toEqual({ document: { old: before, new: after } });
    });
  });
});
