import { describe, expect, it } from 'vitest';
import type { Policy, Role } from '@arcaai/vox';
import {
  buildRoleTree,
  cellState,
  childRoles,
  collectPolicyRefs,
  effectiveAbilities,
  flattenRoleTree,
  normalizeRules,
  parentRole,
  ruleSubjects,
  ruleSummary,
} from '../abilities';
import type { RolePolicyRef } from '../types';

const role = (
  id: string,
  name: string,
  parentRoleId: string | null = null,
  policies: RolePolicyRef[] = [],
  extra: Record<string, unknown> = {},
): Role => ({ id, name, parentRoleId, policies, ...extra }) as unknown as Role;

const policy = (id: string, name: string, rules: unknown[]): Policy => ({ id, name, rules }) as Policy;

describe('normalizeRules (TASK-395 P1-3)', () => {
  it('normalizes string + array action/subject and detects conditions', () => {
    const rules = normalizeRules([
      { action: 'read', subject: 'Consultation' },
      { action: ['create', 'update'], subject: ['Media', 'ContextItem'], conditions: { tenantId: '${user.tenantId}' } },
      { action: 'delete', subject: 'User', inverted: true },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({ actions: ['read'], subjects: ['Consultation'], hasConditions: false, inverted: false });
    expect(rules[1]).toMatchObject({ actions: ['create', 'update'], subjects: ['Media', 'ContextItem'], hasConditions: true });
    expect(rules[2].inverted).toBe(true);
  });

  it('ignores malformed rules and non-array input', () => {
    expect(normalizeRules(null)).toEqual([]);
    expect(normalizeRules('nope')).toEqual([]);
    expect(normalizeRules([null, 42, {}, { action: 'read' }, { subject: 'User' }])).toEqual([]);
  });

  it('treats an empty conditions object as no conditions', () => {
    expect(normalizeRules([{ action: 'read', subject: 'User', conditions: {} }])[0].hasConditions).toBe(false);
  });
});

describe('cellState (TASK-395 P1-3)', () => {
  const rules = normalizeRules([
    { action: 'read', subject: 'Consultation' },
    { action: 'update', subject: 'Consultation', conditions: { doctorId: '${user.id}' } },
    { action: 'delete', subject: 'Consultation', inverted: true },
    { action: 'manage', subject: 'Media' },
  ]);

  it('marks a plain allow', () => {
    expect(cellState(rules, 'Consultation', 'read')).toBe('allow');
  });
  it('marks a conditional allow', () => {
    expect(cellState(rules, 'Consultation', 'update')).toBe('conditional');
  });
  it('lets a deny (inverted) win', () => {
    expect(cellState(rules, 'Consultation', 'delete')).toBe('deny');
  });
  it('expands manage to every action on the subject', () => {
    expect(cellState(rules, 'Media', 'create')).toBe('allow');
    expect(cellState(rules, 'Media', 'export')).toBe('allow');
  });
  it('returns none for an ungranted pair', () => {
    expect(cellState(rules, 'Consultation', 'export')).toBe('none');
  });
  it('honors the `all` wildcard subject', () => {
    const wild = normalizeRules([{ action: 'read', subject: 'all' }]);
    expect(cellState(wild, 'Whatever', 'read')).toBe('allow');
  });
});

describe('ruleSubjects / ruleSummary (TASK-395 P1-3)', () => {
  it('returns distinct subjects with `all` first', () => {
    const rules = normalizeRules([
      { action: 'read', subject: 'User' },
      { action: 'read', subject: 'all' },
      { action: 'read', subject: 'Consultation' },
    ]);
    expect(ruleSubjects(rules)).toEqual(['all', 'Consultation', 'User']);
  });

  it('summarizes allow/deny/conditional counts', () => {
    const rules = normalizeRules([
      { action: 'read', subject: 'User' },
      { action: 'update', subject: 'User', conditions: { id: '${user.id}' } },
      { action: 'delete', subject: 'User', inverted: true },
    ]);
    expect(ruleSummary(rules)).toEqual({ total: 3, allow: 2, deny: 1, conditional: 1 });
  });
});

describe('buildRoleTree / flattenRoleTree (TASK-395 P1-3)', () => {
  const roles = [
    role('doctor', 'DOCTOR'),
    role('dept', 'DEPARTMENT_HEAD', 'doctor'),
    role('nurse', 'NURSE'),
    role('senior', 'SENIOR_NURSE', 'nurse'),
  ];

  it('nests children under parents with increasing depth', () => {
    const rows = flattenRoleTree(buildRoleTree(roles));
    // roots sort alphabetically by name: DOCTOR before NURSE.
    expect(rows.map((r) => `${r.role.name}@${r.depth}`)).toEqual(['DOCTOR@0', 'DEPARTMENT_HEAD@1', 'NURSE@0', 'SENIOR_NURSE@1']);
  });

  it('treats a role whose parent is absent as a root', () => {
    const rows = flattenRoleTree(buildRoleTree([role('x', 'X', 'ghost')]));
    expect(rows).toEqual([{ role: expect.objectContaining({ id: 'x' }), depth: 0 }]);
  });

  it('resolves parent + children helpers', () => {
    expect(parentRole(roles[1], roles)?.id).toBe('doctor');
    expect(parentRole(roles[0], roles)).toBeNull();
    expect(childRoles(roles[0], roles).map((r) => r.id)).toEqual(['dept']);
  });
});

describe('collectPolicyRefs (TASK-395 P1-3)', () => {
  it('unions own + ancestor policies, deduped, own first', () => {
    const roles = [
      role('doctor', 'DOCTOR', null, [{ id: 'p-consult', name: 'consultation-own' }]),
      role('dept', 'DEPARTMENT_HEAD', 'doctor', [
        { id: 'p-dept', name: 'department-manage' },
        { id: 'p-consult', name: 'consultation-own' }, // duplicate of parent → deduped
      ]),
    ];
    const refs = collectPolicyRefs(roles[1], roles);
    expect(refs.map((r) => r.id)).toEqual(['p-dept', 'p-consult']);
    expect(refs.find((r) => r.id === 'p-dept')?.inheritedFrom).toBeNull();
    // p-consult first appears on the child itself → own (not inherited).
    expect(refs.find((r) => r.id === 'p-consult')?.inheritedFrom).toBeNull();
  });

  it('labels a purely-inherited policy with the ancestor name', () => {
    const roles = [
      role('doctor', 'DOCTOR', null, [{ id: 'p-consult', name: 'consultation-own' }], { externalName: 'Doctor' }),
      role('dept', 'DEPARTMENT_HEAD', 'doctor', []),
    ];
    const refs = collectPolicyRefs(roles[1], roles);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 'p-consult', inheritedFrom: 'Doctor' });
  });
});

describe('effectiveAbilities (TASK-395 P1-3)', () => {
  const policies = [
    policy('p-consult', 'consultation-own', [
      { action: ['read', 'update'], subject: 'Consultation', conditions: { doctorId: '${user.id}' } },
      { action: 'read', subject: 'Media' },
    ]),
    policy('p-dept', 'department-manage', [
      { action: 'manage', subject: 'Department' },
      { action: 'delete', subject: 'Consultation', inverted: true },
    ]),
  ];
  const roles = [
    role('doctor', 'DOCTOR', null, [{ id: 'p-consult', name: 'consultation-own' }]),
    role('dept', 'DEPARTMENT_HEAD', 'doctor', [{ id: 'p-dept', name: 'department-manage' }]),
  ];

  it('aggregates attached + inherited policy rules per subject', () => {
    const abilities = effectiveAbilities(roles[1], roles, policies);
    const consult = abilities.find((a) => a.subject === 'Consultation');
    expect(consult).toBeTruthy();
    expect(consult?.actions).toEqual(['read', 'update']);
    expect(consult?.conditional).toBe(true);
    expect(consult?.denied).toEqual(['delete']);
    expect(consult?.sources).toContain('consultation-own');

    const dept = abilities.find((a) => a.subject === 'Department');
    expect(dept?.manage).toBe(true);

    const media = abilities.find((a) => a.subject === 'Media');
    expect(media?.actions).toEqual(['read']);
    expect(media?.conditional).toBe(false);
  });

  it('returns nothing for a role with no resolvable policies', () => {
    expect(effectiveAbilities(role('x', 'X'), [role('x', 'X')], policies)).toEqual([]);
  });
});
