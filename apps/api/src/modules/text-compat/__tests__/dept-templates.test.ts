import { describe, expect, it } from 'vitest';
import { DEPT_VISIT_SCHEMAS, humanizeField, normalizeVisitType, resolveDepartmentKey, selectDeptTemplate } from '../dept-templates';

describe('normalizeVisitType (v1 prompt_selector.py:47-66)', () => {
  it('maps new/referral/initial/consult synonyms → new_referral', () => {
    for (const vt of ['New', 'New Referral', 'Initial', 'first visit', 'consultation', 'referal', 'refferal']) {
      expect(normalizeVisitType(vt)).toBe('new_referral');
    }
  });

  it('maps follow-up/review/revisit synonyms → followup', () => {
    for (const vt of ['Follow-up', 'followup', 'follow up', 'FU', 'Review', 'revisit', 'RV']) {
      expect(normalizeVisitType(vt)).toBe('followup');
    }
  });

  it('defaults empty / unknown to new_referral', () => {
    expect(normalizeVisitType('')).toBe('new_referral');
    expect(normalizeVisitType(undefined)).toBe('new_referral');
    expect(normalizeVisitType('xyzzy')).toBe('new_referral');
  });
});

describe('resolveDepartmentKey (v1 get_department_schema + select_prompt_template synonyms)', () => {
  it('maps General / Medicine synonyms → medicine', () => {
    for (const d of ['General', 'general medicine', 'Internal Medicine', 'Medicine']) {
      expect(resolveDepartmentKey(d)).toBe('medicine');
    }
  });

  it('maps department spelling variants to the canonical key', () => {
    expect(resolveDepartmentKey('Surgery')).toBe('surgery');
    expect(resolveDepartmentKey('orthopaedics')).toBe('orthopedics');
    expect(resolveDepartmentKey('ortho')).toBe('orthopedics');
    expect(resolveDepartmentKey('Haematology')).toBe('hematology');
    expect(resolveDepartmentKey('neuro')).toBe('neurology');
    expect(resolveDepartmentKey('Breast & Endocrine')).toBe('breast_endocrine');
    expect(resolveDepartmentKey('rheum')).toBe('rheumatology');
  });

  it('returns null for departments with no v1 template', () => {
    expect(resolveDepartmentKey('Cardiology')).toBeNull();
    expect(resolveDepartmentKey('')).toBeNull();
    expect(resolveDepartmentKey(undefined)).toBeNull();
  });

  // Verified against the live v1 pod (Rancher c-9lwv8/apps
  // apps-text-84c9774997-zhp2l): "rheum"/"neuro"/"heme" only exist in
  // prompts_json.py's get_department_schema table, NOT in prompt_selector.py's
  // select_prompt_template table. v2 unions both, so all three still resolve.
  it('resolves synonyms that exist in only one of v1s two (non-identical) alias tables', () => {
    expect(resolveDepartmentKey('rheum')).toBe('rheumatology');
    expect(resolveDepartmentKey('neuro')).toBe('neurology');
    expect(resolveDepartmentKey('heme')).toBe('hematology');
    // "breast&endocrine" (no spaces) is prompts_json.py-only; "breast"/"endocrine"/
    // "breast endocrine"/"breast/endocrine" are prompt_selector.py-only.
    expect(resolveDepartmentKey('breast&endocrine')).toBe('breast_endocrine');
    expect(resolveDepartmentKey('breast')).toBe('breast_endocrine');
    expect(resolveDepartmentKey('endocrine')).toBe('breast_endocrine');
  });

  // CRITICAL ASYMMETRY (D-06): verified the pod does NOT alias bare "general"
  // to medicine in either table (only "general medicine"/"internal medicine"
  // do) — an unqualified "general" falls through to None/CATCHALL there, same
  // as a missing department. v2 deliberately preserves treating "General" as
  // Medicine anyway (a v2 design choice, not a v1 port) — this test locks that
  // choice in so it isn't "corrected" into matching v1 byte-for-byte by accident.
  it('resolves the literal string "General" to medicine (v2 design choice, not a v1 alias)', () => {
    expect(resolveDepartmentKey('General')).toBe('medicine');
  });

  it('returns null (not medicine) for a missing/empty department — the asymmetry', () => {
    expect(resolveDepartmentKey(undefined)).toBeNull();
    expect(resolveDepartmentKey(null)).toBeNull();
    expect(resolveDepartmentKey('')).toBeNull();
    expect(resolveDepartmentKey('   ')).toBeNull();
  });
});

describe('selectDeptTemplate', () => {
  it('returns the dept×visit field set for the 6 non-medicine departments', () => {
    const t = selectDeptTemplate('Surgery', 'New Referral');
    expect(t).not.toBeNull();
    expect(t!.deptKey).toBe('surgery');
    expect(t!.visitType).toBe('new_referral');
    expect(t!.fields).toContain('presenting_complaints');
    expect(t!.fields).toContain('fitness_for_surgery');
    // Field order preserved from the v1 schema.
    expect(t!.fields[0]).toBe('biodata');
  });

  it('normalizes the visit type before selecting (Review → followup)', () => {
    const t = selectDeptTemplate('Orthopedics', 'Review');
    expect(t).not.toBeNull();
    expect(t!.visitType).toBe('followup');
    expect(t!.fields).toContain('next_review_date');
  });

  it('returns null for General/Medicine (v1 special-case → generic conversational path)', () => {
    expect(selectDeptTemplate('General', 'New')).toBeNull();
    expect(selectDeptTemplate('Medicine', 'Follow-up')).toBeNull();
  });

  it('returns null for an unknown department', () => {
    expect(selectDeptTemplate('Cardiology', 'New')).toBeNull();
  });
});

describe('DEPT_VISIT_SCHEMAS coverage', () => {
  it('carries all 7 departments × 2 visit types (14 entries)', () => {
    expect(Object.keys(DEPT_VISIT_SCHEMAS)).toHaveLength(14);
  });
});

describe('humanizeField', () => {
  it('title-cases snake_case field names', () => {
    expect(humanizeField('presenting_complaints')).toBe('Presenting Complaints');
    expect(humanizeField('fitness_for_surgery')).toBe('Fitness For Surgery');
  });
});
