/**
 * What a FOLLOW-LATEST trigger freezes, and what it deliberately does not.
 *
 * The compiler still freezes ONE answer — the version the workflow was published against — but
 * it now also records WHICH RULE produced it. A pinned trigger keeps the frozen bytes for the
 * life of the artifact; a follow-latest trigger has its `resolved` replaced, per run, by the
 * gateway (`effectiveTriggerConfig`) with the tenant's pin at dispatch. The interpreter is
 * untouched either way: it reads `resolved` and nothing else.
 *
 * `followsLatest` is OMITTED when false, on exactly the terms `userIdentity` and `openBindings`
 * already are: `compiledConfig` is checksummed over its canonical JSON, so a field that always
 * appeared would move the checksum of every artifact that never used it.
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
    compiledAt: '2026-09-17T00:00:00.000Z',
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

type TriggerConfigView = { stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }>; checksum: string };

function compiledOrThrow(g: WorkflowGraph, ctx: CompilerContext): TriggerConfigView {
  const result = compile(g, ctx);
  if ('findings' in result) throw new Error(`compile refused: ${JSON.stringify(result.findings)}`);
  return result.config as unknown as TriggerConfigView;
}

function triggerConfigOf(config: TriggerConfigView): Record<string, unknown> {
  return config.stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 'n_trigger')!.config;
}

describe('compile — followsLatest on the frozen trigger context schema', () => {
  it('stamps followsLatest beside resolved when the author asked the trigger to follow the pin', () => {
    const config = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1' } }),
      baseCtx({
        triggerContextSchema: { schemaId: 'schema-1', versionNumber: 3, versionId: 'version-3', payloadSchema: PAYLOAD_SCHEMA, followsLatest: true },
      }),
    );

    expect(triggerConfigOf(config).contextSchema).toEqual({
      contextSchemaId: 'schema-1',
      resolved: PAYLOAD_SCHEMA,
      followsLatest: true,
    });
  });

  it('OMITS followsLatest for a pinned trigger — byte-identical to an artifact compiled before the field existed', () => {
    const pinned = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      baseCtx({
        triggerContextSchema: { schemaId: 'schema-1', versionNumber: 2, versionId: 'version-2', payloadSchema: PAYLOAD_SCHEMA, followsLatest: false },
      }),
    );

    expect(triggerConfigOf(pinned).contextSchema).toEqual({
      contextSchemaId: 'schema-1',
      versionNumber: 2,
      resolved: PAYLOAD_SCHEMA,
    });
    expect(triggerConfigOf(pinned).contextSchema).not.toHaveProperty('followsLatest');
  });

  it('the two bindings compile to DIFFERENT checksums — the binding rule is part of the artifact', () => {
    const pinned = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1' } }),
      baseCtx({
        triggerContextSchema: { schemaId: 'schema-1', versionNumber: 3, versionId: 'v3', payloadSchema: PAYLOAD_SCHEMA, followsLatest: false },
      }),
    ).checksum;
    const latest = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1' } }),
      baseCtx({
        triggerContextSchema: { schemaId: 'schema-1', versionNumber: 3, versionId: 'v3', payloadSchema: PAYLOAD_SCHEMA, followsLatest: true },
      }),
    ).checksum;

    expect(pinned).not.toBe(latest);
  });

  it('emits nothing at all when the caller resolved no schema — followsLatest included', () => {
    expect(triggerConfigOf(compiledOrThrow(graph(), baseCtx()))).toEqual({});
  });
});
