/**
 * WorkflowValidatorService — the IMPURE half of validator.
 *
 * The pure engine (`@arcaai/workflow-contract`'s `validate()`) evaluates a rule
 * set against a graph. It cannot KNOW what the rule set is: that is rows in
 * `WorkflowInvariantRule`, SYSTEM register ∪ tenant additions, which is I/O.
 * This service is exactly that seam and nothing else — it deliberately does not
 * persist the report or broadcast a sys-event, because `WorkflowDefinitionService`
 * already owns the definition lifecycle and does both; a second writer
 * would double-broadcast `ResourceUpdated` on every validate.
 *
 * Properties pinned here:
 *  - rules come from the DB, merged one-way-strict (see `rule-merge.test.ts`);
 *  - `ruleSetVersion` on the report is the MAX `ruleVersion` of the merged set,
 *    which is what the re-validation sweep compares against;
 *  - an EMPTY rule table falls back to the code catalogue, so a day-one
 *    unseeded database still validates instead of silently passing everything;
 *  - a repository that throws becomes a synthetic `WF-INTERNAL` ERROR finding
 * and `ok: false` — NEVER `ok: true` ("a validator that is not total is
 *    a validator that can be bypassed").
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { WorkflowGraph } from '@arcaai/workflow-contract';
import { WorkflowValidatorService } from '../workflow-validator.service';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
const TENANT = '50000000-0000-0000-0000-000000000001';

/** A trivially valid two-node graph: the palette-agnostic bookends, one edge. */
const GRAPH: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: 'start_1', type: 'core.start', config: {} },
    { id: 'end_1', type: 'core.end', config: {} },
  ],
  edges: [{ id: 'e1', from: 'start_1', fromPort: 'out', to: 'end_1', toPort: 'in' }],
};

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'WF-S-001',
    predicateType: 'ACYCLIC',
    predicateConfig: {},
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'The graph is a DAG.',
    tenantId: SYSTEM_TENANT,
    ruleVersion: 4,
    ...overrides,
  };
}

function makeService(rows: unknown[] = [], opts: { throws?: boolean } = {}) {
  const repository = {
    findApplicable: opts.throws ? vi.fn().mockRejectedValue(new Error('db exploded')) : vi.fn().mockResolvedValue(rows),
  };
  const service = new WorkflowValidatorService(repository as never);
  return { service, repository };
}

describe('WorkflowValidatorService.validateGraph', () => {
  it('evaluates the DB-sourced rule set and stamps its max ruleVersion as ruleSetVersion', async () => {
    const { service, repository } = makeService([ruleRow({ ruleVersion: 4 }), ruleRow({ ruleId: 'WF-T-900', tenantId: TENANT, ruleVersion: 9 })]);

    const report = await service.validateGraph(TENANT, 'summarization', GRAPH);

    expect(repository.findApplicable).toHaveBeenCalledWith(TENANT, 'summarization');
    expect(report.ruleSetVersion).toBe(9);
    expect(report.reportVersion).toBe(1);
  });

  it('falls back to the code catalogue when the rule table is empty', async () => {
    const { service } = makeService([]);

    const report = await service.validateGraph(TENANT, 'summarization', GRAPH);

    // The bundled DRAFT catalogue is non-empty, so an unseeded DB still evaluates
    // real rules rather than vacuously passing. Version 0 marks "no DB rule set".
    expect(report.ruleSetVersion).toBe(0);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it("the empty-table fallback carries EVERY palette's rules, not just the palette-agnostic ones", async () => {
    const { service } = makeService([]);

    // TASK-893 retired the `consultation` palette and its `WF-CONS-*` rules with the rest of the
    // legacy vocabulary; `core` is the one palette left, and `WF-CORE-*` are its palette-scoped
    // rules. The property under test is unchanged: `validate()` skips any rule whose `paletteKey`
    // does not match, so a fallback carrying only the palette-agnostic `WF-S-*` rows would report
    // an `ok`-looking result on a graph that violates the palette's own invariants.
    const report = await service.validateGraph(TENANT, 'core', {
      version: 1,
      // No `core.trigger` and no `core.output` — both of WF-CORE-001/002 are violated.
      nodes: [{ id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } } }],
      edges: [],
    });

    const ruleIds = report.findings.map((f) => f.ruleId);
    expect(ruleIds).toContain('WF-CORE-001');
    expect(ruleIds).toContain('WF-CORE-002');
    expect(report.ok).toBe(false);
  });

  it('turns a repository failure into a WF-INTERNAL ERROR finding, never ok:true', async () => {
    const { service } = makeService([], { throws: true });

    const report = await service.validateGraph(TENANT, 'summarization', GRAPH);

    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.ruleId === 'WF-INTERNAL')).toBe(true);
  });

  it('reports a malformed graph as a shape finding rather than throwing', async () => {
    const { service } = makeService([ruleRow()]);

    const report = await service.validateGraph(TENANT, 'summarization', { version: 1, nodes: 'nope', edges: [] } as unknown as WorkflowGraph);

    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.ruleId === 'WF-SHAPE')).toBe(true);
  });

  it('drops a DB row whose predicateType is not in the code-owned catalogue, as WF-INTERNAL', async () => {
    // The Prisma enum and `WORKFLOW_RULE_PREDICATE_TYPES` must never drift, but if
    // they do, an unknown kind must surface loudly — not be skipped silently.
    const { service } = makeService([ruleRow({ ruleId: 'WF-X-001', predicateType: 'NOT_A_REAL_PREDICATE' })]);

    const report = await service.validateGraph(TENANT, 'summarization', GRAPH);

    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.ruleId === 'WF-INTERNAL')).toBe(true);
  });
});

describe('WorkflowValidatorService.resolveRuleSetVersion', () => {
  it('returns the merged max ruleVersion, for the re-validation sweep', async () => {
    const { service } = makeService([ruleRow({ ruleVersion: 2 }), ruleRow({ ruleId: 'WF-S-002', ruleVersion: 11 })]);
    await expect(service.resolveRuleSetVersion(TENANT, 'summarization')).resolves.toBe(11);
  });

  it('returns 0 when no DB rules apply', async () => {
    const { service } = makeService([]);
    await expect(service.resolveRuleSetVersion(TENANT, 'summarization')).resolves.toBe(0);
  });
});
