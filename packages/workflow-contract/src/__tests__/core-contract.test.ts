/**
 * TASK-864 — the `core` vocabulary's contract, asserted where a JSON Schema cannot reach:
 * dynamic branch handles, the action catalogue, the loop-body rules, the `any` wildcard, the
 * publish-time checks, and the compiler's branch/loop/note treatment.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import {
  ACTION_CATALOGUE,
  actionConfigSchemaOf,
  actionDelegateOf,
  branchHandlesOf,
  coreNodeConfigProblems,
  declaredIoSchemas,
  declaredOutputProtocols,
  declaredTriggerKinds,
  effectivePorts,
  isBranchHandle,
  isCoreGraph,
  loopBodyProblems,
  resolveOutputPort,
} from '../core-contract';
import type { WorkflowGraph } from '../graph-model';
import { workflowGraphProblems } from '../graph-model';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { CORE_NODE_TYPES, CORE_PALETTE_KEY, WORKFLOW_NODE_REGISTRY, isDeprecatedNodeType, nodeInfo, registryChecksum } from '../node-registry';
import { ANY_PORT_PRIMITIVE, WORKFLOW_PORT_PRIMITIVES, portKindsCompatible, portPrimitiveSatisfies } from '../port-model';
import { isValidConnection, workflowEdgePortProblems, workflowPublishProblems } from '../port-validation';
import { DRAFT_CORE_RULE_SET } from '../rule-catalogue';
import { validate } from '../validate';
import { workflowNodeClassLookup } from '../node-registry';

const CLASSIFY_CONFIG = {
  modelSlug: 'gliguard-safety',
  classes: [
    { key: 'safe', label: 'Safe' },
    { key: 'unsafe', label: 'Unsafe' },
  ],
};

function ctx(): CompilerContext {
  return {
    definitionId: '018f1e0a-0000-7000-8000-000000000001',
    slug: 'core-proof',
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
}

/** The ticket's live proof: Trigger(api) → Classify → [safe] Agent → Human review → Output. */
function proofGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'], contextSchema: { inline: { type: 'object' } } } },
      { id: 'n_classify', type: 'core.classify', config: CLASSIFY_CONFIG },
      { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'platform-summarization' } } },
      { id: 'n_review', type: 'core.humanReview', config: { timeoutSeconds: 600 } },
      { id: 'n_note', type: 'core.note', config: { text: 'unsafe → straight to output' } },
      { id: 'n_output', type: 'core.output', config: { protocols: ['http-sse'], outputSchema: { type: 'object' } } },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_classify', toPort: 'in' },
      { id: 'e2', from: 'n_classify', fromPort: 'safe', to: 'n_agent', toPort: 'after' },
      { id: 'e3', from: 'n_trigger', fromPort: 'out', to: 'n_agent', toPort: 'context' },
      { id: 'e4', from: 'n_agent', fromPort: 'out', to: 'n_review', toPort: 'in' },
      { id: 'e5', from: 'n_review', fromPort: 'approved', to: 'n_output', toPort: 'after' },
      { id: 'e6', from: 'n_review', fromPort: 'out', to: 'n_output', toPort: 'in' },
      { id: 'e7', from: 'n_classify', fromPort: 'unsafe', to: 'n_output', toPort: 'after' },
      { id: 'e8', from: 'n_classify', fromPort: 'out', to: 'n_output', toPort: 'in' },
    ],
  };
}

function loopGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
      { id: 'n_loop', type: 'core.loop', config: { mode: 'foreach', over: 'trigger.items', bounds: { maxIterations: 3, maxDurationSeconds: 60, maxTotalTokens: 1000 } } },
      { id: 'n_body_agent', type: 'core.agent', config: { agentRef: { slug: 'platform-summarization' } }, parentId: 'n_loop' },
      { id: 'n_body_data', type: 'core.data', config: { mappings: [{ from: 'in.text', to: 'summary' }] }, parentId: 'n_loop' },
      { id: 'n_output', type: 'core.output', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_loop', toPort: 'in' },
      { id: 'e2', from: 'n_loop', fromPort: 'each', to: 'n_body_agent', toPort: 'context' },
      { id: 'e3', from: 'n_body_agent', fromPort: 'data', to: 'n_body_data', toPort: 'in' },
      { id: 'e4', from: 'n_loop', fromPort: 'done', to: 'n_output', toPort: 'in' },
    ],
  };
}

describe('the `core` palette is registered (A1)', () => {
  it('registers the nine primitives plus the two platform-action node types', () => {
    expect([...CORE_NODE_TYPES].sort()).toEqual([
      'core.action',
      'core.agent',
      'core.classify',
      'core.condition',
      'core.data',
      'core.humanReview',
      'core.loop',
      'core.note',
      'core.output',
      'core.trigger',
      'core.variable',
    ]);
    for (const key of CORE_NODE_TYPES) {
      expect(WORKFLOW_NODE_REGISTRY[key].paletteKey).toBe(CORE_PALETTE_KEY);
      expect(WORKFLOW_NODE_REGISTRY[key].implemented).toBe(true);
      expect(NODE_CONFIG_SCHEMAS[key]).toBeDefined();
      expect(nodeInfo(key)).toBeDefined();
    }
  });

  it('marks every stt.* node deprecated, replaced by core.agent (TASK-861 §step 10, owned here)', () => {
    const stt = Object.values(WORKFLOW_NODE_REGISTRY).filter((d) => d.paletteKey === 'stt');
    expect(stt).toHaveLength(8);
    for (const descriptor of stt) {
      expect(descriptor.deprecated).toBe(true);
      expect(descriptor.replacedBy).toBe('core.agent');
      expect(isDeprecatedNodeType(descriptor.key)).toBe(true);
    }
    expect(isDeprecatedNodeType('core.agent')).toBe(false);
    expect(isDeprecatedNodeType('nope')).toBe(false);
  });

  it('the trigger has only a source handle and the output only target handles', () => {
    expect(WORKFLOW_NODE_REGISTRY['core.trigger'].inputs).toEqual([]);
    expect(WORKFLOW_NODE_REGISTRY['core.output'].outputs).toEqual([]);
    expect(WORKFLOW_NODE_REGISTRY['core.note'].inputs).toEqual([]);
    expect(WORKFLOW_NODE_REGISTRY['core.note'].outputs).toEqual([]);
  });

  it('humanReview is NOT gate-classed — it runs in-stage, not lifted to the end of the walk', () => {
    expect(WORKFLOW_NODE_REGISTRY['core.humanReview'].classes).not.toContain('gate');
    expect(WORKFLOW_NODE_REGISTRY['core.humanReview'].classes).toContain('review');
  });
});

describe('the `any` wildcard (consumer-side only)', () => {
  it('every data primitive satisfies an `any` consumer; control never does', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(portPrimitiveSatisfies(primitive, ANY_PORT_PRIMITIVE)).toBe(primitive !== 'control');
      expect(portKindsCompatible(primitive, ANY_PORT_PRIMITIVE)).toBe(primitive !== 'control');
    }
  });

  it('an `any` producer satisfies nothing but `any` — it can launder nothing', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(portPrimitiveSatisfies(ANY_PORT_PRIMITIVE, primitive)).toBe(primitive === ANY_PORT_PRIMITIVE);
    }
    expect(portPrimitiveSatisfies('any', 'transcript')).toBe(false);
  });

  it('lets a text-producing agent feed the review, and the review feed the output', () => {
    expect(isValidConnection('core.agent', 'out', 'core.humanReview', 'in')).toBe(true);
    expect(isValidConnection('core.humanReview', 'out', 'core.output', 'in')).toBe(true);
    expect(isValidConnection('core.classify', 'out', 'core.output', 'in')).toBe(true);
  });

  it('still refuses generated text into NER through the core vocabulary', () => {
    expect(isValidConnection('core.agent', 'out', 'core.action', 'transcript')).toBe(false);
    expect(isValidConnection('core.agent', 'transcript', 'core.action', 'transcript')).toBe(true);
  });
});

describe('dynamic branch handles', () => {
  it('classify fans out one handle per declared class plus `otherwise`', () => {
    expect(branchHandlesOf('core.classify', CLASSIFY_CONFIG)).toEqual(['safe', 'unsafe', 'otherwise']);
    expect(isBranchHandle('core.classify', CLASSIFY_CONFIG, 'safe')).toBe(true);
    expect(isBranchHandle('core.classify', CLASSIFY_CONFIG, 'out')).toBe(false);
    expect(resolveOutputPort('core.classify', CLASSIFY_CONFIG, 'unsafe')).toEqual({ name: 'unsafe', primitive: 'control', required: false, multiple: true });
    expect(resolveOutputPort('core.classify', CLASSIFY_CONFIG, 'nope')).toBeUndefined();
  });

  it('condition fans out one handle per branch plus `else`; review has its three static ones', () => {
    expect(branchHandlesOf('core.condition', { branches: [{ key: 'senior', when: 'trigger.age >= 65' }] })).toEqual(['senior', 'else']);
    expect(branchHandlesOf('core.humanReview', {})).toEqual(['approved', 'rejected', 'timedOut']);
    expect(branchHandlesOf('core.agent', {})).toEqual([]);
  });

  it('a branch handle is a CONTROL socket: it wires into `after`, never into a data input', () => {
    expect(isValidConnection('core.classify', 'safe', 'core.agent', 'after', { fromNodeConfig: CLASSIFY_CONFIG })).toBe(true);
    expect(isValidConnection('core.classify', 'safe', 'core.agent', 'in', { fromNodeConfig: CLASSIFY_CONFIG })).toBe(false);
    // Without the instance config the per-class handle is unknown — the static table has no `safe`.
    expect(isValidConnection('core.classify', 'safe', 'core.agent', 'after')).toBe(false);
  });

  it('the graph-level edge check resolves the handle from the node`s own config', () => {
    expect(workflowEdgePortProblems(proofGraph())).toEqual([]);
    const bad = proofGraph();
    bad.edges[1] = { ...bad.edges[1]!, fromPort: 'maybe' };
    expect(workflowEdgePortProblems(bad)).toHaveLength(1);
    expect(workflowEdgePortProblems(bad)[0]).toContain('"maybe"');
  });
});

describe('the action catalogue', () => {
  it('names every surviving fixed-purpose clinical step and nothing that maps onto a primitive', () => {
    const keys = Object.keys(ACTION_CATALOGUE);
    expect(keys).toContain('consultation.phiHop');
    expect(keys).toContain('guard.groundedness');
    expect(keys).toContain('prompt.template_ref');
    for (const excluded of ['consultation.synthesize', 'consultation.hitlGate', 'agentic.agent', 'agentic.input', 'output.deliver', 'input.context_binding', 'generate.text']) {
      expect(keys).not.toContain(excluded);
    }
    for (const key of keys) expect(WORKFLOW_NODE_REGISTRY[key]).toBeDefined();
  });

  it('a core.action instance takes its delegate`s ports and config schema', () => {
    const config = { actionKey: 'consultation.phiHop' };
    expect(actionDelegateOf(config)?.key).toBe('consultation.phiHop');
    expect(effectivePorts('core.action', config)).toEqual({
      inputs: WORKFLOW_NODE_REGISTRY['consultation.phiHop'].inputs,
      outputs: WORKFLOW_NODE_REGISTRY['consultation.phiHop'].outputs,
    });
    expect(actionConfigSchemaOf(config)).toBe(NODE_CONFIG_SCHEMAS['consultation.phiHop']);
    expect(actionDelegateOf({ actionKey: 'nope' })).toBeUndefined();
    expect(effectivePorts('core.action', { actionKey: 'nope' })).toEqual({ inputs: WORKFLOW_NODE_REGISTRY['core.action'].inputs, outputs: WORKFLOW_NODE_REGISTRY['core.action'].outputs });
  });
});

describe('coreNodeConfigProblems — what a JSON Schema cannot say', () => {
  it('is a no-op for a non-core node', () => {
    expect(coreNodeConfigProblems({ id: 'x', type: 'agentic.agent', config: {} })).toEqual([]);
  });

  it('refuses a router whose keys collide with a static handle or each other', () => {
    const problems = coreNodeConfigProblems({
      id: 'c',
      type: 'core.classify',
      config: { modelSlug: 'm', classes: [{ key: 'otherwise', label: 'x' }, { key: 'a', label: 'a' }, { key: 'a', label: 'b' }] },
    });
    expect(problems.some((p) => p.includes('reserved'))).toBe(true);
    expect(problems.some((p) => p.includes('declared twice'))).toBe(true);
  });

  it('parses every condition and refuses one that reads an undeclared root', () => {
    expect(coreNodeConfigProblems({ id: 'c', type: 'core.condition', config: { branches: [{ key: 'a', when: 'trigger.age > 1' }] } })).toEqual([]);
    const problems = coreNodeConfigProblems({ id: 'c', type: 'core.condition', config: { branches: [{ key: 'a', when: 'patient.age >' }, { key: 'b', when: 'patient.age > 1' }] } });
    expect(problems.some((p) => p.includes('does not parse'))).toBe(true);
    expect(problems.some((p) => p.includes('not a run-context root'))).toBe(true);
  });

  it('a loop must name its mode`s driver and all three bounds', () => {
    expect(coreNodeConfigProblems({ id: 'l', type: 'core.loop', config: { mode: 'foreach', bounds: { maxIterations: 1, maxDurationSeconds: 1 } } })).toEqual([
      'node `l`: a `foreach` loop needs `over` — the run-context path of the array to iterate.',
      'node `l`: `bounds.maxTotalTokens` is required — a loop bounded on fewer than all three axes is unbounded on the missing one.',
    ]);
    expect(coreNodeConfigProblems({ id: 'l', type: 'core.loop', config: { mode: 'while', until: 'vars.done == true', bounds: { maxIterations: 1, maxDurationSeconds: 1, maxTotalTokens: 1 } } })).toEqual([]);
  });

  it('a trigger needs a kind; an output`s protocols come from the closed list; an action key must exist', () => {
    expect(coreNodeConfigProblems({ id: 't', type: 'core.trigger', config: { kinds: [] } })).toHaveLength(1);
    expect(coreNodeConfigProblems({ id: 't', type: 'core.trigger', config: { kinds: ['carrier-pigeon'] } })).toHaveLength(1);
    expect(coreNodeConfigProblems({ id: 'o', type: 'core.output', config: { protocols: ['grpc'] } })).toHaveLength(1);
    expect(coreNodeConfigProblems({ id: 'o', type: 'core.output', config: {} })).toEqual([]);
    expect(coreNodeConfigProblems({ id: 'a', type: 'core.action', config: { actionKey: 'nope' } })).toHaveLength(1);
    expect(coreNodeConfigProblems({ id: 'a', type: 'core.agent', config: {} })).toHaveLength(1);
  });
});

describe('loop bodies (parentId sub-graphs)', () => {
  it('a well-formed body has no problems and the shape check accepts parentId', () => {
    expect(workflowGraphProblems(loopGraph())).toEqual([]);
    expect(loopBodyProblems(loopGraph())).toEqual([]);
    expect(workflowPublishProblems(loopGraph())).toEqual([]);
  });

  it('refuses a body that wires outside its loop, a parent that is not a loop, and a self-parent', () => {
    const escaping = loopGraph();
    escaping.edges.push({ id: 'e5', from: 'n_body_data', fromPort: 'out', to: 'n_output', toPort: 'in' });
    expect(loopBodyProblems(escaping).some((p) => p.includes('may not wire to'))).toBe(true);

    const wrongParent = loopGraph();
    wrongParent.nodes[2] = { ...wrongParent.nodes[2]!, parentId: 'n_trigger' };
    expect(loopBodyProblems(wrongParent).some((p) => p.includes('is a `core.trigger`'))).toBe(true);

    expect(workflowGraphProblems({ version: 1, nodes: [{ id: 'aa', type: 'core.loop', config: {}, parentId: 'aa' }], edges: [] })).toEqual([
      '/nodes/0/parentId: a node cannot be its own parent',
    ]);
    expect(workflowGraphProblems({ version: 1, nodes: [{ id: 'aa', type: 'core.loop', config: {}, parentId: 'zz' }], edges: [] })).toEqual([
      '/nodes/0/parentId: references unknown node "zz"',
    ]);
  });

  it('`each` must enter the loop`s own body', () => {
    const wrong = loopGraph();
    wrong.edges[1] = { ...wrong.edges[1]!, to: 'n_output', toPort: 'in' };
    expect(loopBodyProblems(wrong).some((p) => p.includes('.each` must enter'))).toBe(true);
  });
});

describe('compile() — branches, loops and notes (A3)', () => {
  it('compiles the proof graph: notes stripped, branch edges become guards, never inputs', () => {
    const result = compile(proofGraph(), ctx());
    expect('config' in result).toBe(true);
    const { config } = result as { config: import('../compiler').CompiledWorkflowConfig };
    const nodes = config.stages.flatMap((stage) => stage.nodes);
    expect(nodes.map((n) => n.nodeId)).not.toContain('n_note');
    expect(config.gates).toEqual([]); // the review is in-stage, not a lifted gate
    expect(config.loops).toBeUndefined();

    const agent = nodes.find((n) => n.nodeId === 'n_agent')!;
    expect(agent.branchGuards).toEqual([{ fromNodeId: 'n_classify', handle: 'safe' }]);
    expect(agent.inputs).toEqual([{ fromNodeId: 'n_trigger', fromPort: 'out', toPort: 'context' }]);

    const output = nodes.find((n) => n.nodeId === 'n_output')!;
    expect(output.branchGuards).toEqual([
      { fromNodeId: 'n_classify', handle: 'unsafe' },
      { fromNodeId: 'n_review', handle: 'approved' },
    ]);
    expect(output.inputs.map((b) => b.fromNodeId).sort()).toEqual(['n_classify', 'n_review']);
    // The review sits BETWEEN the agent and the output in the stage order.
    const stageOf = (id: string) => config.stages.findIndex((s) => s.nodes.some((n) => n.nodeId === id));
    expect(stageOf('n_agent')).toBeLessThan(stageOf('n_review'));
    expect(stageOf('n_review')).toBeLessThan(stageOf('n_output'));
    // A node with no guard carries no `branchGuards` key at all (legacy artifacts stay byte-identical).
    expect('branchGuards' in nodes.find((n) => n.nodeId === 'n_classify')!).toBe(false);
  });

  it('compiles a loop body into `loops[]` and keeps it out of the top-level stages', () => {
    const result = compile(loopGraph(), ctx());
    const { config } = result as { config: import('../compiler').CompiledWorkflowConfig };
    const topLevel = config.stages.flatMap((s) => s.nodes.map((n) => n.nodeId));
    expect(topLevel).toEqual(['n_trigger', 'n_loop', 'n_output']);
    expect(config.loops).toHaveLength(1);
    const loop = config.loops![0]!;
    expect(loop.nodeId).toBe('n_loop');
    const bodyIds = loop.body.stages.flatMap((s) => s.nodes.map((n) => n.nodeId));
    expect(bodyIds).toEqual(['n_body_agent', 'n_body_data']);
    const bodyAgent = loop.body.stages[0]!.nodes[0]!;
    expect(bodyAgent.inputs).toEqual([{ fromNodeId: 'n_loop', fromPort: 'each', toPort: 'context' }]);
    const outputNode = config.stages.flatMap((s) => s.nodes).find((n) => n.nodeId === 'n_output')!;
    expect(outputNode.inputs).toEqual([{ fromNodeId: 'n_loop', fromPort: 'done', toPort: 'in' }]);
  });

  it('is deterministic and shuffle-invariant with branches and loops present', () => {
    const a = compile(proofGraph(), ctx()) as { config: { checksum: string } };
    const shuffled = proofGraph();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    const b = compile(shuffled, ctx()) as { config: { checksum: string } };
    expect(a.config.checksum).toBe(b.config.checksum);
    const l1 = compile(loopGraph(), ctx()) as { config: { checksum: string } };
    const l2 = compile(loopGraph(), ctx()) as { config: { checksum: string } };
    expect(l1.config.checksum).toBe(l2.config.checksum);
  });
});

describe('publish + validate over a core graph', () => {
  it('the proof graph publishes clean and validates ok under the full rule set', () => {
    expect(workflowPublishProblems(proofGraph())).toEqual([]);
    const report = validate(proofGraph(), { paletteKey: 'core', registry: workflowNodeClassLookup }, { ruleSetVersion: 1, registryChecksum: registryChecksum() });
    expect(report.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('the core rule set refuses a graph with two triggers or no output', () => {
    const twoTriggers = proofGraph();
    twoTriggers.nodes.push({ id: 'n_trigger2', type: 'core.trigger', config: { kinds: ['api'] } });
    const report = validate(twoTriggers, { paletteKey: 'core', registry: workflowNodeClassLookup }, { ruleSetVersion: 1, registryChecksum: registryChecksum() });
    expect(report.findings.map((f) => f.ruleId)).toContain('WF-CORE-001');
    expect(DRAFT_CORE_RULE_SET.every((rule) => rule.paletteKey === 'core')).toBe(true);
  });

  it('the readers the exposure plane consumes', () => {
    expect(isCoreGraph(proofGraph())).toBe(true);
    expect(isCoreGraph({ nodes: [{ id: 'a', type: 'core.start', config: {} }] })).toBe(false);
    expect(declaredOutputProtocols(proofGraph())).toEqual(['http-sse']);
    expect(declaredOutputProtocols({ nodes: [{ id: 'o', type: 'core.output', config: {} }] })).toEqual(['http-sse']);
    expect(declaredOutputProtocols({ nodes: [] })).toEqual([]);
    expect(declaredTriggerKinds(proofGraph())).toEqual(['api']);
    expect(declaredIoSchemas(proofGraph())).toEqual({ input: { type: 'object' }, output: { type: 'object' } });
  });
});
