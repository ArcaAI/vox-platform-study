/**
 * The gate the golden suite structurally cannot be: **a whole graph, through the real
 * `validate()`, against the real registry, with the default (merged) rule set.**
 *
 * `golden.test.ts` evaluates ONE rule against a fixture built for that rule, with a stubbed
 * class lookup. That is the right shape for proving an evaluator correct, and it is why every
 * unit test in this package stayed green through a period when NO graph in ANY palette could
 * validate at all: `WF-S-002/003/004/007` are palette-agnostic and were written against literal
 * `core.start`/`core.end` node types that no palette registered, so the platform's own seeded
 * summarization graph scored 17 errors against its own validator. A rule can only be satisfied
 * in company with the others, and nothing was checking that.
 *
 * Each case below is the canonical mandatory subgraph of one palette, per its own contract's
 * node table. If a future rule or registry change makes a palette unbuildable again, this file
 * fails on the same day rather than at the next attempt to publish.
 */
import { describe, expect, it } from 'vitest';
import { registryChecksum, workflowNodeClassLookup } from '../node-registry';
import { validate } from '../validate';
import type { WorkflowGraph, WorkflowGraphNode } from '../graph-model';

/** Config every node needs to satisfy the palette-agnostic invariant rules WF-I-004
 *  (`emitsTrajectory` must be STATED true, not merely absent) and WF-I-010 (bounded retry). */
const BASE_CONFIG = { emitsTrajectory: true, retry: { maximumAttempts: 3 } } as const;

/** The consultation palette's non-abort error policy (CR-16 / WF-CONS-019). */
const DEGRADE = 'degrade';

/** A linear graph over `types`, `core.start`-bookended by the caller. */
function chain(types: readonly string[], configs: Record<string, Record<string, unknown>> = {}): WorkflowGraph {
  const nodes: WorkflowGraphNode[] = types.map((type, index) => ({
    id: `n${index}`,
    type,
    config: { ...BASE_CONFIG, ...(configs[type] ?? {}) },
  }));
  return {
    version: 1,
    nodes,
    edges: types.slice(1).map((_, index) => ({ id: `e${index}`, from: `n${index}`, fromPort: 'out', to: `n${index + 1}`, toPort: 'in' })),
  };
}

function report(graph: WorkflowGraph, paletteKey: string) {
  return validate(graph, { paletteKey, registry: workflowNodeClassLookup }, { ruleSetVersion: 1, registryChecksum: registryChecksum() });
}

const SUMMARIZATION = chain(['core.start', 'input.context_binding', 'generate.text', 'guardrail.check', 'output.deliver', 'core.end'], {
  'generate.text': { onError: 'fail' },
});

const STT = chain(['core.start', 'stt.audioInput', 'stt.asrEngine', 'stt.transcriptOutput', 'core.end']);

const CONSULTATION = chain(
  [
    'core.start',
    'consultation.consentGate',
    'consultation.captureBinding',
    'consultation.extractEntities',
    'consultation.bindTerminology',
    'consultation.phiHop',
    'consultation.synthesize',
    'consultation.sensors',
    'consultation.persistDraft',
    'consultation.hitlGate',
    'core.end',
  ],
  {
    // CR-16 (WF-CONS-019): every ACTIVITY-classed node states a non-abort error policy — an
    // undeclared one is how a stage-wide abort gets in without anyone authoring it.
    'consultation.captureBinding': { action: 'start', onError: DEGRADE },
    // CR-12 (WF-CONS-017): the extractor reads FINALIZED transcript only.
    'consultation.extractEntities': { requiresFinalized: true, onError: DEGRADE },
    'consultation.bindTerminology': { purposeScope: 'terminology_validation', unmappedOutputKey: 'unmappedTerms', onError: DEGRADE },
    'consultation.phiHop': { mode: 'pseudonymize', onError: DEGRADE },
    'consultation.synthesize': { taskKey: 'text.finalize', producesCode: false, onError: DEGRADE },
    'consultation.sensors': { onError: DEGRADE },
    'consultation.persistDraft': { occ: true, onError: DEGRADE },
  },
);

const CASES = [
  ['summarization', SUMMARIZATION],
  ['stt', STT],
  ['consultation', CONSULTATION],
] as const;

describe("each palette's canonical graph validates against the full rule set", () => {
  for (const [paletteKey, graph] of CASES) {
    it(`${paletteKey}: no ERROR findings`, () => {
      const errors = report(graph, paletteKey).findings.filter((finding) => finding.severity === 'ERROR');
      expect(errors.map((finding) => `${finding.ruleId}: ${finding.message}`)).toEqual([]);
    });

    it(`${paletteKey}: report is ok (publishable)`, () => {
      expect(report(graph, paletteKey).ok).toBe(true);
    });
  }
});

/**
 * The boundary exemption exists so a graph can satisfy the palette-agnostic bookend rules AND
 * the palette's own entry/terminal rules at once. It must not become a way to smuggle WORK past
 * a gate — these are the cases that prove the exemption stayed narrow.
 */
describe('boundary markers are exempt from a palette entry/terminal rule; work never is', () => {
  const withNode = (graph: WorkflowGraph, node: WorkflowGraphNode, from: string, to: string): WorkflowGraph => ({
    ...graph,
    nodes: [...graph.nodes, node],
    edges: [...graph.edges, { id: 'extra', from, fromPort: 'out', to, toPort: 'in' }],
  });
  const consentGateId = CONSULTATION.nodes.find((node) => node.type === 'consultation.consentGate')!.id;
  const hitlGateId = CONSULTATION.nodes.find((node) => node.type === 'consultation.hitlGate')!.id;
  const errorRules = (graph: WorkflowGraph) =>
    [...new Set(report(graph, 'consultation').findings.filter((f) => f.severity === 'ERROR').map((f) => f.ruleId))];

  it('core.start preceding the consent gate does NOT trip WF-CONS-002', () => {
    // This is the whole point: `core.start` is by construction not reachable FROM the consent
    // gate, so without the exemption the bookend and the palette rule are mutually unsatisfiable.
    expect(errorRules(CONSULTATION)).toEqual([]);
  });

  it('a WORK node preceding the consent gate still trips WF-CONS-002', () => {
    const sneaked = withNode(
      CONSULTATION,
      { id: 'sneak', type: 'consultation.sensors', config: { ...BASE_CONFIG } },
      'sneak',
      consentGateId,
    );
    expect(errorRules(sneaked)).toContain('WF-CONS-002');
  });

  it('a WORK node after the HITL gate still trips WF-CONS-004', () => {
    const trailing = withNode(
      CONSULTATION,
      { id: 'after', type: 'consultation.persistDraft', config: { ...BASE_CONFIG, occ: true } },
      hitlGateId,
      'after',
    );
    expect(errorRules(trailing)).toContain('WF-CONS-004');
  });
});

describe('the bookend rules are live, not vacuous', () => {
  it('a graph with no core.start trips WF-S-002', () => {
    const startId = CONSULTATION.nodes.find((node) => node.type === 'core.start')!.id;
    const headless: WorkflowGraph = {
      ...CONSULTATION,
      nodes: CONSULTATION.nodes.filter((node) => node.id !== startId),
      edges: CONSULTATION.edges.filter((edge) => edge.from !== startId),
    };
    const ruleIds = report(headless, 'consultation').findings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain('WF-S-002');
  });

  it('an edge routing straight from core.start to core.end trips WF-S-007', () => {
    // WF-S-007 ("nothing routes around a gate") selects `throughClass: 'mandatory'`. It was dead
    // for a different reason before: with no core.start/core.end there were no paths to guard.
    const endId = CONSULTATION.nodes.find((node) => node.type === 'core.end')!.id;
    const startId = CONSULTATION.nodes.find((node) => node.type === 'core.start')!.id;
    const bypassed: WorkflowGraph = {
      ...CONSULTATION,
      edges: [...CONSULTATION.edges, { id: 'bypass', from: startId, fromPort: 'out', to: endId, toPort: 'in' }],
    };
    const ruleIds = report(bypassed, 'consultation').findings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain('WF-S-007');
  });
});
