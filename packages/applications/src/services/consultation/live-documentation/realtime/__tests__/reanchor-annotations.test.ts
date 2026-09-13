/**
 * offset re-anchoring.
 *
 * The property under test is the one the whole ticket turns on: with global
 * offsets, growing an EARLIER section silently invalidates every annotation after
 * it. With section-local offsets it cannot.
 */
import { describe, it, expect } from 'vitest';
import { locateSections, reanchorAnnotations } from '../reanchor-annotations';
import { buildRunningSummary } from '../../document-shape-parser';
import type { LiveSummarySectionDto } from '../../dto';

const sections = (subjective: string): LiveSummarySectionDto[] => [
  { title: 'Subjective', content: subjective },
  { title: 'Objective', content: 'BP 120/80.' },
  { title: 'Assessment', content: 'Likely viral URI; continue aspirin.' },
  { title: 'Plan', content: 'Rest and fluids.' },
];

describe('§2b — annotations are re-anchored to section-local offsets', () => {
  it('THE PROPERTY: growing an earlier section does not move a later section’s offsets', () => {
    const short = sections('Cough for three days.');
    const long = sections('Cough for three days, worse at night, no fever, no shortness of breath, no chest pain.');

    const shortDoc = buildRunningSummary(short);
    const longDoc = buildRunningSummary(long);

    // The GLOBAL offset of "aspirin" differs between the two documents…
    const shortGlobal = shortDoc.indexOf('aspirin');
    const longGlobal = longDoc.indexOf('aspirin');
    expect(shortGlobal).not.toBe(longGlobal);

    // …but its SECTION-LOCAL offset is identical, which is the whole point.
    const shortLocal = reanchorAnnotations(short, shortDoc, [{ text: 'aspirin', type: 'MEDICATION', start: shortGlobal, end: shortGlobal + 7 }]);
    const longLocal = reanchorAnnotations(long, longDoc, [{ text: 'aspirin', type: 'MEDICATION', start: longGlobal, end: longGlobal + 7 }]);

    expect(shortLocal[2]).toEqual(longLocal[2]);
    expect(shortLocal[2]).toEqual([{ kind: 'entity', start: 27, end: 34, type: 'MEDICATION' }]);
  });

  it('a local offset resolves against its OWN section’s content', () => {
    const parsed = sections('Cough for three days.');
    const doc = buildRunningSummary(parsed);
    const global = doc.indexOf('aspirin');

    const [, , assessment] = reanchorAnnotations(parsed, doc, [{ text: 'aspirin', type: 'MEDICATION', start: global, end: global + 7 }]);

    expect(parsed[2].content.slice(assessment[0].start, assessment[0].end)).toBe('aspirin');
  });

  it('assigns each annotation to exactly ONE section', () => {
    const parsed = sections('Cough for three days.');
    const doc = buildRunningSummary(parsed);
    const global = doc.indexOf('aspirin');

    const perSection = reanchorAnnotations(parsed, doc, [{ text: 'aspirin', type: 'MEDICATION', start: global, end: global + 7 }]);

    expect(perSection.map((a) => a.length)).toEqual([0, 0, 1, 0]);
  });

  it('DROPS a span that straddles a section boundary rather than clamping it', () => {
    const parsed = sections('Cough for three days.');
    const doc = buildRunningSummary(parsed);
    const start = doc.indexOf('BP 120/80.');

    // Deliberately runs past the end of `Objective` into the separator.
    const perSection = reanchorAnnotations(parsed, doc, [{ text: 'x', type: 'CONDITION', start, end: start + 40 }]);

    // A clamped highlight would point at text the annotation was not made about.
    expect(perSection.every((a) => a.length === 0)).toBe(true);
  });

  it('carries groundedness verdicts and flagged spans as section-local annotations', () => {
    const parsed = sections('Cough for three days.');
    const doc = buildRunningSummary(parsed);
    const start = doc.indexOf('Rest and fluids.');

    const perSection = reanchorAnnotations(parsed, doc, [], {
      verdict: 'ungrounded',
      checkedAt: '2026-08-28T00:00:00.000Z',
      segments: [{ text: 'Rest and fluids.', verdict: 'ungrounded', score: 0.2, start, end: start + 16 }],
      flaggedSpans: [{ start, end: start + 4 }],
    });

    expect(perSection[3]).toEqual([
      { kind: 'flagged', start: 0, end: 4 },
      { kind: 'groundedness', start: 0, end: 16, verdict: 'ungrounded', score: 0.2 },
    ]);
  });

  it('an EMPTY section is located as absent and carries no annotations — never a guessed offset', () => {
    const parsed: LiveSummarySectionDto[] = [
      { title: 'Subjective', content: 'Cough.' },
      { title: 'Objective', content: '' },
      { title: 'Assessment', content: 'Viral URI.' },
    ];
    const doc = buildRunningSummary(parsed);

    const spans = locateSections(parsed, doc);
    expect(spans[1]).toMatchObject({ start: -1, end: -1 });
    expect(reanchorAnnotations(parsed, doc, [{ text: 'Cough', type: 'CONDITION', start: 0, end: 5 }])[1]).toEqual([]);
  });

  it('A2: the TRANSCRIPT anchor rides through VERBATIM — it is not a note offset and must not be re-anchored', () => {
    const parsed = sections('Cough for three days.');
    const doc = buildRunningSummary(parsed);
    const at = doc.indexOf('aspirin');

    const [annotation] = reanchorAnnotations(parsed, doc, [
      {
        text: 'aspirin',
        type: 'MEDICATION',
        start: at,
        end: at + 7,
        // Already section-INDEPENDENT: it addresses an utterance, not the note. Re-deriving it
        // per section could only make the whole-document payload and the per-section one disagree
        // about where a finding was said.
        transcriptSegmentId: 'utt-4',
        transcriptStart: 11,
        transcriptEnd: 18,
      },
    ])[2];

    expect(annotation).toEqual({
      kind: 'entity',
      start: 27,
      end: 34,
      type: 'MEDICATION',
      transcriptSegmentId: 'utt-4',
      transcriptStart: 11,
      transcriptEnd: 18,
    });
  });

  it('A2: a PARTIAL anchor is dropped entirely, and groundedness/flagged never carry one', () => {
    const parsed = sections('Cough for three days.');
    const doc = buildRunningSummary(parsed);
    const at = doc.indexOf('aspirin');

    // A segment id with no offsets is not a weaker citation, it is an unusable one.
    const [entity] = reanchorAnnotations(parsed, doc, [
      { text: 'aspirin', type: 'MEDICATION', start: at, end: at + 7, transcriptSegmentId: 'utt-4' },
    ])[2];
    expect(entity).toEqual({ kind: 'entity', start: 27, end: 34, type: 'MEDICATION' });

    // A groundedness verdict is a claim about the NOTE; it has no transcript span of its own.
    const grounded = reanchorAnnotations(parsed, doc, [], {
      verdict: 'grounded',
      checkedAt: '2026-09-13T00:00:00.000Z',
      segments: [{ text: 'BP 120/80.', verdict: 'grounded', start: doc.indexOf('BP 120/80.'), end: doc.indexOf('BP 120/80.') + 10 }],
    })[1];
    expect(grounded).toEqual([{ kind: 'groundedness', start: 0, end: 10, verdict: 'grounded' }]);
  });

  it('two sections with IDENTICAL content resolve to their own occurrences, not both to the first', () => {
    const parsed: LiveSummarySectionDto[] = [
      { title: 'A', content: 'None.' },
      { title: 'B', content: 'None.' },
    ];
    const doc = buildRunningSummary(parsed);

    const spans = locateSections(parsed, doc);
    expect(spans[0].start).toBe(0);
    expect(spans[1].start).toBe(doc.lastIndexOf('None.'));
    expect(spans[0].start).not.toBe(spans[1].start);
  });
});
