/**
 * TASK-890 black-box J4-F4 — a trigger bound to a REFERENCED context schema must publish a TYPED
 * Input contract.
 *
 * The Studio's `ContextSchemaRefField` authors a reference (`contextSchema.contextSchemaId`),
 * never an inline schema; the publish path resolves it and freezes the derived payload schema
 * into the compiled trigger node (`compiler.ts#compiledConfigFor`). The exposure plane, however,
 * read only the AUTHORED graph — so `GET /workflows/{slug}/schema` and the catalogue's
 * `inputSchema` answered an open `{ type: 'object', additionalProperties: true }` for exactly the
 * binding the console makes easiest to create.
 *
 * This is a READ-side fix on bytes publish already wrote: an already-published definition whose
 * `compiledConfig` carries `contextSchema.resolved` becomes typed with no republish.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowExposureDtoMapper } from '../workflow-exposure.dto.mapper';
import { componentName, describeWorkflow } from '../workflow-schema-description';

const RESOLVED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { consultation_note: { type: 'object' } },
  required: ['consultation_note'],
};
const INLINE_SCHEMA = { type: 'object', properties: { patientId: { type: 'string' } } };
const OUTPUT_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } } };

/** The AUTHORED graph of a reference-bound trigger — no inline schema anywhere in it. */
const REFERENCE_GRAPH = {
  nodes: [
    { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'], contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } } },
    { id: 'n_output', type: 'core.output', config: { protocols: ['http'], outputSchema: OUTPUT_SCHEMA } },
  ],
};

/** What publish froze for that graph. */
const COMPILED_CONFIG = {
  formatVersion: 1,
  stages: [
    {
      stageIndex: 0,
      nodes: [
        {
          nodeId: 'n_trigger',
          type: 'core.trigger',
          activity: 'interpreter.core_trigger',
          config: { kinds: ['api'], contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2, resolved: RESOLVED_SCHEMA } },
        },
      ],
    },
  ],
  gates: [],
};

function definition(over: Record<string, unknown> = {}) {
  return {
    id: 'def-1',
    tenantId: 'tenant-1',
    slug: 'triage',
    name: 'Triage',
    description: null,
    paletteKey: 'core',
    versionNumber: 4,
    graph: REFERENCE_GRAPH,
    compiledConfig: COMPILED_CONFIG,
    ...over,
  } as never;
}

describe('describeWorkflow — the resolved reference types the Input component', () => {
  it('serves the frozen payload schema for a reference-bound trigger', () => {
    const described = describeWorkflow('triage', 4, REFERENCE_GRAPH, COMPILED_CONFIG);
    expect(described.components[componentName('triage', 'Input')]).toMatchObject(RESOLVED_SCHEMA);
  });

  it('answers the open object schema when nothing is bound or frozen', () => {
    const described = describeWorkflow('triage', 4, REFERENCE_GRAPH);
    expect(described.components[componentName('triage', 'Input')]).toMatchObject({ type: 'object', additionalProperties: true });
  });

  it('still prefers an authored inline schema when the definition has one', () => {
    const graph = { nodes: [{ id: 'n_trigger', type: 'core.trigger', config: { contextSchema: { inline: INLINE_SCHEMA } } }] };
    expect(describeWorkflow('triage', 4, graph).components[componentName('triage', 'Input')]).toMatchObject(INLINE_SCHEMA);
  });
});

describe('WorkflowExposureDtoMapper.toSummaryResponse — the catalogue agrees with the schema route', () => {
  it('carries the resolved input schema of a reference-bound trigger', () => {
    const summary = WorkflowExposureDtoMapper.toSummaryResponse(definition());

    expect(summary.inputSchema).toEqual(RESOLVED_SCHEMA);
    expect(summary.outputSchema).toEqual(OUTPUT_SCHEMA);
    expect(summary.inputSchema).toEqual(
      // the same bytes `GET {slug}/schema` serves, minus the component's title/description
      describeWorkflow('triage', 4, REFERENCE_GRAPH, COMPILED_CONFIG).components[componentName('triage', 'Input')]!.properties
        ? RESOLVED_SCHEMA
        : null,
    );
  });

  it('is null for a definition whose compiled config froze nothing', () => {
    expect(WorkflowExposureDtoMapper.toSummaryResponse(definition({ compiledConfig: null })).inputSchema).toBeNull();
  });
});
