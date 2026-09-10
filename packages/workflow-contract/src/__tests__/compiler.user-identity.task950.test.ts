/**
 * TASK-950 L2 test 18 — the compiler FREEZES the user-identity binding onto `core.trigger`.
 *
 * `userIdentity` sits beside `resolved` and obeys exactly its rules: the caller resolves it
 * (`ConsultationContextSchemaService.resolveReference` derives it with the ONE implementation,
 * `userIdentityBindingFromDefinition`), the compiler stamps what it was handed, and no run ever
 * re-reads a schema row to learn which field carries the staff identifier. A workflow published
 * today must resolve the same field tomorrow even if the tenant has since moved the marker.
 *
 * Two absences are load-bearing:
 *
 *  - a resolution carrying no binding stamps NO key. `compiledConfig` is checksummed over its
 *    canonical JSON, so a key that always appeared would change the checksum of every artifact
 *    that never used it — the committed seed graphs and golden fixtures included.
 *  - an INLINE trigger schema with no resolution is still left exactly as authored. The compiler
 *    resolves nothing itself and derives nothing itself; a second derivation living here is
 *    precisely what the single-implementation rule forbids.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';

const PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { context: { type: 'object', properties: { consultant_id: { type: 'string' } } } },
};

const BINDING = { kindKey: 'context', field: 'consultant_id' };

const RESOLUTION = { schemaId: 'schema-1', versionNumber: 2, versionId: 'version-2', payloadSchema: PAYLOAD_SCHEMA };

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
    compiledAt: '2026-09-11T00:00:00.000Z',
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

type Compiled = { checksum: string; stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }> };

function compiledOrThrow(g: WorkflowGraph, ctx: CompilerContext): Compiled {
  const result = compile(g, ctx);
  if ('findings' in result) throw new Error(`compile refused: ${JSON.stringify(result.findings)}`);
  return result.config as unknown as Compiled;
}

function triggerContextSchemaOf(config: Compiled): Record<string, unknown> {
  const trigger = config.stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 'n_trigger')!;
  return trigger.config.contextSchema as Record<string, unknown>;
}

describe('compile — the frozen trigger user-identity binding (test 18)', () => {
  it('freezes `userIdentity` beside `resolved` for a BY-REFERENCE schema', () => {
    const config = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: BINDING } }),
    );

    expect(triggerContextSchemaOf(config)).toEqual({
      contextSchemaId: 'schema-1',
      versionNumber: 2,
      resolved: PAYLOAD_SCHEMA,
      userIdentity: BINDING,
    });
  });

  it('freezes it the same way beside an INLINE-authored schema — the authoring shape is not the rule', () => {
    const inline = { type: 'object', properties: { consultant_id: { type: 'string' } } };
    const config = compiledOrThrow(graph({ contextSchema: { inline } }), baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: BINDING } }));

    expect(triggerContextSchemaOf(config)).toEqual({ inline, resolved: PAYLOAD_SCHEMA, userIdentity: BINDING });
  });

  it('stamps NO key when the resolution carries no binding — absent, never null', () => {
    const config = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: null } }),
    );

    expect(triggerContextSchemaOf(config)).not.toHaveProperty('userIdentity');
    expect(triggerContextSchemaOf(config).resolved).toEqual(PAYLOAD_SCHEMA);
  });

  it('stamps NO key for a caller that predates the field — byte-identical legacy artifacts', () => {
    const config = compiledOrThrow(graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }), baseCtx({ triggerContextSchema: RESOLUTION }));

    expect(triggerContextSchemaOf(config)).not.toHaveProperty('userIdentity');
  });

  it('leaves an INLINE schema with no resolution exactly as authored — the compiler derives nothing itself', () => {
    const inline = { type: 'object', properties: { consultant_id: { type: 'string' } } };
    const config = compiledOrThrow(graph({ contextSchema: { inline } }), baseCtx());

    expect(triggerContextSchemaOf(config)).toEqual({ inline });
  });

  it('changes the checksum only when a binding is actually frozen', () => {
    const bare = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({ triggerContextSchema: RESOLUTION }),
    ).checksum;
    const bareAgain = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: null } }),
    ).checksum;
    const bound = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: BINDING } }),
    ).checksum;

    // `userIdentity: null` and an absent key are the SAME artifact — that is what makes the
    // additive posture real rather than merely intended.
    expect(bareAgain).toBe(bare);
    expect(bound).not.toBe(bare);
  });
});
