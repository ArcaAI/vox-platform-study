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
