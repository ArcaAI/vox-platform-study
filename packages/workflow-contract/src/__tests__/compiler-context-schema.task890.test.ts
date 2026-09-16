/**
 * TASK-890 L2 §3.4 / §3.14 — what the compiler FREEZES into a published artifact.
 *
 * Two additive fields, one rule between them: the harness never re-reads Postgres
 * (invariant 4), so anything the interpreter needs about the trigger's context schema or the
 * workflow's guardrail opinion has to be in the compiled bytes at publish time.
 *
 * Both are OMITTED when there is nothing to say. That is not cosmetic: `compiledConfig` is
 * checksummed over its canonical JSON, so a field that always appeared would change the
 * checksum of every artifact that never used it — including the committed seed graphs and
 * the golden fixtures — for no information gained.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';

const PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { context: { type: 'object', properties: { conversation_language: { type: 'string' } } } },
};

function baseCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
  return {
    definitionId: '018f1e0a-0000-7000-8000-000000000001',
    slug: 'consultation-default',
    versionNumber: 1,
    tenantId: '50000000-0000-0000-0000-000000000000',
    paletteKey: 'consultation',
    compilerVersion: '0.1.0',
    registryChecksum: 'reg-checksum-abc',
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
    compiledAt: '2026-09-06T00:00:00.000Z',
    nodeInfo: (type: string) => {
      if (type === 'core.trigger') return { activity: 'interpreter.core_trigger', classes: ['boundary', 'mandatory', 'entry'] };
      if (type === 'core.output') return { activity: 'interpreter.core_output', classes: ['boundary', 'terminal'] };
      return { activity: 'interpreter.core_agent', classes: [] };
    },
    ...overrides,
  };
}

function graph(triggerConfig: Record<string, unknown> = {}): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: triggerConfig },
      { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'clinical-summarizer' } } },
      { id: 'n_output', type: 'core.output', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_agent', toPort: 'in' },
      { id: 'e2', from: 'n_agent', fromPort: 'out', to: 'n_output', toPort: 'in' },
    ],
  };
}

type Compiled = {
  config: {
    checksum: string;
    stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }>;
    policyBindings: Record<string, unknown>;
  };
};

function compiledOrThrow(g: WorkflowGraph, ctx: CompilerContext): Compiled['config'] {
  const result = compile(g, ctx);
  if ('findings' in result) throw new Error(`compile refused: ${JSON.stringify(result.findings)}`);
  // Two-step cast: `CompiledWorkflowConfig` has no index signature, so it does not overlap
  // `Record<string, unknown>` structurally — the local view is a READ shape for the assertions
  // below, not a claim about the emitted type.
  return result.config as unknown as Compiled['config'];
}

function triggerNode(config: Compiled['config']): { nodeId: string; config: Record<string, unknown> } {
  return config.stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 'n_trigger')!;
}

describe('compile — the frozen trigger context schema', () => {
  it('stamps the derived payload schema on the compiled trigger node and records the ref', () => {
    const config = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({
        triggerContextSchema: { schemaId: 'schema-1', versionNumber: 2, versionId: 'version-2', payloadSchema: PAYLOAD_SCHEMA, followsLatest: false },
      }),
    );

    expect(triggerNode(config).config).toMatchObject({
      contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2, resolved: PAYLOAD_SCHEMA },
    });
    expect(config.policyBindings.contextSchemaRefs).toEqual([
      { nodeId: 'n_trigger', schemaId: 'schema-1', versionNumber: 2, versionId: 'version-2' },
    ]);
  });

  it('emits NOTHING when the caller resolved no schema — byte-identical legacy artifacts', () => {
    const withoutSchema = compiledOrThrow(graph(), baseCtx());

    expect(triggerNode(withoutSchema).config).toEqual({});
    expect(withoutSchema.policyBindings).not.toHaveProperty('contextSchemaRefs');
  });

  it('leaves an INLINE trigger schema exactly as authored — the compiler resolves nothing itself', () => {
    const inline = { type: 'object', properties: { patientId: { type: 'string' } } };
    const config = compiledOrThrow(graph({ contextSchema: { inline } }), baseCtx());

    expect(triggerNode(config).config).toEqual({ contextSchema: { inline } });
    expect(config.policyBindings).not.toHaveProperty('contextSchemaRefs');
  });

  it('changes the checksum only when a schema is actually bound', () => {
    const bare = compiledOrThrow(graph(), baseCtx()).checksum;
    const bareAgain = compiledOrThrow(graph(), baseCtx()).checksum;
    const bound = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({
        triggerContextSchema: { schemaId: 'schema-1', versionNumber: 2, versionId: 'version-2', payloadSchema: PAYLOAD_SCHEMA, followsLatest: false },
      }),
    ).checksum;

    expect(bare).toBe(bareAgain);
    expect(bound).not.toBe(bare);
  });
});

describe('compile — the workflow guardrail default (§3.14)', () => {
  it('compiles an explicit opt-out from the trigger into policyBindings', () => {
    const config = compiledOrThrow(graph({ guardrail: { enabled: false } }), baseCtx());

    expect(config.policyBindings.guardrail).toEqual({ enabled: false });
  });

  it('compiles an explicit opt-IN too — a decision recorded is not the same as no decision', () => {
    const config = compiledOrThrow(graph({ guardrail: { enabled: true } }), baseCtx());

    expect(config.policyBindings.guardrail).toEqual({ enabled: true });
  });

  it('says nothing when the workflow expresses no opinion (absence is the tri-state)', () => {
    const config = compiledOrThrow(graph({ guardrail: {} }), baseCtx());

    expect(config.policyBindings).not.toHaveProperty('guardrail');
    expect(compiledOrThrow(graph(), baseCtx()).policyBindings).not.toHaveProperty('guardrail');
  });
});
