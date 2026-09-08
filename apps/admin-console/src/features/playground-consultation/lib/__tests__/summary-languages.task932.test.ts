/**
 * TASK-932 §3.7 — the summary-language options are DERIVED, not listed.
 *
 * The languages a clinician can be documented in are the languages the platform transcribes, and
 * the backend already publishes that set. A list written in the console would be a second,
 * drifting statement of the platform's language support — the "no hardcoded configuration" rule,
 * applied to a picker.
 *
 * The distinction the derivation has to preserve is the one the whole field exists for: a MODE
 * (`ml-en`, code-switch) says what the microphone may hear; a TAG (`ml`) says what the note is
 * written in. This reads the catalogue for its LANGUAGES and discards the rest of it.
 */
import { describe, expect, it } from 'vitest';

import { deriveSummaryLanguages, summaryLanguageLabel } from '../summary-languages';

describe('TASK-932 — deriveSummaryLanguages', () => {
  it('takes both languages of a code-switch mode, deduplicated across modes', () => {
    const options = deriveSummaryLanguages([
      { primaryLanguage: 'ml', secondaryLanguage: 'en' },
      { primaryLanguage: 'en', secondaryLanguage: null },
    ]);
    expect(options.map((option) => option.tag)).toEqual(['en', 'ml']);
  });

  it('names what it can and passes through what it cannot — a guessed name is worse than a tag', () => {
    const options = deriveSummaryLanguages([{ primaryLanguage: 'ml', secondaryLanguage: 'zz' }]);
    expect(options.find((option) => option.tag === 'ml')?.label).toBe('Malayalam');
    expect(options.find((option) => option.tag === 'zz')?.label).toBe('zz');
  });

  it('orders English first — the list a clinician scans fastest, not a default', () => {
    const options = deriveSummaryLanguages([
      { primaryLanguage: 'ta', secondaryLanguage: null },
      { primaryLanguage: 'en', secondaryLanguage: null },
      { primaryLanguage: 'ml', secondaryLanguage: null },
    ]);
    expect(options[0]!.tag).toBe('en');
  });

  it('falls back to the pair the platform`s own ASR agent declares when the catalogue is unreadable', () => {
    // A clinician who needs a Malayalam note must still be able to ask for one when the mode
    // catalogue blips. This changes no default: "Not declared" stays the selected value.
    for (const empty of [undefined, [], [{ primaryLanguage: null, secondaryLanguage: '' }]]) {
      expect(deriveSummaryLanguages(empty).map((option) => option.tag)).toEqual(['en', 'ml']);
    }
  });

  it('normalises case and whitespace, so one language is never offered twice', () => {
    const options = deriveSummaryLanguages([{ primaryLanguage: ' ML ', secondaryLanguage: 'ml' }]);
    expect(options.map((option) => option.tag)).toEqual(['ml']);
  });

  it('labels a regional tag by its primary subtag', () => {
    expect(summaryLanguageLabel('en-IN')).toBe('English');
    expect(summaryLanguageLabel('ml')).toBe('Malayalam');
  });
});
