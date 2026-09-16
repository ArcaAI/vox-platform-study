/**
 * TASK-890 black-box J4-F4 — a REFERENCED trigger context schema must SHAPE the published
 * Input contract.
 *
 * The gap: `declaredIoSchemas` read `contextSchema.inline` and nothing else, so a trigger bound
 * BY REFERENCE (`contextSchemaId`, the shape the console's picker authors) published an untyped
 * `{ type: 'object', additionalProperties: true }` Input — even though the publish path had
 * already resolved that reference and FROZEN the derived payload schema into the compiled
 * trigger node's `config.contextSchema.resolved` (`compiler.ts#compiledConfigFor`).
 *
 * Two halves, both read-side:
 *  - `declaredIoSchemas` PREFERS `resolved` over `inline` wherever it finds it, so a graph-shaped
 *    node that already carries the frozen answer is read as typed;
 *  - `compiledTriggerContextSchema` lifts that same answer out of a COMPILED artifact, which is
 *    where it actually lives for a published definition (the `graph` column keeps the authored
 *    reference verbatim — that is what a re-publish re-resolves).
 *
 * No republish is required for a definition already published with a bound reference: the bytes
 * being read are the ones publish already wrote.
 */
import { describe, expect, it } from 'vitest';
import { compile, type CompilerContext } from '../compiler';
import { compiledTriggerContextSchema, declaredIoSchemas } from '../core-contract';
import type { WorkflowGraph } from '../graph-model';

const RESOLVED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { consultation_note: { type: 'object' } },
  required: ['consultation_note'],
};
const INLINE_SCHEMA = { type: 'object', properties: { patientId: { type: 'string' } } };

function ctx(overrides: Partial<CompilerContext> = {}): CompilerContext {
  return {
    definitionId: '018f1e0a-0000-7000-8000-000000000001',
    slug: 'triage',
    versionNumber: 1,
    tenantId: '50000000-0000-0000-0000-000000000000',
    paletteKey: 'core',
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

function compiledOrThrow(g: WorkflowGraph, context: CompilerContext): unknown {
  const result = compile(g, context);
  if ('findings' in result) throw new Error(`compile refused: ${JSON.stringify(result.findings)}`);
  return result.config;
}

describe('declaredIoSchemas — a resolved reference types the Input', () => {
  it('prefers the frozen `resolved` schema over an inline one', () => {
    const { input } = declaredIoSchemas(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2, inline: INLINE_SCHEMA, resolved: RESOLVED_SCHEMA } }),
    );
    expect(input).toEqual(RESOLVED_SCHEMA);
  });

  it('still reads a purely inline schema', () => {
    expect(declaredIoSchemas(graph({ contextSchema: { inline: INLINE_SCHEMA } })).input).toEqual(INLINE_SCHEMA);
  });

  it('answers null for a reference the caller has not resolved — never an invented shape', () => {
    expect(declaredIoSchemas(graph({ contextSchema: { contextSchemaId: 'schema-1' } })).input).toBeNull();
  });
});

describe('compiledTriggerContextSchema — the answer publish already froze', () => {
  it('lifts the resolved payload schema out of a compiled artifact', () => {
    const compiled = compiledOrThrow(
      graph({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }),
      ctx({
        triggerContextSchema: {
          schemaId: 'schema-1',
          versionNumber: 2,
          versionId: 'version-2',
          payloadSchema: RESOLVED_SCHEMA,
          followsLatest: false,
        },
      }),
    );
    expect(compiledTriggerContextSchema(compiled)).toEqual(RESOLVED_SCHEMA);
  });

  it('answers null when the artifact froze nothing, and for junk', () => {
    expect(compiledTriggerContextSchema(compiledOrThrow(graph(), ctx()))).toBeNull();
    expect(compiledTriggerContextSchema(null)).toBeNull();
    expect(compiledTriggerContextSchema({ stages: 'not-an-array' })).toBeNull();
    expect(compiledTriggerContextSchema({ stages: [{ nodes: [{ nodeId: 'x', type: 'core.trigger', config: {} }] }] })).toBeNull();
  });
});
