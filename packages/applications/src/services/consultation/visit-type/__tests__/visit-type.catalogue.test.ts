/**
 * The VISIT-TYPE CATALOGUE — the pure half.
 *
 * Owner ruling (TASK-815 §11 row 3): "Visit type is tenant-admin defined and
 * controlled. Two defaults ship: New patient (new visit, new referral) and
 * Revisit (follow-up same-day, review same-day, revisit same-day)."
 *
 * These tests pin the two things a literal could never give us: that the
 * SHIPPED default is exactly the owner's two types, and that a tenant's own
 * catalogue is refused when it would make resolution ambiguous or silently
 * mis-select a clinical prompt.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  CONSULTATION_VISIT_TYPES_KEY,
  matchVisitType,
  normalizeVisitTypeToken,
  promptSlotFor,
  selectVisitType,
  visitTypeCatalogueProblem,
  type VisitTypeDefinition,
} from '../visit-type.catalogue';

describe('the shipped default catalogue', () => {
  it('is the owner’s two visit types, in order, at the SYSTEM tier', () => {
    expect(CONSULTATION_VISIT_TYPES_KEY).toBe('consultation.visitTypes');
    expect(CONSULTATION_VISIT_TYPES_DEFAULT.map((v) => v.key)).toEqual(['new-patient', 'revisit']);
    expect(CONSULTATION_VISIT_TYPES_DEFAULT.map((v) => v.label)).toEqual(['New patient', 'Revisit']);
  });

  it('carries the owner’s parenthesised terms as ALIASES, not as separate types', () => {
    const [newPatient, revisit] = CONSULTATION_VISIT_TYPES_DEFAULT;
    // "New patient (new visit, new referral)"
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new visit')).toBe(newPatient);
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'New Referral')).toBe(newPatient);
    // "Revisit (follow-up same-day, review same-day, revisit same-day)"
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'follow-up same-day')).toBe(revisit);
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'Review Same-Day')).toBe(revisit);
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'revisit same day')).toBe(revisit);
  });

  it('still matches every visit-type literal that existed in code before the catalogue', () => {
    // `text-proxy.controller.ts`'s closed `VisitType` union…
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new_visit')?.key).toBe('new-patient');
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'referral')?.key).toBe('new-patient');
    // …the `{visit_type}` prompt-variable vocabulary…
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new-visit')?.key).toBe('new-patient');
    // …and the two `promptType` keys themselves.
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new-patient')?.key).toBe('new-patient');
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'revisit')?.key).toBe('revisit');
  });

  it('assembles cleanly through its own validator', () => {
    expect(visitTypeCatalogueProblem(CONSULTATION_VISIT_TYPES_DEFAULT)).toBeUndefined();
  });
});

describe('normalizeVisitTypeToken', () => {
  it('folds case, separators and surrounding space onto one token', () => {
    expect(normalizeVisitTypeToken('  Follow-Up  Same_Day ')).toBe('follow-up-same-day');
    expect(normalizeVisitTypeToken('New Visit')).toBe('new-visit');
    expect(normalizeVisitTypeToken('')).toBe('');
  });
});

describe('selectVisitType — the ONE place the parent-link heuristic lives', () => {
  it('prefers the consultation’s RECORDED visit type over the parent link', () => {
    const picked = selectVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, { recorded: 'follow-up', isFollowUp: false });
    expect(picked.key).toBe('revisit');
  });

  it('falls back to the parent link when nothing is recorded — the pre-catalogue behaviour', () => {
    expect(selectVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, { isFollowUp: true }).key).toBe('revisit');
    expect(selectVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, { isFollowUp: false }).key).toBe('new-patient');
  });

  it('falls back to the parent link when the recorded string matches NOTHING — never forces a guess', () => {
    expect(selectVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, { recorded: 'tele-triage', isFollowUp: true }).key).toBe('revisit');
  });

  it('lets a tenant put its OWN type in front of the shipped one for a slot', () => {
    const tenant: VisitTypeDefinition[] = [
      { key: 'telehealth-revisit', label: 'Telehealth revisit', aliases: ['tele-followup'], promptSlot: 'revisit' },
      ...CONSULTATION_VISIT_TYPES_DEFAULT,
    ];
    // Ordered: the first entry carrying the slot is the default for that branch.
    expect(selectVisitType(tenant, { isFollowUp: true }).key).toBe('telehealth-revisit');
    expect(selectVisitType(tenant, { isFollowUp: false }).key).toBe('new-patient');
  });
});

describe('promptSlotFor — the department column a visit type selects', () => {
  it('maps the two shipped keys onto the two Department prompt columns', () => {
    expect(promptSlotFor(CONSULTATION_VISIT_TYPES_DEFAULT, 'revisit')).toBe('revisit');
    expect(promptSlotFor(CONSULTATION_VISIT_TYPES_DEFAULT, 'new-patient')).toBe('new-patient');
  });

  it('maps a tenant-defined type onto the slot IT declares', () => {
    const tenant: VisitTypeDefinition[] = [
      ...CONSULTATION_VISIT_TYPES_DEFAULT,
      { key: 'telehealth-revisit', label: 'Telehealth revisit', aliases: [], promptSlot: 'revisit' },
    ];
    expect(promptSlotFor(tenant, 'telehealth-revisit')).toBe('revisit');
  });

  it('leaves a PHASE selector alone — `pre-summary` and `live` are not visit types', () => {
    expect(promptSlotFor(CONSULTATION_VISIT_TYPES_DEFAULT, 'pre-summary')).toBe('new-patient');
    expect(promptSlotFor(CONSULTATION_VISIT_TYPES_DEFAULT, 'live')).toBe('new-patient');
    expect(promptSlotFor(CONSULTATION_VISIT_TYPES_DEFAULT, undefined)).toBe('new-patient');
  });
});

describe('visitTypeCatalogueProblem — what a tenant may NOT save', () => {
  const ok: VisitTypeDefinition = { key: 'x', label: 'X', aliases: [], promptSlot: 'new-patient' };

  it('refuses an empty catalogue — a tenant with no visit types has no prompt selection', () => {
    expect(visitTypeCatalogueProblem([])).toMatch(/at least one/i);
  });

  it('refuses anything that is not an array of well-formed entries', () => {
    expect(visitTypeCatalogueProblem({})).toMatch(/array/i);
    expect(visitTypeCatalogueProblem([{ key: '', label: 'X', aliases: [], promptSlot: 'new-patient' }])).toMatch(/key/i);
    expect(visitTypeCatalogueProblem([{ key: 'x', label: '', aliases: [], promptSlot: 'new-patient' }])).toMatch(/label/i);
    expect(visitTypeCatalogueProblem([{ key: 'x', label: 'X', aliases: [], promptSlot: 'nope' }])).toMatch(/promptSlot/i);
  });

  it('ACCEPTS an alias that merely repeats its own entry’s key — redundant is not ambiguous', () => {
    expect(
      visitTypeCatalogueProblem([
        { key: 'new-visit', label: 'New patient', aliases: ['new_visit'], promptSlot: 'new-patient' },
        { key: 'revisit', label: 'Revisit', aliases: [], promptSlot: 'revisit' },
      ]),
    ).toBeUndefined();
  });

  it('refuses a duplicate key, and an alias that collides with another entry', () => {
    expect(visitTypeCatalogueProblem([ok, { ...ok, label: 'X2' }])).toMatch(/more than once|duplicate/i);
    expect(visitTypeCatalogueProblem([ok, { key: 'y', label: 'Y', aliases: ['X'], promptSlot: 'revisit' }])).toMatch(/ambiguous|collide/i);
  });

  it('refuses a catalogue with no entry for a prompt slot — a follow-up would silently get the new-patient prompt', () => {
    expect(visitTypeCatalogueProblem([ok])).toMatch(/revisit/);
  });
});
