/**
 * TASK-714 — legacy dosage-parity check (native TS port of the harness's
 * `numeric_dose.py` sensor, simplified). See `legacy-dosage-check.util.ts` for
 * the scope note: this is a floor, not parity with the Python sensor.
 */
import { describe, expect, it } from 'vitest';
import { checkDosageParity } from '../legacy-dosage-check.util';

describe('checkDosageParity', () => {
  it('flags a dose in the note that is absent from the transcript', () => {
    const note = 'Prescribed amoxicillin 500 mg three times daily.';
    const transcript = 'Patient reports fever and sore throat for two days.';

    const result = checkDosageParity(note, transcript);

    expect(result.flagged).toBe(true);
    expect(result.unmatchedTokens).toContain('500 mg');
  });

  it('does not flag when every note dose appears in the transcript', () => {
    const note = 'Continue metformin 500 mg twice daily.';
    const transcript = 'Doctor: we will keep you on metformin 500 mg twice daily.';

    const result = checkDosageParity(note, transcript);

    expect(result.flagged).toBe(false);
    expect(result.unmatchedTokens).toEqual([]);
  });

  it('degrades to flagged when the note has numbers but the transcript is empty', () => {
    const note = 'Ibuprofen 200 mg as needed.';

    const result = checkDosageParity(note, '');

    expect(result.flagged).toBe(true);
    expect(result.unmatchedTokens).toContain('200 mg');
  });

  it('does not flag a note with no numeric/dose tokens at all', () => {
    const note = 'Patient advised to rest and stay hydrated.';

    const result = checkDosageParity(note, '');

    expect(result.flagged).toBe(false);
    expect(result.unmatchedTokens).toEqual([]);
  });

  it('ignores bare single-digit integers with no unit (list markers/ordinals)', () => {
    const note = '1. Discussed diagnosis. 2. Discussed treatment plan.';

    const result = checkDosageParity(note, '');

    expect(result.flagged).toBe(false);
  });

  it('matches a note number against a transcript token sharing the same unit', () => {
    const note = 'Follow up in 30 days.';
    const transcript = 'We agreed on a 30 days follow-up window.';

    const result = checkDosageParity(note, transcript);

    expect(result.flagged).toBe(false);
  });
});
