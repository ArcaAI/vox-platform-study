import { describe, expect, it } from 'vitest';
import {
  buildRunExport,
  characterErrorRate,
  formatRate,
  normalizeForScoring,
  parseCueFile,
  parseReferenceText,
  scoreTranscript,
  toWords,
  wordErrorRate,
} from '../scoring';

/**
 * — parity guard for `src/lib/scoring.ts`.
 *
 * The `PYTHON_PARITY` block below is the load-bearing part. Every expected CER
 * was produced by running the REAL `_norm` + `cer` from
 * `apps/stt/scripts/mlen_scorecard.py` (the quality-gate reference)
 * over the exact same strings, and asserted to full float precision. If a change
 * to `scoring.ts` makes any of these drift, the playground has stopped agreeing
 * with the regression baseline and the change is wrong — fix the port, don't
 * update the number.
 *
 * (Named `.test.tsx` rather than `.test.ts` on purpose: the app's
 * `vitest.config.ts` collects `src/**\/*.test.tsx`, which is what
 * `pnpm --filter @arcaai/compat-playground test` runs. A `.test.ts` here would
 * be silently skipped by the app suite and picked up by the root node project
 * instead.)
*/

interface ParityCase {
  name: string;
  ref: string;
  hyp: string;
  /** Exact `mlen_scorecard.py::cer(ref, hyp)` output. */
  cer: number;
  /** Exact `len(_norm(ref))` — code points, as Python counts them. */
  refChars: number;
}

const PYTHON_PARITY: ParityCase[] = [
  {
    name: 'Malayalam-English code-switch (short)',
    ref: 'രോഗിക്ക് fever ഉണ്ട്, paracetamol 500 mg കൊടുക്കണം.',
    hyp: 'രോഗിക്ക് fever und paracetamol 500 mg കൊടുക്കണം',
    cer: 0.13725490196078433,
    refChars: 51,
  },
  {
    name: 'Malayalam-English code-switch (long)',
    ref: 'എന്താണ് പ്രശ്നം doctor? എനിക്ക് two days ആയി headache ഉണ്ട്.',
    hyp: 'എന്താണ് പ്രശ്നം doctor എനിക്ക് 2 days ആയി head ache ഉണ്ട്',
    cer: 0.1,
    refChars: 60,
  },
  { name: 'identical', ref: 'the patient has fever', hyp: 'the patient has fever', cer: 0, refChars: 21 },
  { name: 'case is significant', ref: 'The Patient Has Fever', hyp: 'the patient has fever', cer: 0.19047619047619047, refChars: 21 },
  { name: 'punctuation is significant', ref: 'fever, cough.', hyp: 'fever cough', cer: 0.15384615384615385, refChars: 13 },
  { name: 'empty reference', ref: '', hyp: 'hello', cer: 5, refChars: 0 },
  { name: 'empty hypothesis', ref: 'hello', hyp: '', cer: 1, refChars: 5 },
  { name: 'both empty', ref: '', hyp: '', cer: 0, refChars: 0 },
  { name: 'whitespace collapses', ref: '   the   patient\thas\n\n\ffever   ', hyp: 'the patient has fever', cer: 0, refChars: 21 },
  { name: 'NFC folds a decomposed reference', ref: 'cafe\u0301 au lait', hyp: 'café au lait', cer: 0, refChars: 12 },
  {
    name: 'mixed word errors',
    ref: 'blood pressure is one twenty over eighty',
    hyp: 'blood pressure was 120 over eighty please',
    cer: 0.475,
    refChars: 40,
  },
];

describe('CER parity with apps/stt/scripts/mlen_scorecard.py', () => {
  it.each(PYTHON_PARITY)('$name', ({ ref, hyp, cer, refChars }) => {
    expect(characterErrorRate(ref, hyp)).toBe(cer);
    expect(Array.from(normalizeForScoring(ref)).length).toBe(refChars);
  });

  it('reports the Malayalam code-switch CER the quality gate would report', () => {
    // Sanity anchor: this clip's CER sits inside the baseline's
    // observed range (mean 0.325, ceiling 0.40) rather than being an outlier.
    const score = scoreTranscript(PYTHON_PARITY[0].ref, PYTHON_PARITY[0].hyp);
    expect(score.cer).toBeCloseTo(0.1373, 4);
    expect(score.normalizedReference).toBe(PYTHON_PARITY[0].ref);
  });
});

describe('normalizeForScoring — the ported _norm', () => {
  it('does not lowercase and does not strip punctuation', () => {
    expect(normalizeForScoring('The Patient, ok.')).toBe('The Patient, ok.');
  });

  it('collapses every whitespace run to one space and strips the edges', () => {
    expect(normalizeForScoring('  a \t\n b  \u3000 c  ')).toBe('a b c');
  });

  it("treats Python's extra whitespace characters (U+001C, U+0085) as whitespace", () => {
    // JavaScript's own `\s` matches neither — using it would silently diverge
    // from the Python gate.
    expect(normalizeForScoring('a\u001Cb')).toBe('a b');
    expect(normalizeForScoring('a\u0085b')).toBe('a b');
  });

  it('does NOT treat U+FEFF as whitespace, because Python does not', () => {
    expect(normalizeForScoring('a\uFEFFb')).toBe('a\uFEFFb');
  });

  it('NFC-normalizes before comparing', () => {
    expect(normalizeForScoring('cafe\u0301')).toBe('café');
  });
});

describe('toWords', () => {
  it('returns an empty array for blank input rather than one empty token', () => {
    expect(toWords('')).toEqual([]);
    expect(toWords('   \n ')).toEqual([]);
  });

  it('splits the normalized text on single spaces', () => {
    expect(toWords(' the   patient\thas ')).toEqual(['the', 'patient', 'has']);
  });
});

describe('wordErrorRate', () => {
  it('counts substitutions, insertions and deletions', () => {
    // ref: blood pressure is   one   twenty  over eighty
    // hyp: blood pressure was  120   ——      over eighty please
    const score = wordErrorRate('blood pressure is one twenty over eighty', 'blood pressure was 120 over eighty please');
    expect(score).toMatchObject({
      referenceWords: 7,
      hypothesisWords: 7,
      substitutions: 2, // is→was, one→120
      deletions: 1, // twenty
      insertions: 1, // please
      hits: 4, // blood, pressure, over, eighty
    });
    expect(score.wer).toBeCloseTo(4 / 7, 10);
  });

  it('is all deletions when the hypothesis is empty', () => {
    const score = wordErrorRate('one two three', '');
    expect(score).toMatchObject({ deletions: 3, insertions: 0, substitutions: 0, hits: 0, wer: 1 });
    expect(score.alignment.every((op) => op.kind === 'deletion')).toBe(true);
  });

  it('is all insertions when the reference is empty (denominator guarded at 1)', () => {
    const score = wordErrorRate('', 'one two three');
    expect(score).toMatchObject({ insertions: 3, deletions: 0, substitutions: 0 });
    expect(score.wer).toBe(3);
  });

  it('is zero for identical input', () => {
    const score = wordErrorRate('the patient has fever', 'the patient has fever');
    expect(score.wer).toBe(0);
    expect(score.alignment.map((op) => op.kind)).toEqual(['equal', 'equal', 'equal', 'equal']);
  });

  it('produces an alignment that replays the reference and the hypothesis exactly', () => {
    const ref = 'രോഗിക്ക് fever ഉണ്ട് paracetamol കൊടുക്കണം';
    const hyp = 'രോഗിക്ക് fever und paracetamol 500 കൊടുക്കണം';
    const { alignment } = wordErrorRate(ref, hyp);
    const replayedRef = alignment
      .filter((op) => op.kind !== 'insertion')
      .map((op) => op.reference)
      .join(' ');
    const replayedHyp = alignment
      .filter((op) => op.kind !== 'deletion')
      .map((op) => op.hypothesis)
      .join(' ');
    expect(replayedRef).toBe(normalizeForScoring(ref));
    expect(replayedHyp).toBe(normalizeForScoring(hyp));
  });

  it('handles a few thousand words without blowing up', () => {
    const ref = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
    const hyp = Array.from({ length: 2000 }, (_, i) => (i % 100 === 0 ? 'x' : `w${i}`)).join(' ');
    const score = wordErrorRate(ref, hyp);
    expect(score.substitutions).toBe(20);
    expect(score.insertions + score.deletions).toBe(0);
  });
});

describe('reference file parsing', () => {
  const SRT = [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    'രോഗിക്ക് fever ഉണ്ട്.',
    '',
    '2',
    '00:00:03,500 --> 00:00:06,000',
    'Paracetamol 500 mg',
    'കൊടുക്കണം.',
    '',
  ].join('\r\n');

  const VTT = [
    'WEBVTT - generated by the STT harness',
    '',
    'NOTE this block must be dropped',
    'including its continuation line',
    '',
    '00:00:01.000 --> 00:00:03.000 align:start position:10%',
    '<v Doctor>What is the problem?</v>',
    '',
    'cue-2',
    '00:00:04.000 --> 00:00:06.000',
    '<c.loud>Headache</c> &amp; fever',
    '',
  ].join('\n');

  it('keeps a cue whose spoken text is only digits (not a stray index)', () => {
    const numeric = ['1', '00:00:01,000 --> 00:00:03,000', '500', ''].join('\n');
    expect(parseCueFile(numeric)).toBe('500');
  });

  it('strips SRT indices and timecodes', () => {
    expect(parseCueFile(SRT)).toBe('രോഗിക്ക് fever ഉണ്ട്. Paracetamol 500 mg കൊടുക്കണം.');
  });

  it('strips the VTT header, NOTE blocks, cue settings, cue tags and entities', () => {
    expect(parseCueFile(VTT)).toBe('What is the problem? Headache & fever');
  });

  it('picks the parser from the filename extension', () => {
    expect(parseReferenceText(SRT, 'clip-01.srt')).toContain('Paracetamol 500 mg');
    expect(parseReferenceText(VTT, 'clip-01.vtt')).toBe('What is the problem? Headache & fever');
  });

  it('leaves .txt content alone (normalization happens at scoring time)', () => {
    expect(parseReferenceText('  raw   text  ', 'ref.txt')).toBe('  raw   text  ');
  });

  it('sniffs a cue file when the filename is unknown', () => {
    expect(parseReferenceText(SRT)).toContain('Paracetamol 500 mg');
    expect(parseReferenceText('plain transcript')).toBe('plain transcript');
  });

  it('strips a leading BOM', () => {
    expect(parseReferenceText('\uFEFFhello', 'ref.txt')).toBe('hello');
  });
});

describe('buildRunExport', () => {
  it('captures the reference, hypothesis, scores and run context', () => {
    const payload = buildRunExport(
      'the patient has fever',
      'the patient had fever',
      {
        pipelineId: 'pipeline-abc',
        languageMode: 'ml-en',
        sessionId: 'consultation-1',
        audioSource: 'file: clip-01.wav',
        referenceSource: 'clip-01.srt',
      },
      new Date('2026-08-01T10:00:00.000Z'),
    );

    expect(payload.schema).toBe('arcaai.compat-playground.scorecard/v1');
    expect(payload.generatedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(payload.scoringReference).toContain('mlen_scorecard.py');
    expect(payload.run.pipelineId).toBe('pipeline-abc');
    expect(payload.run.languageMode).toBe('ml-en');
    expect(payload.scores.substitutions).toBe(1);
    expect(payload.scores.wer).toBeCloseTo(0.25, 10);
    expect(payload.scores.cer).toBe(characterErrorRate('the patient has fever', 'the patient had fever'));
    expect(payload.normalized.reference).toBe('the patient has fever');
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe('formatRate', () => {
  it('renders a one-decimal percentage', () => {
    expect(formatRate(0.13725490196078433)).toBe('13.7%');
    expect(formatRate(0)).toBe('0.0%');
  });
});
