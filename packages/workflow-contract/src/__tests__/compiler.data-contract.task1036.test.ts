/**
 * TASK-1036 §9.2 / §9.3 / §3.5 — what the compiler emits for the data contract: per-node
 * `bindings` (legacy edges translated), per-node declared `consultationReads`, and the compiled
 * `settings`. Opt-in (`emitDataContract`) until the interpreter mirrors the shape (lane B1); off,
 * every artifact is byte-identical to before.
 */
import { describe, expect, it } from 'vitest';
import { compile, type CompiledNode, type CompiledWorkflowConfig, type CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';
import { nodeInfo, registryChecksum } from '../node-registry';

const BASE: CompilerContext = {
  definitionId: '018f1e0a-0000-7000-8000-000000000001',
  slug: 'data-contract',
  versionNumber: 1,
  tenantId: '00000000-0000-0000-0000-000000000000',
  paletteKey: 'core',
  compilerVersion: '0.1.0',
  registryChecksum: registryChecksum(),
  ruleSetVersion: 1,
  caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
  policyBindings: { guardrailProfile: 'STANDARD', redactionRuleSetId: null, promptTemplateRefs: [], documentTemplateRefs: [], contextSchemaVersionId: null, entitlementKeys: [] },
  compiledAt: '2026-10-04T00:00:00.000Z',
  nodeInfo,
};

const AGENTS = {
  asr: { task: 'SPEECH_TO_TEXT' as const },
  ner: { task: 'NAMED_ENTITY_RECOGNITION' as const },
  gen: { task: 'TEXT_GENERATION' as const },
  finalize: { task: 'TEXT_GENERATION' as const, outputSchema: { type: 'object', properties: { case_note: { type: 'string' } } } },
};

function graph(settings?: unknown): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['consultation', 'api'] } },
      { id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'asr' } } },
      { id: 'n_transcript', type: 'core.data', config: { mappings: [{ from: 'in.transcript.text', to: 'text' }] } },
      { id: 'n_ner', type: 'core.agent', config: { agentRef: { slug: 'ner' } } },
      {
        id: 'n_summary',
        type: 'core.agent',
        config: { agentRef: { slug: 'gen' }, label: 'Running note', inputs: { context: { from: 'consultation.notes.preSummary', at: 'runStart' } } },
      },
      { id: 'n_finalize', type: 'core.agent', config: { agentRef: { slug: 'finalize' } } },
      { id: 'n_output', type: 'core.output', config: { protocols: ['http', 'http-sse', 'socket'] } },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_asr', toPort: 'after' },
      { id: 'e2', from: 'n_asr', fromPort: 'transcript', to: 'n_ner', toPort: 'in' },
      { id: 'e3', from: 'n_ner', fromPort: 'out', to: 'n_summary', toPort: 'in' },
      { id: 'e4', from: 'n_summary', fromPort: 'out', to: 'n_finalize', toPort: 'in' },
      { id: 'e5', from: 'n_finalize', fromPort: 'data', to: 'n_output', toPort: 'in' },
      { id: 'e6', from: 'n_trigger', fromPort: 'out', to: 'n_transcript', toPort: 'in' },
      { id: 'e7', from: 'n_transcript', fromPort: 'text', to: 'n_ner', toPort: 'in' },
    ],
    ...(settings === undefined ? {} : { settings }),
  } as WorkflowGraph;
}

function configOf(result: ReturnType<typeof compile>): CompiledWorkflowConfig {
  if (!('config' in result)) throw new Error(JSON.stringify(result.findings));
  return result.config;
}

function nodesOf(config: CompiledWorkflowConfig): Record<string, CompiledNode> {
  return Object.fromEntries(config.stages.flatMap((stage) => stage.nodes).map((node) => [node.nodeId, node]));
}

describe('emitDataContract off (the default): nothing changes', () => {
  it('emits no bindings, no consultationReads and no settings', () => {
    const config = configOf(compile(graph(), { ...BASE, agents: AGENTS }));
    expect('settings' in config).toBe(false);
    for (const node of Object.values(nodesOf(config))) {
      expect('bindings' in node).toBe(false);
      expect('consultationReads' in node).toBe(false);
    }
  });
});

describe('emitDataContract on', () => {
  const config = configOf(compile(graph(), { ...BASE, agents: AGENTS, emitDataContract: true }));
  const nodes = nodesOf(config);

  it('translates the seeded ASR -> NER and finalize.data -> output patterns', () => {
    expect(nodes.n_ner?.bindings).toEqual({ text: { firstOf: ['nodes.n_transcript.outputs.text', 'nodes.n_asr.outputs.transcript'] } });
    expect(nodes.n_output?.bindings).toEqual({ in: { from: 'nodes.n_finalize.outputs.data' } });
    expect(nodes.n_finalize?.bindings).toEqual({ message: { from: 'nodes.n_summary.outputs.text' } });
  });

  it('keeps the legacy port inputs exactly as before (the interpreter still reads them for one release)', () => {
    expect(nodes.n_ner?.inputs).toEqual([
      { fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' },
      { fromNodeId: 'n_transcript', fromPort: 'text', toPort: 'in' },
    ]);
  });

  it('authored bindings join the translated ones; a node with nothing bound carries no `bindings`', () => {
    expect(nodes.n_summary?.bindings).toEqual({ message: { from: 'nodes.n_ner.outputs.text' }, context: { from: 'consultation.notes.preSummary', at: 'runStart' } });
    expect('bindings' in (nodes.n_asr as object)).toBe(false);
    expect('bindings' in (nodes.n_trigger as object)).toBe(false);
  });

  it('freezes each node`s declared consultation reads', () => {
    expect(nodes.n_summary?.consultationReads).toEqual([{ path: 'consultation.notes.preSummary', at: 'runStart' }]);
    expect('consultationReads' in (nodes.n_ner as object)).toBe(false);
  });

  it('emits the effective settings (legacy-derived here)', () => {
    expect(config.settings).toEqual({ connections: ['api', 'sse', 'socket'], sources: ['consultation'] });
  });

  it('declared settings win over the legacy keys', () => {
    const declared = configOf(compile(graph({ connections: ['api', 'socket'], sources: [] }), { ...BASE, agents: AGENTS, emitDataContract: true }));
    expect(declared.settings).toEqual({ connections: ['api', 'socket'], sources: [] });
  });

  it('is deterministic', () => {
    const again = configOf(compile(graph(), { ...BASE, agents: AGENTS, emitDataContract: true }));
    expect(again.checksum).toBe(config.checksum);
  });
});

describe('settings.contextSchema is frozen onto the compiled trigger', () => {
  it('a by-reference settings schema becomes the trigger`s schema, and the caller`s resolution freezes beside it', () => {
    const settings = { connections: ['api'], sources: [], contextSchema: { contextSchemaId: 'cs-1', versionNumber: null } };
    const config = configOf(
      compile(graph(settings), {
        ...BASE,
        triggerContextSchema: { schemaId: 'cs-1', versionNumber: 2, versionId: 'v-2', payloadSchema: { type: 'object' }, followsLatest: true },
      }),
    );
    expect(nodesOf(config).n_trigger?.config.contextSchema).toEqual({ contextSchemaId: 'cs-1', resolved: { type: 'object' }, followsLatest: true });
  });

  it('an inline settings schema becomes the trigger`s inline schema, so the run is still validated', () => {
    const settings = { connections: ['api'], sources: [], contextSchema: { inline: { type: 'object', properties: { a: { type: 'string' } } } } };
    const config = configOf(compile(graph(settings), BASE));
    expect(nodesOf(config).n_trigger?.config.contextSchema).toEqual({ inline: { type: 'object', properties: { a: { type: 'string' } } } });
  });

  it('a graph with no settings compiles its trigger exactly as authored', () => {
    expect(nodesOf(configOf(compile(graph(), BASE))).n_trigger?.config).toEqual({ kinds: ['consultation', 'api'] });
  });
});
