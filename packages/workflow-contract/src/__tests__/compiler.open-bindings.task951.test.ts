/**
 * TASK-951 item 2 — the compiler FREEZES the open-time bindings onto `core.trigger`.
 *
 * `openBindings` sits beside `resolved` and `userIdentity` and obeys exactly their rules: the
 * CALLER resolves it (`ConsultationContextSchemaService.resolveReference` derives it with the
 * one implementation, `openBindingsFromDefinition`), the compiler stamps what it was handed,
 * and no run ever re-reads a schema row to learn where a client's department or visit type
 * lives. A workflow published today must route to the same department tomorrow even if the
 * tenant has since moved the marker.
 *
 * Two absences are load-bearing, as they were for `userIdentity`:
 *
 *  - a resolution carrying no bindings stamps NO key. `compiledConfig` is checksummed over its
 *    canonical JSON, so a key that always appeared would change the checksum of every artifact
 *    that never used it — the committed seed graphs and golden fixtures included.
 *  - the compiler derives NOTHING itself. An inline trigger schema with no resolution is left
 *    exactly as authored; a second derivation living in this package is precisely what the
 *    single-implementation rule forbids.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompiledOpenBindings, CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';

const PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    encounter: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string' },
        department_code: { type: 'string' },
        visit_type: { type: 'string' },
        event_id: { type: 'string' },
      },
    },
  },
};

const IDENTITY = { kindKey: 'encounter', field: 'doctor_id' };

/** What the ArcaAI scribe schema derives — every role plus one materialising kind. */
const OPEN_BINDINGS: CompiledOpenBindings = {
  userIdentity: IDENTITY,
  department: { kindKey: 'encounter', field: 'department_code', by: 'code' },
  visitType: { kindKey: 'encounter', field: 'visit_type' },
  externalRef: { kindKey: 'encounter', field: 'event_id' },
  materialize: [{ kindKey: 'previous_case_notes', as: 'CASE_NOTE' }],
};

const RESOLUTION = { schemaId: 'schema-1', versionNumber: 2, versionId: 'version-2', payloadSchema: PAYLOAD_SCHEMA, followsLatest: false };

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

const BY_REFERENCE = { contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } };

describe('compile — the frozen trigger open-time bindings', () => {
  it('freezes `openBindings` beside `resolved` and `userIdentity` for a BY-REFERENCE schema', () => {
    const config = compiledOrThrow(
      graph(BY_REFERENCE),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: IDENTITY, openBindings: OPEN_BINDINGS } }),
    );

    expect(triggerContextSchemaOf(config)).toEqual({
      contextSchemaId: 'schema-1',
      versionNumber: 2,
      resolved: PAYLOAD_SCHEMA,
      userIdentity: IDENTITY,
      openBindings: OPEN_BINDINGS,
    });
  });

  it('freezes it the same way beside an INLINE-authored schema — the authoring shape is not the rule', () => {
    const inline = { type: 'object', properties: { encounter: { type: 'object' } } };
    const config = compiledOrThrow(
      graph({ contextSchema: { inline } }),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, openBindings: OPEN_BINDINGS } }),
    );

    expect(triggerContextSchemaOf(config)).toEqual({ inline, resolved: PAYLOAD_SCHEMA, openBindings: OPEN_BINDINGS });
  });

  it('freezes bindings with NO identity — the five roles are independent of each other', () => {
    const routingOnly: CompiledOpenBindings = { department: { kindKey: 'encounter', field: 'department_code', by: 'name' } };
    const config = compiledOrThrow(
      graph(BY_REFERENCE),
      baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: null, openBindings: routingOnly } }),
    );

    expect(triggerContextSchemaOf(config)).not.toHaveProperty('userIdentity');
    expect(triggerContextSchemaOf(config).openBindings).toEqual(routingOnly);
  });

  it('stamps NO key when the resolution carries none — absent, never null', () => {
    const config = compiledOrThrow(graph(BY_REFERENCE), baseCtx({ triggerContextSchema: { ...RESOLUTION, openBindings: null } }));

    expect(triggerContextSchemaOf(config)).not.toHaveProperty('openBindings');
    expect(triggerContextSchemaOf(config).resolved).toEqual(PAYLOAD_SCHEMA);
  });

  it('stamps NO key for a caller that predates the field — byte-identical legacy artifacts', () => {
    const config = compiledOrThrow(graph(BY_REFERENCE), baseCtx({ triggerContextSchema: RESOLUTION }));

    expect(triggerContextSchemaOf(config)).not.toHaveProperty('openBindings');
  });

  it('leaves an INLINE schema with no resolution exactly as authored — the compiler derives nothing itself', () => {
    const inline = { type: 'object', properties: { encounter: { type: 'object' } } };
    const config = compiledOrThrow(graph({ contextSchema: { inline } }), baseCtx());

    expect(triggerContextSchemaOf(config)).toEqual({ inline });
  });

  it('changes the checksum only when bindings are actually frozen', () => {
    const bare = compiledOrThrow(graph(BY_REFERENCE), baseCtx({ triggerContextSchema: RESOLUTION })).checksum;
    const bareAgain = compiledOrThrow(graph(BY_REFERENCE), baseCtx({ triggerContextSchema: { ...RESOLUTION, openBindings: null } })).checksum;
    const bound = compiledOrThrow(graph(BY_REFERENCE), baseCtx({ triggerContextSchema: { ...RESOLUTION, openBindings: OPEN_BINDINGS } })).checksum;

    expect(bareAgain).toBe(bare);
    expect(bound).not.toBe(bare);
  });

  it('does not disturb the `userIdentity` freeze — the two keys are stamped independently', () => {
    const identityOnly = compiledOrThrow(graph(BY_REFERENCE), baseCtx({ triggerContextSchema: { ...RESOLUTION, userIdentity: IDENTITY } }));

    expect(triggerContextSchemaOf(identityOnly)).toEqual({
      contextSchemaId: 'schema-1',
      versionNumber: 2,
      resolved: PAYLOAD_SCHEMA,
      userIdentity: IDENTITY,
    });
  });
});
