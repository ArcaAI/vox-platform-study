/**
 * `known_phi` — the values the gateway ALREADY KNOWS are PHI, sent to `apps/text` so a cloud call
 * replaces them deterministically in addition to the detector's spans.
 *
 * Sources: context-schema kinds whose `phiClass` is `PHI` (their SHORT string values — free text is
 * the detector's job), the consultation's patient identifier, and the clinician's name / staff id.
 * Bounds: value ≥ 2 characters, at most 200 entries, de-duplicated case-insensitively.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_PHI_MAX_ITEMS, collectKnownPhi } from '../known-phi';

const definition = {
  schemaVersion: '1.0',
  kinds: [
    { key: 'patient', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { type: 'object' } },
    { key: 'mrn', primitive: 'TEXT', phiClass: 'PHI' },
    { key: 'referral_letter', primitive: 'TEXT', phiClass: 'PHI' },
    { key: 'vitals', primitive: 'STRUCTURED', phiClass: 'NON_PHI' },
  ],
};

describe('collectKnownPhi', () => {
  it('collects short string values of PHI kinds, labelled by field / kind key', () => {
    const entries = collectKnownPhi({
      definition,
      context: {
        patient: { patient_name: 'Asha Menon', dob: '1961-04-02', sex: 'F', age: 63, address: { city: 'Kochi' } },
        mrn: 'MRN-0042',
        vitals: { hr: '72', note: 'Asha Menon' },
      },
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        { label: 'patient_name', value: 'Asha Menon' },
        { label: 'dob', value: '1961-04-02' },
        { label: 'city', value: 'Kochi' },
        { label: 'mrn', value: 'MRN-0042' },
      ]),
    );
    // A one-character value, a number and anything of a NON_PHI kind are not sent.
    expect(entries.map((entry) => entry.value)).not.toEqual(expect.arrayContaining(['F', '63', '72']));
    expect(entries.filter((entry) => entry.value === 'Asha Menon')).toHaveLength(1);
  });

  it('leaves long or multi-line free text to the detector rather than replacing it wholesale', () => {
    const letter = 'Dear colleague,\nI am referring this patient for review of a long-standing cough.';
    const entries = collectKnownPhi({ definition, context: { referral_letter: letter } });
    expect(entries).toEqual([]);
  });

  it('adds the patient identifier and the clinician name and staff id', () => {
    const entries = collectKnownPhi({ patientId: 'P-77812', clinician: { firstName: 'Ravi', lastName: 'Kumar', staffId: 'ST-9' } });
    expect(entries).toEqual([
      { label: 'patient id', value: 'P-77812' },
      { label: 'clinician name', value: 'Ravi Kumar' },
      { label: 'clinician name', value: 'Ravi' },
      { label: 'clinician name', value: 'Kumar' },
      { label: 'staff id', value: 'ST-9' },
    ]);
  });

  it('de-duplicates case-insensitively and ignores whitespace-only differences', () => {
    const entries = collectKnownPhi({ definition, patientId: 'mrn-0042', context: { mrn: '  MRN-0042 ' } });
    expect(entries).toEqual([{ label: 'patient id', value: 'mrn-0042' }]);
  });

  it(`caps the list at ${KNOWN_PHI_MAX_ITEMS} entries`, () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`f${index}`, `value-${index}`]));
    expect(collectKnownPhi({ definition, context: { patient: many } })).toHaveLength(KNOWN_PHI_MAX_ITEMS);
    expect(KNOWN_PHI_MAX_ITEMS).toBe(200);
  });

  it('is total: no definition, no context, malformed input — an empty list, never a throw', () => {
    expect(collectKnownPhi({})).toEqual([]);
    expect(collectKnownPhi({ definition: 'nope', context: { patient: 'x' } as never })).toEqual([]);
    expect(collectKnownPhi({ definition, context: null })).toEqual([]);
  });
});
