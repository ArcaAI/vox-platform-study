/**
 * TASK-890 §3.5 (F-10) — the ONE publish gate, as machine-readable findings.
 *
 * BLOCKER 1c: `workflowPublishProblems` existed, returned `string[]`, and NOTHING in the gateway
 * called it — an unwired gate is not a gate, and a definition that arrived through an importer
 * reached publish having passed no check at all. `publishFindings` replaces it with findings the
 * Studio rail can map onto a canvas node, carrying a machine-readable `code` so the console can
 * render a fix per problem instead of a wall of strings. It also runs the check NOBODY ran: the
 * per-node config schema (`NODE_CONFIG_SCHEMA`).
 *
 * Two properties this suite pins deliberately:
 *
 * - Every check `workflowPublishProblems` ran still runs. This is a re-emission, not a rewrite,
 *   so deleting the old export removes an unused string API and no coverage.
 * - `templateReferenceSeverity` is the OD-C ramp (WARNING in release 1, ERROR in release +1) and
 *   is the CALLER's to set — the same undeclared variable is authoring feedback in a draft and a
 *   publish refusal a release later, and neither reading belongs inside a pure function.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { PUBLISH_FINDING_RULE_ID, publishFindings, type PublishContext } from '../publish-findings';

const ctx = (overrides: Partial<PublishContext> = {}): PublishContext => ({
  schemaValueProblems: jsonSchemaValueProblems,
  templateReferenceSeverity: 'WARNING',
  ...overrides,
});

/** A minimal well-formed `core` graph: trigger -> agent -> output. */
function coreGraph(nodes: Array<Record<string, unknown>> = [], edges: Array<Record<string, unknown>> = []): WorkflowGraph {
  return {
    nodes: [{ id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } }, ...nodes],
    edges,
  } as unknown as WorkflowGraph;
}

const codesOf = (graph: WorkflowGraph, context = ctx()) => publishFindings(graph, context).map((finding) => finding.code);

describe('publishFindings — the core node checks', () => {
  it('reports AGENT_REF_MISSING for a `core.agent` with no agentRef', () => {
    const findings = publishFindings(coreGraph([{ id: 'a1', type: 'core.agent', config: {} }]), ctx());
    const agentRef = findings.filter((finding) => finding.code === 'AGENT_REF_MISSING');
    expect(agentRef).toHaveLength(1);
    expect(agentRef[0]?.severity).toBe('ERROR');
    expect(agentRef[0]?.nodeId).toBe('a1');
    expect(agentRef[0]?.ruleId).toBe(PUBLISH_FINDING_RULE_ID);
  });

  it('reports NODE_CONFIG_SCHEMA for a `core.trigger` that declares BOTH context-schema forms', () => {
    // `additionalProperties: false` + the "either inline or a row reference" rule: the SCHEMA
    // catches the shape, `coreNodeConfigProblems` catches the exclusivity. Both must surface.
    const graph = {
      nodes: [
        {
          id: 't1',
          type: 'core.trigger',
          config: { kinds: ['api'], contextSchema: { inline: { type: 'object' }, contextSchemaId: '1111', versionNumber: 0 } },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    } as unknown as WorkflowGraph;
    expect(codesOf(graph)).toContain('NODE_CONFIG_SCHEMA');
  });

  it('reports CEL_INVALID for an unparseable condition', () => {
    const graph = coreGraph([{ id: 'c1', type: 'core.condition', config: { branches: [{ key: 'a', when: 'trigger.x ===' }] } }]);
    expect(codesOf(graph)).toContain('CEL_INVALID');
  });

  it('reports LOOP_BOUNDS when a loop is unbounded on any axis', () => {
    const graph = coreGraph([{ id: 'l1', type: 'core.loop', config: { mode: 'foreach', over: 'trigger.items', bounds: { maxIterations: 3 } } }]);
    expect(codesOf(graph)).toContain('LOOP_BOUNDS');
  });

  it('reports ACTION_KEY for an action outside the catalogue', () => {
    expect(codesOf(coreGraph([{ id: 'x1', type: 'core.action', config: { actionKey: 'not.a.real.action' } }]))).toContain('ACTION_KEY');
  });

  it('reports OUTPUT_PROTOCOL for an undeclared protocol', () => {
    expect(codesOf(coreGraph([{ id: 'o1', type: 'core.output', config: { protocols: ['carrier-pigeon'] } }]))).toContain('OUTPUT_PROTOCOL');
  });

  it('never runs the NEW per-node checks on a non-`core.*` node (release 1 scope, Risk 4)', () => {
    // `agentic.data` carries a config schema too; release 1 does not enforce it, so a config
    // that would fail the schema produces no NODE_CONFIG_SCHEMA finding.
    const graph = coreGraph([{ id: 'd1', type: 'agentic.data', config: { totally: 'undeclared' } }]);
    expect(codesOf(graph)).not.toContain('NODE_CONFIG_SCHEMA');
  });
});

describe('publishFindings — the graph checks it inherits from workflowPublishProblems', () => {
  it('reports GUARD_REQUIRED when a node`s `requires` guard is not attached to THIS instance', () => {
    const graph = {
      nodes: [
        { id: 'g1', type: 'agent.summarization', config: {}, position: { x: 0, y: 0 } },
        { id: 'x1', type: 'core.note', config: {}, position: { x: 1, y: 0 } },
      ],
      edges: [{ id: 'e1', from: 'g1', to: 'x1', fromPort: 'out', toPort: 'in' }],
    } as unknown as WorkflowGraph;
    expect(codesOf(graph)).toContain('GUARD_REQUIRED');
  });

  it('reports LOOP_BODY when a body node wires outside its loop', () => {
    const graph = {
      nodes: [
        {
          id: 'l1',
          type: 'core.loop',
          config: { mode: 'foreach', over: 'trigger.items', bounds: { maxIterations: 1, maxDurationSeconds: 1, maxTotalTokens: 1 } },
          position: { x: 0, y: 0 },
        },
        { id: 'b1', type: 'core.note', config: {}, parentId: 'l1', position: { x: 1, y: 0 } },
        { id: 'n2', type: 'core.note', config: {}, position: { x: 2, y: 0 } },
      ],
      edges: [{ id: 'e1', from: 'b1', to: 'n2', fromPort: 'out', toPort: 'in' }],
    } as unknown as WorkflowGraph;
    expect(codesOf(graph)).toContain('LOOP_BODY');
  });

  it('still runs the `agentic.*` reference checks — deleting the old export removed no coverage', () => {
    const graph = coreGraph([{ id: 'a1', type: 'agentic.agent', config: { providerConfigRef: {} } }]);
    expect(codesOf(graph).length).toBeGreaterThan(0);
  });
});

describe('publishFindings — the per-node override ranges (4c)', () => {
  const graphWithOverride = (temperature: number) =>
    coreGraph([{ id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' }, overrides: { generation: { temperature } } } }]);

  const withRanges = ctx({
    agents: { summarizer: { declaredVariables: [], contextPayloadSchema: null, generationRanges: { temperature: { min: 0, max: 0.8 } } } },
  });

  it('reports OVERRIDE_OUT_OF_RANGE above the agent`s declared maximum', () => {
    const findings = publishFindings(graphWithOverride(0.9), withRanges).filter((f) => f.code === 'OVERRIDE_OUT_OF_RANGE');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('ERROR');
    expect(findings[0]?.path).toBe('/overrides/generation/temperature');
  });

  it('accepts a value inside the range, and checks nothing when the agent declares no range', () => {
    expect(codesOf(graphWithOverride(0.5), withRanges)).not.toContain('OVERRIDE_OUT_OF_RANGE');
    expect(codesOf(graphWithOverride(1.9))).not.toContain('OVERRIDE_OUT_OF_RANGE');
  });
});

describe('publishFindings — the template checks and the OD-C severity ramp', () => {
  const graphWithTemplate = (value: string) =>
    coreGraph([{ id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' }, overrides: { promptVariables: { note: value } } } }]);

  const declared = ctx({
    agents: { summarizer: { declaredVariables: ['tone'], contextPayloadSchema: null } },
    triggerContextSchema: { type: 'object', additionalProperties: false, properties: { patientAge: { type: 'number' } } },
  });

  it('reports PROMPT_VARIABLE_UNDECLARED at the caller`s severity — WARNING in release 1', () => {
    const findings = publishFindings(graphWithTemplate('{{context.absent}}'), declared).filter((f) => f.code === 'PROMPT_VARIABLE_UNDECLARED');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('WARNING');
  });

  it('…and at ERROR once the ramp is promoted', () => {
    const findings = publishFindings(graphWithTemplate('{{context.absent}}'), { ...declared, templateReferenceSeverity: 'ERROR' }).filter(
      (f) => f.code === 'PROMPT_VARIABLE_UNDECLARED',
    );
    expect(findings[0]?.severity).toBe('ERROR');
  });

  it('accepts a reference the trigger`s schema declares, and the agent`s own variable names', () => {
    expect(codesOf(graphWithTemplate('{{context.patientAge}} {{tone}}'), declared)).not.toContain('PROMPT_VARIABLE_UNDECLARED');
  });

  it('resolves `vars.*` against the graph`s own `core.variable` keys', () => {
    const graph = coreGraph([
      { id: 'v1', type: 'core.variable', config: { variables: [{ key: 'language' }] } },
      { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' }, overrides: { promptVariables: { a: '{{vars.language}}' } } } },
    ]);
    expect(codesOf(graph, declared)).not.toContain('PROMPT_VARIABLE_UNDECLARED');
    const bad = coreGraph([
      { id: 'v1', type: 'core.variable', config: { variables: [{ key: 'language' }] } },
      { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' }, overrides: { promptVariables: { a: '{{vars.nope}}' } } } },
    ]);
    expect(codesOf(bad, declared)).toContain('PROMPT_VARIABLE_UNDECLARED');
  });

  it('reports PROMPT_TEMPLATE_SYNTAX as an ERROR regardless of the ramp', () => {
    const findings = publishFindings(graphWithTemplate('{{a | upper}}'), declared).filter((f) => f.code === 'PROMPT_TEMPLATE_SYNTAX');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('ERROR');
  });
});

describe('publishFindings — the context-schema reference', () => {
  const triggerWithRef = {
    nodes: [
      {
        id: 't1',
        type: 'core.trigger',
        config: { kinds: ['api'], contextSchema: { contextSchemaId: '22222222-2222-2222-2222-222222222222', versionNumber: 2 } },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  } as unknown as WorkflowGraph;

  it('reports CONTEXT_SCHEMA_NOT_FOUND when the caller resolved the reference to nothing', () => {
    const findings = publishFindings(triggerWithRef, ctx({ triggerContextSchema: null })).filter((f) => f.code === 'CONTEXT_SCHEMA_NOT_FOUND');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('ERROR');
    expect(findings[0]?.nodeId).toBe('t1');
  });

  it('reports the VERSION variant when the caller names it', () => {
    const findings = publishFindings(
      triggerWithRef,
      ctx({ triggerContextSchema: null, triggerContextSchemaFailure: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' }),
    );
    expect(findings.map((f) => f.code)).toContain('CONTEXT_SCHEMA_VERSION_NOT_FOUND');
  });

  it('says nothing when the caller did not resolve the reference at all', () => {
    expect(codesOf(triggerWithRef)).not.toContain('CONTEXT_SCHEMA_NOT_FOUND');
  });
});

describe('publishFindings — GUARDRAIL_OPTED_OUT (§3.14)', () => {
  it('WARNS, never blocks, on a `core.agent` node that opts out', () => {
    const graph = coreGraph([{ id: 'a1', type: 'core.agent', config: { agentRef: { slug: 's' }, guardrail: { enabled: false } } }]);
    const findings = publishFindings(graph, ctx()).filter((f) => f.code === 'GUARDRAIL_OPTED_OUT');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('WARNING');
    expect(findings[0]?.nodeId).toBe('a1');
    expect(findings[0]?.message).toContain('node');
  });

  it('WARNS on the trigger when the WORKFLOW default is off', () => {
    const graph = {
      nodes: [{ id: 't1', type: 'core.trigger', config: { kinds: ['api'], guardrail: { enabled: false } }, position: { x: 0, y: 0 } }],
      edges: [],
    } as unknown as WorkflowGraph;
    const findings = publishFindings(graph, ctx()).filter((f) => f.code === 'GUARDRAIL_OPTED_OUT');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.nodeId).toBe('t1');
  });

  it('WARNS on an agent node that INHERITS an off workflow default — the fold, not the literal', () => {
    const graph = {
      nodes: [
        { id: 't1', type: 'core.trigger', config: { kinds: ['api'], guardrail: { enabled: false } }, position: { x: 0, y: 0 } },
        { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 's' } }, position: { x: 1, y: 0 } },
      ],
      edges: [],
    } as unknown as WorkflowGraph;
    const nodeIds = publishFindings(graph, ctx())
      .filter((f) => f.code === 'GUARDRAIL_OPTED_OUT')
      .map((f) => f.nodeId)
      .sort();
    expect(nodeIds).toEqual(['a1', 't1']);
  });

  it('is silent when a node re-enables screening the workflow turned off', () => {
    const graph = {
      nodes: [
        { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
        { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 's' }, guardrail: { enabled: true } }, position: { x: 1, y: 0 } },
      ],
      edges: [],
    } as unknown as WorkflowGraph;
    expect(codesOf(graph)).not.toContain('GUARDRAIL_OPTED_OUT');
  });

  it('never fires for a MANDATORY guard node in release 1 — those withhold `enabled` entirely (D-1 is L14`s)', () => {
    const graph = coreGraph([{ id: 'g1', type: 'guardrail.check', config: { enabled: false } }]);
    expect(codesOf(graph)).not.toContain('GUARDRAIL_OPTED_OUT');
  });
});
