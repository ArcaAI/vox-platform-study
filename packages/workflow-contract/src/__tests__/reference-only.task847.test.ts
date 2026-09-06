/**
 * RISK 1 — **the single most important review item in Track D.**
 *
 * > *A node schema stores a model id, endpoint or key in graph JSON — silently bypassing the
 * > tenant→SYSTEM cascade AND BYOK funding derivation.*
 *
 * Both halves of that sentence matter, and the second is the one that makes it a SILENT defect
 * rather than a loud one. Funding is DERIVED (`row.tenantId === SYSTEM_TENANT_ID`), so a graph
 * carrying its own endpoint does not fail — it serves, and it bills the wrong party, forever,
 * with nothing in any log to say so.
 *
 * A comment saying "references only" does not survive the next person adding a field. This file
 * is the mechanical form of the rule, in two directions:
 *
 *  1. **Structural, over the whole registry** — no node config schema anywhere declares a
 *     property that could HOLD a resolved credential, endpoint or provider-native model id.
 *     `additionalProperties: false` then does the rest: what is not declared cannot be authored.
 *  2. **Runtime, over a COMPILED graph** — the artifact that actually reaches Temporal is walked
 *     for both forbidden keys and secret-SHAPED values, so a smuggled endpoint is caught even if
 *     it arrives under an innocent key name.
 *
 * Direction 2 exists because direction 1 alone is a promise about schemas; the ticket asks for a
 * test asserting *no resolved credential or endpoint can appear in a compiled graph*, and only
 * walking a compiled graph proves that.
 */
import { describe, expect, it } from 'vitest';
import * as agenticContract from '../agentic-contract';
import { compile } from '../compiler';
import type { WorkflowGraph } from '../graph-model';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { AGENTIC_PALETTE_KEY, nodeInfo, registryChecksum } from '../node-registry';

const { FORBIDDEN_CONFIG_KEYS, compiledGraphLeakProblems, forbiddenSchemaKeyProblems } = agenticContract;

describe('direction 1: no schema can HOLD a resolved value', () => {
  it('declares a forbidden vocabulary covering credentials, endpoints and wire model ids', () => {
    // Stored lower-cased, because the check is case-insensitive: `apiKey`, `ApiKey` and
    // `api_key` are the same smuggling attempt wearing three hats.
    for (const expected of ['apikey', 'api_key', 'secret', 'password', 'token', 'endpoint', 'baseurl', 'host', 'provider', 'model', 'deploymentname', 'sourceuri']) {
      expect([...FORBIDDEN_CONFIG_KEYS], `${expected} must be forbidden`).toContain(expected);
    }
  });

  it('finds no forbidden key in ANY node config schema in the registry', () => {
    expect(forbiddenSchemaKeyProblems(NODE_CONFIG_SCHEMAS)).toEqual([]);
  });

  it('would catch one if it were added — the check is not vacuous', () => {
    const smuggled = {
      'agentic.agent': { type: 'object', properties: { generation: { type: 'object', properties: { baseUrl: { type: 'string' } } } } },
    };
    const problems = forbiddenSchemaKeyProblems(smuggled);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('baseUrl');
    expect(problems[0]).toContain('agentic.agent');
  });
});

/**
 * A graph that uses EVERY new node type — also the ticket's own verification criterion
 * ("a graph using every new node type compiles to a valid IR"). Ordering edges only, because the
 * point here is the compiled CONFIG, not the wiring; the port lattice is exercised elsewhere.
 */
function everyAgenticNodeGraph(agentConfigOverride?: Record<string, unknown>): WorkflowGraph {
  const ROUTING_POLICY_ID = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b41';
  const MCP_SERVER_ID = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b42';
  const PIPELINE_ID = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43';
  const nodes = [
    { id: 'start', type: 'core.start', config: {} },
    { id: 'in_node', type: 'agentic.input', config: { ioSchema: { type: 'object', properties: { note: { type: 'string' } } } } },
    { id: 'data_node', type: 'agentic.data', config: { mappings: [{ from: 'in.note', to: 'note' }] } },
    {
      id: 'agent_node',
      type: 'agentic.agent',
      config: agentConfigOverride ?? {
        providerConfigRef: { routingPolicyId: ROUTING_POLICY_ID },
        generation: { temperature: 0.2, maxTokens: 1024, presencePenalty: 0.1 },
        guards: { output: ['guard_node'] },
        tools: [{ mcpServerId: MCP_SERVER_ID, toolName: 'search' }],
      },
    },
    { id: 'guard_node', type: 'agentic.guardrail', config: { guardrailType: 'content_safety', onFail: 'mark' } },
    { id: 'loop_node', type: 'agentic.loop', config: { bounds: { maxIterations: 5, maxDurationSeconds: 300, maxTotalTokens: 100000 }, orchestratorNodeId: 'agent_node' } },
    { id: 'stt_node', type: 'agentic.stt', config: { pipelineRef: { pipelineId: PIPELINE_ID } } },
    { id: 'tts_node', type: 'agentic.tts', config: { providerConfigRef: { taskKey: 'tts.synthesize' }, voiceRef: 'clinical-en-1' } },
    { id: 'out_node', type: 'agentic.output', config: { ioSchema: { type: 'object' } } },
    { id: 'end', type: 'core.end', config: {} },
  ];
  const order = nodes.map((node) => node.id);
  // `from`/`to`, NOT `fromNodeId`/`toNodeId` — `WorkflowGraphEdge` uses the short names, and an
  // edge list using the long ones type-checks under a cast while wiring nothing at all, which
  // would leave this graph silently edgeless and the compile assertion far weaker than it reads.
  const edges = order.slice(0, -1).map((from, index) => ({ id: `e${index}`, from, to: order[index + 1], fromPort: 'next', toPort: 'after' }));
  return { version: 1, nodes, edges } as unknown as WorkflowGraph;
}

function compileGraph(graph: WorkflowGraph) {
  return compile(graph, {
    definitionId: '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b40',
    tenantId: '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b4f',
    slug: 'task-847-every-node',
    versionNumber: 1,
    paletteKey: AGENTIC_PALETTE_KEY,
    compilerVersion: '0.1.0',
    registryChecksum: registryChecksum(),
    ruleSetVersion: 1,
    caps: { maxTotalSeconds: 7200, maxNodeSeconds: 3600, maxAttempts: 5 },
    policyBindings: {
      guardrailProfile: 'STANDARD',
      redactionRuleSetId: null,
      promptTemplateRefs: [],
      documentTemplateRefs: [],
      contextSchemaVersionId: null,
      entitlementKeys: [],
    },
    compiledAt: '2026-09-01T00:00:00.000Z',
    // The REAL registry lookup, not a stub — the point of this graph is that the eight new node
    // types resolve for the compiler exactly as a published graph's would.
    nodeInfo,
  });
}

/** `compile()` returns `{ config } | { findings }`; narrowing it here keeps every assertion below
 *  about the CONTRACT rather than about the union. */
function compiledConfigOrThrow(graph: WorkflowGraph) {
  const result = compileGraph(graph);
  if (!('config' in result)) throw new Error(`compile failed: ${JSON.stringify(result.findings, null, 2)}`);
  return result.config;
}

describe('direction 2: nothing resolved reaches the COMPILED graph', () => {
  it('compiles a graph using every one of the eight new node types', () => {
    const config = compiledConfigOrThrow(everyAgenticNodeGraph());
    expect(config.formatVersion).toBe(1);
    // Every one of the eight reached a stage with a real activity name stamped on it.
    const compiledTypes = config.stages.flatMap((stage) => stage.nodes.map((node) => node.type)).sort();
    for (const key of ['agentic.input', 'agentic.output', 'agentic.agent', 'agentic.guardrail', 'agentic.data', 'agentic.loop', 'agentic.stt', 'agentic.tts']) {
      expect(compiledTypes, `${key} must reach the compiled IR`).toContain(key);
    }
  });

  it('finds no credential and no endpoint anywhere in that compiled IR', () => {
    expect(compiledGraphLeakProblems(compiledConfigOrThrow(everyAgenticNodeGraph()))).toEqual([]);
  });

  it('CATCHES a forbidden key smuggled into a node config', () => {
    // `additionalProperties: false` already refuses this at publish. The walk is the second
    // layer, for the compiled artifact itself — a config assembled anywhere but the validator.
    const leaked = compiledGraphLeakProblems({
      stages: [{ nodes: [{ id: 'agent_node', type: 'agentic.agent', config: { providerConfigRef: { apiKey: 'nope' } } }] }],
    });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toContain('apiKey');
  });

  it('CATCHES a resolved endpoint hiding under an innocent key name', () => {
    const leaked = compiledGraphLeakProblems({
      stages: [{ nodes: [{ id: 'agent_node', type: 'agentic.agent', config: { systemPrompt: 'https://my-vllm.internal:8000/v1' } }] }],
    });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toContain('systemPrompt');
  });

  it('CATCHES a secret-shaped literal', () => {
    const leaked = compiledGraphLeakProblems({
      stages: [{ nodes: [{ id: 'agent_node', type: 'agentic.agent', config: { voiceRef: 'sk-abcdef0123456789abcdef' } }] }],
    });
    expect(leaked).toHaveLength(1);
  });

  it('does NOT flag a uuid reference — that is the whole supported pattern', () => {
    expect(
      compiledGraphLeakProblems({
        stages: [{ nodes: [{ id: 'n', type: 'agentic.agent', config: { providerConfigRef: { routingPolicyId: '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b41' } } }] }],
      }),
    ).toEqual([]);
  });
});
