/**
 * The Prompt Inspector's TS mirror of `apps/text`'s `Pseudonymizer` — the SAME `[<LABEL>_<n>]`
 * grammar, the same precedence, the same counts — so `providerView` shows exactly what a cloud
 * provider would receive. Cases mirror `apps/text/.../test_task1035_locality_and_pseudonymizer.py`.
 */
import { describe, expect, it } from 'vitest';
import { PreviewPseudonymizer, tokenLabel } from '../preview-pseudonymizer';

describe('PreviewPseudonymizer — parity with apps/text', () => {
  it('replaces a known value case-insensitively and stably', () => {
    const p = new PreviewPseudonymizer([['patient_name', 'John Doe']]);
    const out = p.pseudonymize('John Doe came in. JOHN   doe has a cough.', []);
    expect(out).toBe('[PATIENT_NAME_1] came in. [PATIENT_NAME_1] has a cough.');
    expect(p.redacted).toBe(2);
    expect(p.detected).toEqual({ patient_name: 2 });
  });

  it('respects word boundaries', () => {
    const p = new PreviewPseudonymizer([['person', 'Ann']]);
    expect(p.pseudonymize('Annual review for Ann.', [])).toBe('Annual review for [PERSON_1].');
  });

  it('mints per-label, per-value tokens that hold across fields', () => {
    const p = new PreviewPseudonymizer([]);
    const system = p.pseudonymize('Clinician: Dr Smith.', [{ label: 'person', start: 11, end: 19 }]);
    const prompt = p.pseudonymize('Dr Smith saw Mary Jones.', [
      { label: 'person', start: 0, end: 8 },
      { label: 'person', start: 13, end: 23 },
    ]);
    expect(system).toBe('Clinician: [PERSON_1].');
    expect(prompt).toBe('[PERSON_1] saw [PERSON_2].');
    expect(p.detected).toEqual({ person: 3 });
  });

  it('forms the label as uppercase snake', () => {
    expect(tokenLabel('date of-birth')).toBe('DATE_OF_BIRTH');
    const p = new PreviewPseudonymizer([['date of-birth', '1970-01-02']]);
    expect(p.pseudonymize('DOB 1970-01-02', [])).toBe('DOB [DATE_OF_BIRTH_1]');
  });

  it('replaces an overlapping span and known value ONCE, the known value winning', () => {
    const p = new PreviewPseudonymizer([['mrn', 'MRN-12345']]);
    expect(p.pseudonymize('Record MRN-12345 open.', [{ label: 'account_id', start: 7, end: 16 }])).toBe('Record [MRN_1] open.');
    expect(p.redacted).toBe(1);
  });

  it('count() detects without replacing (the LOCAL path)', () => {
    const p = new PreviewPseudonymizer([['person', 'John Doe']]);
    p.count('John Doe, 54.', [{ label: 'person', start: 0, end: 8 }]);
    expect(p.detected).toEqual({ person: 1 });
    expect(p.redacted).toBe(0);
  });

  it('reads span offsets as CODE POINTS, like the Python service', () => {
    const p = new PreviewPseudonymizer([]);
    // 😀 is ONE code point but TWO UTF-16 units: "Ada" starts at code point 2.
    expect(p.pseudonymize('😀 Ada wept.', [{ label: 'person', start: 2, end: 5 }])).toBe('😀 [PERSON_1] wept.');
  });
});
