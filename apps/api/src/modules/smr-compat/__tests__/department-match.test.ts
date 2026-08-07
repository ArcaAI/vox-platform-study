import { describe, expect, it } from 'vitest';
import { matchTenantDepartment, type DepartmentLike } from '../department-match';

const depts: DepartmentLike[] = [
  { id: 'dep-card', code: 'CARD', name: 'Cardiology' },
  { id: 'dep-med', code: 'GMED', name: 'General Medicine' },
  { id: 'dep-ortho', code: 'ORTHO', name: 'Orthopedics' },
  { id: 'dep-null', code: null, name: null },
];

describe('matchTenantDepartment (TASK-592)', () => {
  it('matches by exact code, case-insensitively', () => {
    expect(matchTenantDepartment(depts, 'card')?.id).toBe('dep-card');
    expect(matchTenantDepartment(depts, 'CARD')?.id).toBe('dep-card');
  });

  it('matches by exact name, case-insensitively', () => {
    expect(matchTenantDepartment(depts, 'cardiology')?.id).toBe('dep-card');
    expect(matchTenantDepartment(depts, 'General Medicine')?.id).toBe('dep-med');
  });

  it('matches via v1 department synonyms (canonical key)', () => {
    // "Medicine" → canonical `medicine` → row named "General Medicine".
    expect(matchTenantDepartment(depts, 'Medicine')?.id).toBe('dep-med');
    // "Ortho" → canonical `orthopedics` → row named "Orthopedics".
    expect(matchTenantDepartment(depts, 'Ortho')?.id).toBe('dep-ortho');
  });

  it('returns null when nothing matches (caller falls back to the static table)', () => {
    expect(matchTenantDepartment(depts, 'Dermatology')).toBeNull();
  });

  it('returns null for an empty/blank needle', () => {
    expect(matchTenantDepartment(depts, '')).toBeNull();
    expect(matchTenantDepartment(depts, '   ')).toBeNull();
    expect(matchTenantDepartment(depts, undefined)).toBeNull();
  });

  it('does not throw on rows with null code/name', () => {
    expect(matchTenantDepartment(depts, 'Cardiology')?.id).toBe('dep-card');
  });
});

describe('matchTenantDepartment — v1 alias table coverage (TASK-634 D-06, verified against the live v1 pod)', () => {
  const canonical: DepartmentLike[] = [
    { id: 'dep-medicine', code: null, name: 'General Medicine' },
    { id: 'dep-surgery', code: null, name: 'Surgery' },
    { id: 'dep-rheum', code: null, name: 'Rheumatology' },
    { id: 'dep-neuro', code: null, name: 'Neurology' },
    { id: 'dep-ortho', code: null, name: 'Orthopedics' },
    { id: 'dep-heme', code: null, name: 'Hematology' },
    { id: 'dep-breast', code: null, name: 'Breast & Endocrine' },
  ];

  it.each([
    // medicine — union of prompt_selector.py + prompts_json.py aliases
    ['general medicine', 'dep-medicine'],
    ['internal medicine', 'dep-medicine'],
    ['Medicine', 'dep-medicine'],
    // surgery — identical in both v1 tables
    ['surgery', 'dep-surgery'],
    ['general surgery', 'dep-surgery'],
    // rheumatology — "rheum" only exists in prompts_json.py's table, not prompt_selector.py's
    ['rheumatology', 'dep-rheum'],
    ['rheum', 'dep-rheum'],
    // neurology — "neuro" only exists in prompts_json.py's table, not prompt_selector.py's
    ['neurology', 'dep-neuro'],
    ['neuro', 'dep-neuro'],
    // orthopedics — identical in both v1 tables
    ['orthopedics', 'dep-ortho'],
    ['orthopaedics', 'dep-ortho'],
    ['ortho', 'dep-ortho'],
    // hematology — "heme" only exists in prompts_json.py's table, not prompt_selector.py's
    ['hematology', 'dep-heme'],
    ['haematology', 'dep-heme'],
    ['heme', 'dep-heme'],
    // breast & endocrine — union of both tables' variant spellings
    ['breast & endocrine', 'dep-breast'],
    ['breast and endocrine', 'dep-breast'],
    ['breast&endocrine', 'dep-breast'],
    ['breast endocrine', 'dep-breast'],
    ['breast/endocrine', 'dep-breast'],
    ['breast', 'dep-breast'],
    ['endocrine', 'dep-breast'],
  ])('resolves %s -> %s', (needle, expectedId) => {
    expect(matchTenantDepartment(canonical, needle)?.id).toBe(expectedId);
  });

  // CRITICAL ASYMMETRY (D-06): a missing/empty department is NOT the same as
  // the literal string "General" — the former must fall through to the
  // generic (static dept x visit) path with no department match at all; the
  // latter resolves to the tenant's Medicine department via the synonym
  // table. Getting this backwards silently routes every undepartmented
  // request into General Medicine's governed templates.
  it('falls through to null for a missing/empty department (generic path)', () => {
    expect(matchTenantDepartment(canonical, undefined)).toBeNull();
    expect(matchTenantDepartment(canonical, null)).toBeNull();
    expect(matchTenantDepartment(canonical, '')).toBeNull();
    expect(matchTenantDepartment(canonical, '   ')).toBeNull();
  });

  it('resolves the literal string "General" to the Medicine department', () => {
    expect(matchTenantDepartment(canonical, 'General')?.id).toBe('dep-medicine');
  });

  it('never confuses the missing-department and literal-"General" outcomes', () => {
    const missing = matchTenantDepartment(canonical, undefined);
    const general = matchTenantDepartment(canonical, 'General');
    expect(missing).toBeNull();
    expect(general).not.toBeNull();
    expect(general?.id).toBe('dep-medicine');
  });
});

describe('matchTenantDepartment — deterministic selection on duplicate department names (TASK-634 D-05)', () => {
  // ArcaAI carries two rows named "General Medicine": one with all prompt
  // columns + a default agent, one with none. `DepartmentRepository.findAllByTenant`
  // now sorts `name asc, id asc`, so the array this function receives is in a
  // stable order — "first hit wins" therefore deterministically means
  // "lowest id wins" rather than whatever order Postgres happened to return.
  const withDuplicateGeneralMedicine: DepartmentLike[] = [
    { id: '019fb12d-dbe7-728d-951a-80f2646f9c92', code: null, name: 'General Medicine' },
    { id: '70000000-0000-0000-0001-000000000001', code: null, name: 'General Medicine' },
  ];

  it('picks the first row in array order regardless of which duplicate carries the templates', () => {
    // Sorted ascending, '019fb12d...' < '70000000...' lexicographically, so it comes first.
    expect(matchTenantDepartment(withDuplicateGeneralMedicine, 'General Medicine')?.id).toBe('019fb12d-dbe7-728d-951a-80f2646f9c92');
  });

  it('is deterministic across repeated calls given a stable input order', () => {
    const results = Array.from({ length: 5 }, () => matchTenantDepartment(withDuplicateGeneralMedicine, 'General')?.id);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('019fb12d-dbe7-728d-951a-80f2646f9c92');
  });
});
