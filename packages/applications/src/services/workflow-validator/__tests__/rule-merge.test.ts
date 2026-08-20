/**
 * The one-way-strictness merge (TASK-716 §3.3 / Task 9).
 *
 * SYSTEM-tenant rows are the platform invariant register. A tenant row may ADD a
 * rule of its own, and may RAISE the severity of a SYSTEM rule with the same
 * `ruleId` (WARNING -> ERROR), but it may NEVER lower one (ERROR -> WARNING) and
 * it may never remove one. This is the executable half of the ownership rule
 * stated in `workflow-invariant-rule.prisma`'s header; the service's write path
 * enforces the same property at authoring time, and this merge enforces it at
 * READ time so a row that slipped past (or predates) the write gate still cannot
 * weaken the platform's own safety rules.
 *
 * Modelled as a named cross-field check with its own test, per
 * `actionOverlapProblems` (`departmentAgent/constants.ts`).
 */
import { describe, expect, it } from 'vitest';
import { mergeRuleSets, type ResolvedRule } from '../rule-merge';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
const TENANT = '50000000-0000-0000-0000-000000000001';

function rule(overrides: Partial<ResolvedRule> = {}): ResolvedRule {
  return {
    ruleId: 'WF-S-001',
    ruleClass: 'structural',
    predicateType: 'ACYCLIC',
    predicateConfig: {},
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'The graph is a DAG.',
    tenantId: SYSTEM_TENANT,
    ruleVersion: 1,
    ...overrides,
  };
}

describe('mergeRuleSets', () => {
  it('returns the SYSTEM register when the tenant has no rules of its own', () => {
    const merged = mergeRuleSets([rule()], []);
    expect(merged.map((r) => r.ruleId)).toEqual(['WF-S-001']);
    expect(merged[0].severity).toBe('ERROR');
  });

  it('adds a tenant-authored rule alongside the SYSTEM register', () => {
    const merged = mergeRuleSets([rule()], [rule({ ruleId: 'WF-T-900', tenantId: TENANT })]);
    expect(merged.map((r) => r.ruleId).sort()).toEqual(['WF-S-001', 'WF-T-900']);
  });

  it('lets a tenant RAISE a SYSTEM rule from WARNING to ERROR', () => {
    const merged = mergeRuleSets(
      [rule({ ruleId: 'WF-I-006', severity: 'WARNING' })],
      [rule({ ruleId: 'WF-I-006', severity: 'ERROR', tenantId: TENANT })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe('ERROR');
  });

  it('REFUSES to let a tenant lower a SYSTEM ERROR to WARNING — the SYSTEM severity stands', () => {
    const merged = mergeRuleSets(
      [rule({ ruleId: 'WF-I-006', severity: 'ERROR' })],
      [rule({ ruleId: 'WF-I-006', severity: 'WARNING', tenantId: TENANT })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe('ERROR');
  });

  it('keeps the SYSTEM predicateConfig when a tenant row shadows a SYSTEM ruleId', () => {
    // A tenant may tighten SEVERITY; it may not silently redefine what the
    // platform rule CHECKS. Letting predicateConfig through would make
    // "a tenant may only be stricter" unenforceable — an emptied config is a
    // disabled rule wearing an ERROR badge.
    const merged = mergeRuleSets(
      [rule({ ruleId: 'WF-S-005', predicateType: 'REQUIRED_NODE_TYPE', predicateConfig: { nodeType: 'summarization.guardrail' } })],
      [rule({ ruleId: 'WF-S-005', predicateType: 'REQUIRED_NODE_TYPE', predicateConfig: {}, tenantId: TENANT })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].predicateConfig).toEqual({ nodeType: 'summarization.guardrail' });
  });

  it('is deterministic — merged output is ordered by ruleId', () => {
    const merged = mergeRuleSets(
      [rule({ ruleId: 'WF-S-003' }), rule({ ruleId: 'WF-S-001' })],
      [rule({ ruleId: 'WF-T-900', tenantId: TENANT }), rule({ ruleId: 'WF-S-002', tenantId: TENANT })],
    );
    expect(merged.map((r) => r.ruleId)).toEqual(['WF-S-001', 'WF-S-002', 'WF-S-003', 'WF-T-900']);
  });
});
