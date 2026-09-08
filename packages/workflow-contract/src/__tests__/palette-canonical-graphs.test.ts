/**
 * The gate the golden suite structurally cannot be: **a whole graph, through the real
 * `validate()`, against the real registry, with the default (merged) rule set.**
 *
 * `golden.test.ts` evaluates ONE rule against a fixture built for that rule, with a stubbed
 * class lookup. That is the right shape for proving an evaluator correct, and it is why every
 * unit test in this package stayed green through a period when NO graph in ANY palette could
 * validate at all: `WF-S-002/003/004/007` are palette-agnostic and were written against literal
 * node types that no palette registered, so the platform's own seeded graph scored 17 errors
 * against its own validator. A rule can only be satisfied in company with the others, and
 * nothing was checking that.
 *
 * TASK-893 Phase 4 left ONE palette, so this file now covers `core` alone. The two retired
 * cases it used to carry (the `summarization` and `consultation` canonical subgraphs) went with
 * their node types; the `stt` case, which asserted a retired palette was refused by `compile()`,
 * survives in the sharper form the deletion makes available — a graph naming a type that no
 * longer exists is refused, rather than one whose descriptor was merely `implemented: false`.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import { nodeInfo, registryChecksum, workflowNodeClassLookup } from '../node-registry';
import { validate } from '../validate';
import type { WorkflowGraph, WorkflowGraphNode } from '../graph-model';

/** Config every node needs to satisfy the invariant rules WF-I-004 (`emitsTrajectory` must be
 *  STATED true, not merely absent) and WF-I-010 (bounded retry). */
const BASE_CONFIG = { emitsTrajectory: true, retry: { maximumAttempts: 3 } } as const;

/** A linear graph over `types`, bookended by the caller. */
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

/**
 * The canonical `core` graph: the one Trigger, a unit of work, a mandatory ACTION and the
 * Output. The consent gate is expressed the way every clinical step is expressed after Phase 4 —
 * as `core.action` carrying an `actionKey`, whose `mandatory` class `classesOf()` resolves per
 * instance, so `WF-S-007` still sees a gate to guard.
 */
const CORE = chain(['core.trigger', 'core.action', 'core.agent', 'core.output'], {
  'core.action': { actionKey: 'consultation.consentGate', action: {} },
  'core.agent': { agentRef: { slug: 'demo-agent' }, onError: 'fail' },
});

describe("the core palette's canonical graph validates against the full rule set", () => {
  it('core: no ERROR findings', () => {
    const errors = report(CORE, 'core').findings.filter((finding) => finding.severity === 'ERROR');
    expect(errors.map((finding) => `${finding.ruleId}: ${finding.message}`)).toEqual([]);
  });

  it('core: report is ok (publishable)', () => {
    expect(report(CORE, 'core').ok).toBe(true);
  });
});

/**
 * A graph naming a node type the registry no longer carries must be REFUSED, not silently
 * skipped. Before Phase 4 the retired `stt.*` descriptors were kept with `implemented: false`
 * so `nodeInfo()` would hide them from the compiler; now they are simply absent, and the
 * compiler's "not a registered node type" finding is what fires. The refusal is asserted here
 * for the same reason buildability is: so it stays observable.
 */
describe('a graph naming a retired node type is refused by compile()', () => {
  const RETIRED = chain(['core.trigger', 'stt.audioInput', 'stt.asrEngine', 'core.output']);
  const ctx: CompilerContext = {
    definitionId: '018f1e0a-0000-7000-8000-000000000867',
    slug: 'retired-stt',
    versionNumber: 1,
    tenantId: '00000000-0000-0000-0000-000000000000',
    paletteKey: 'core',
    compilerVersion: '0.1.0',
    registryChecksum: registryChecksum(),
    ruleSetVersion: 1,
    caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
    policyBindings: {
      guardrailProfile: 'STANDARD',
      redactionRuleSetId: null,
      promptTemplateRefs: [],
      documentTemplateRefs: [],
      contextSchemaVersionId: null,
      entitlementKeys: [],
    },
    compiledAt: '2026-09-04T00:00:00.000Z',
    nodeInfo,
  };

  it('every retired node is a WF-C-002 finding; the bookends still resolve', () => {
    const result = compile(RETIRED, ctx);
    expect('findings' in result).toBe(true);
    const findings = 'findings' in result ? result.findings : [];
    expect(findings.map((finding) => finding.ruleId)).toEqual(['WF-C-002', 'WF-C-002']);
    expect(findings.map((finding) => finding.nodeId).sort()).toEqual(
      RETIRED.nodes
        .filter((node) => node.type.startsWith('stt.'))
        .map((node) => node.id)
        .sort(),
    );
    expect(nodeInfo('core.trigger')).toBeDefined();
    expect(nodeInfo('core.output')).toBeDefined();
    expect(nodeInfo('stt.asrEngine')).toBeUndefined();
  });
});

describe('the bookend rules are live, not vacuous', () => {
  const withNode = (graph: WorkflowGraph, node: WorkflowGraphNode, from: string, to: string): WorkflowGraph => ({
    ...graph,
    nodes: [...graph.nodes, node],
    edges: [...graph.edges, { id: 'extra', from, fromPort: 'out', to, toPort: 'in' }],
  });

  it('a graph with no core.trigger trips WF-S-002', () => {
    const triggerId = CORE.nodes.find((node) => node.type === 'core.trigger')!.id;
    const headless: WorkflowGraph = {
      ...CORE,
      nodes: CORE.nodes.filter((node) => node.id !== triggerId),
      edges: CORE.edges.filter((edge) => edge.from !== triggerId),
    };
    expect(report(headless, 'core').findings.map((finding) => finding.ruleId)).toContain('WF-S-002');
  });

  it('an unreachable node still trips WF-S-003, and a dead end still trips WF-S-004', () => {
    const orphaned = { ...CORE, nodes: [...CORE.nodes, { id: 'orphan', type: 'core.data', config: { ...BASE_CONFIG } }] };
    const ruleIds = report(orphaned, 'core').findings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain('WF-S-003');
    expect(ruleIds).toContain('WF-S-004');
  });

  it('a mandatory action hung off the main path is still a dead end (WF-S-004)', () => {
    const sneaked = withNode(
      CORE,
      { id: 'sneak', type: 'core.action', config: { ...BASE_CONFIG, actionKey: 'consultation.phiHop', action: {} } },
      CORE.nodes.find((node) => node.type === 'core.trigger')!.id,
      'sneak',
    );
    expect(report(sneaked, 'core').findings.map((finding) => finding.ruleId)).toContain('WF-S-004');
  });

  /**
   * WF-S-007 ("nothing routes around a gate") is VACUOUS for the `core` palette, and this test
   * pins that rather than hiding it — the whole point of this file is that a rule which cannot
   * fire is discovered here and not at the next attempt to rely on it.
   *
   * The mechanism: `allPathsPassThrough` is implemented as "no path from `from` to `to` survives
   * when every THROUGH node is removed" (`graph-algorithms.ts`). `core.trigger` and `core.output`
   * carry `mandatory` themselves and are also the rule's `entry` / `terminal` endpoints, so
   * deleting the through-set deletes the endpoints and no path can exist by construction. Before
   * TASK-893 the bookends were `core.start` / `core.end`, which carried `boundary` but NOT
   * `mandatory`, so a bypass edge was detectable; the `core` vocabulary merged those roles.
   *
   * This is NOT something this ticket changed — `core.trigger`/`core.output` have carried
   * `mandatory` since TASK-864 — but retiring every other palette makes it the ONLY case, so it
   * stops being a corner and becomes the rule's whole behaviour. Reported as a follow-up; the
   * fix is a decision about class membership or predicate semantics, not a test edit.
   */
  it('WF-S-007 cannot fire while the graph boundaries are themselves mandatory (known gap)', () => {
    const triggerId = CORE.nodes.find((node) => node.type === 'core.trigger')!.id;
    const outputId = CORE.nodes.find((node) => node.type === 'core.output')!.id;
    const bypassed: WorkflowGraph = {
      ...CORE,
      edges: [...CORE.edges, { id: 'bypass', from: triggerId, fromPort: 'out', to: outputId, toPort: 'in' }],
    };
    // The consent gate IS resolved as mandatory per instance — the class reaches the engine.
    expect(workflowNodeClassLookup.classesOf('core.action', { actionKey: 'consultation.consentGate' })).toContain('mandatory');
    // ...and the bypass is still not reported, for the structural reason above.
    expect(report(bypassed, 'core').findings.map((finding) => finding.ruleId)).not.toContain('WF-S-007');
  });
});
