/**
 * "autofill summaries and gist into customized SOAP forms".
 *
 * There is no SOAP FORM to fill: `SummaryResult.content` is one prose string, server-side
 * (`use-note-editor.ts`'s own docstring records this: "the server stores whole-document
 * `content`"). So the honest reading of the requirement inside this boundary is to fill the
 * note the clinician actually edits, keeping the SOAP structure the live stream already
 * carries in `LiveSummarySnapshot.sections` — rather than dumping `runningSummary` as a blob.
 *
 * The composition rule is the safety-relevant part: this NEVER replaces clinician text.
 */
import { describe, expect, it } from 'vitest';
import { composeAutofill, formatSoapSections } from '../soap-autofill';

const SECTIONS = [
  { title: 'Subjective', content: 'Chest pain for two days.' },
  { title: 'Objective', content: 'BP 148/92. Chest clear.' },
  { title: 'Assessment', content: 'Likely musculoskeletal.' },
  { title: 'Plan', content: 'NSAIDs, review in one week.' },
];

describe('formatSoapSections', () => {
  it('renders the four sections in canonical S/O/A/P order with their headings', () => {
    expect(formatSoapSections(SECTIONS)).toBe(
      'Subjective:\nChest pain for two days.\n\nObjective:\nBP 148/92. Chest clear.\n\nAssessment:\nLikely musculoskeletal.\n\nPlan:\nNSAIDs, review in one week.',
    );
  });

  it('reorders sections that arrive out of order', () => {
    const shuffled = [SECTIONS[3], SECTIONS[0], SECTIONS[2], SECTIONS[1]];
    expect(formatSoapSections(shuffled)).toBe(formatSoapSections(SECTIONS));
  });

  it('omits a section with no content rather than emitting an empty heading', () => {
    expect(formatSoapSections([SECTIONS[0], { title: 'Objective', content: '   ' }])).toBe('Subjective:\nChest pain for two days.');
  });

  it('keeps a non-SOAP section, after the four, rather than dropping content', () => {
    const withExtra = [...SECTIONS, { title: 'Running Summary', content: 'Overall stable.' }];
    expect(formatSoapSections(withExtra).endsWith('Running Summary:\nOverall stable.')).toBe(true);
  });

  it('returns an empty string when there is nothing to fill from', () => {
    expect(formatSoapSections([])).toBe('');
    expect(formatSoapSections([{ title: 'Subjective', content: '' }])).toBe('');
  });
});

describe('composeAutofill', () => {
  it('fills an empty buffer outright', () => {
    expect(composeAutofill('', 'Subjective:\nX')).toBe('Subjective:\nX');
  });

  it('treats a whitespace-only buffer as empty', () => {
    expect(composeAutofill('   \n\n ', 'Subjective:\nX')).toBe('Subjective:\nX');
  });

  it('APPENDS to a buffer that holds clinician text — it never replaces it', () => {
    const existing = 'Pt seen with daughter present.';
    const result = composeAutofill(existing, 'Subjective:\nX');
    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain('Subjective:\nX');
  });

  it('separates the appended block so the two do not run together', () => {
    expect(composeAutofill('Existing.', 'Subjective:\nX')).toBe('Existing.\n\nSubjective:\nX');
  });

  it('returns the buffer unchanged when there is nothing to fill in', () => {
    expect(composeAutofill('Existing.', '')).toBe('Existing.');
    expect(composeAutofill('Existing.', '   ')).toBe('Existing.');
  });
});
