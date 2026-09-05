/**
 * The VISIT-TYPE vocabulary — the pure half.
 *
 * Two visit types ship: New visit (new patient, new referral) and Revisit (follow-up same-day,
 * review same-day, revisit same-day). The KEYS and LABELS were settled on 2026-08-29 — see the
 * last describe block, which owns that vocabulary and the retired-key compatibility the rename
 * depends on. TASK-882 made them the ONLY two (the tenant catalogue key and its write-lane
 * validator retired), so what is pinned here is the vocabulary and the three pure selections.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  matchVisitType,
  normalizeVisitTypeToken,
  promptSlotFor,
  selectVisitType,
  type VisitTypeDefinition,
} from '../visit-type.catalogue';

describe('the shipped default catalogue', () => {
  it('is the owner’s two visit types, in order, at the SYSTEM tier', () => {
    expect(CONSULTATION_VISIT_TYPES_DEFAULT.map((v) => v.key)).toEqual(['new-visit', 'revisit']);
    expect(CONSULTATION_VISIT_TYPES_DEFAULT.map((v) => v.label)).toEqual(['New visit', 'Revisit']);
  });

  it('carries the owner’s parenthesised terms as ALIASES, not as separate types', () => {
    const [newVisit, revisit] = CONSULTATION_VISIT_TYPES_DEFAULT;
    // "New patient (new visit, new referral)"
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new patient')).toBe(newVisit);
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'New Referral')).toBe(newVisit);
    // "Revisit (follow-up same-day, review same-day, revisit same-day)"
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'follow-up same-day')).toBe(revisit);
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'Review Same-Day')).toBe(revisit);
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'revisit same day')).toBe(revisit);
  });

  it('still matches every visit-type literal that existed in code before the catalogue', () => {
    // `text-proxy.controller.ts`'s closed `VisitType` union…
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new_visit')?.key).toBe('new-visit');
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'referral')?.key).toBe('new-visit');
    // …the `{visit_type}` prompt-variable vocabulary…
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new-visit')?.key).toBe('new-visit');
    // …and the two `promptType` keys themselves, INCLUDING the retired spelling.
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'new-patient')?.key).toBe('new-visit');
    expect(matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, 'revisit')?.key).toBe('revisit');
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
    expect(selectVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, { isFollowUp: false }).key).toBe('new-visit');
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
    expect(selectVisitType(tenant, { isFollowUp: false }).key).toBe('new-visit');
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

/**
 * SECOND OWNER DIRECTIVE ON THE VOCABULARY (2026-08-29) — closes
 *
 *   "visit-type labels must be easy for user/developer/admins to understand:
 *    * new-visit: new patient, new visit, new referral
 *    * revisit: here is follow-up or revisit in the same day"
 *
 * The identifier the owner NAMES is `new-visit`; the catalogue shipped
 * `new-patient`. `key` is PERSISTED (`GateEditExemplar.visitType`) and is what
 * an inbound caller sends, so the rename is only safe because the retired
 * spelling stays reachable as an ALIAS — the last two tests are what prove it.
 */
describe('the owner’s visit-type vocabulary (2026-08-29)', () => {
  const keyOf = (raw: string) => matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, raw)?.key ?? null;

  it('resolves every term the owner wrote, in the owner’s own casing and spacing', () => {
    // "new-visit: new patient, new visit, new referral"
    expect(keyOf('new patient')).toBe('new-visit');
    expect(keyOf('new visit')).toBe('new-visit');
    expect(keyOf('new referral')).toBe('new-visit');
    // "revisit: here is follow-up or revisit in the same day"
    expect(keyOf('follow-up')).toBe('revisit');
    expect(keyOf('revisit')).toBe('revisit');
  });

  it('still resolves the RETIRED key `new-patient`, and declares it as an alias so it cannot be tidied away', () => {
    expect(keyOf('new-patient')).toBe('new-visit');
    expect(CONSULTATION_VISIT_TYPES_DEFAULT[0]?.aliases).toContain('new-patient');
  });

  it('serves a row PERSISTED under the retired key from the renamed entry, not from the parent-link guess', () => {
    // `GateEditExemplar.visitType` rows written before the rename carry
    // 'new-patient'. Were it unresolvable, `selectVisitType` would fall through
    // to the parent link and a follow-up consultation would be re-derived as
    // 'revisit' — silently relabelling one visit type as the other.
    const persisted = selectVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, { recorded: 'new-patient', isFollowUp: true });
    expect(persisted.key).toBe('new-visit');
    // …and the compat promptType `'new-patient'` still reads the same
    // `Department` prompt column it always did.
    expect(promptSlotFor(CONSULTATION_VISIT_TYPES_DEFAULT, 'new-patient')).toBe('new-patient');
  });
});
