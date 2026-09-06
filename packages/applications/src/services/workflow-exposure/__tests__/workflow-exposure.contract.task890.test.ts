/**
 * TASK-890 L7 — the WORKFLOW CONTRACT on the exposure plane.
 *
 * `GET /api/v1/workflows` used to answer identity only ("no `inputSchema` field, because none
 * is declared anywhere in the substrate yet" — the DTO's own comment). `core.trigger` /
 * `core.output` DO declare one now (`declaredIoSchemas`, `core-contract.ts`), and
 * `describeWorkflow` has been computing it per definition since TASK-864. So the catalogue
 * carries it too: one list read tells an integrator what to send and what comes back, without
 * an N+1 fan-out over `GET {slug}/schema`.
 *
 * And `modesFor` stops lying about the socket lane: `describeWorkflow` already emits a
 * `ws/workflows` AsyncAPI channel when the Output declares `socket`, while `modes` named only
 * the three `?mode=` values — so a description could advertise a channel it never listed.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowExposureDtoMapper } from '../workflow-exposure.dto.mapper';
import { describeWorkflow, modesFor } from '../workflow-schema-description';

const INPUT_SCHEMA = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };
const OUTPUT_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } } };

function coreGraph(protocols: string[] = ['http', 'http-sse'], kinds: string[] = ['api', 'webhook']) {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds, contextSchema: { inline: INPUT_SCHEMA } } },
      { id: 'n_output', type: 'core.output', config: { protocols, outputSchema: OUTPUT_SCHEMA } },
    ],
    edges: [],
  };
}

function definition(over: Record<string, unknown> = {}) {
  return {
    id: 'def-1',
    tenantId: 'tenant-1',
    slug: 'triage',
    name: 'Triage',
    description: null,
    paletteKey: 'core',
    versionNumber: 4,
    graph: coreGraph(),
    ...over,
  } as never;
}

describe('WorkflowExposureDtoMapper.toSummaryResponse — the I/O contract travels with the catalogue', () => {
  it('carries inputSchema / outputSchema / protocols / triggerKinds derived from the graph', () => {
    const summary = WorkflowExposureDtoMapper.toSummaryResponse(definition());

    expect(summary.inputSchema).toEqual(INPUT_SCHEMA);
    expect(summary.outputSchema).toEqual(OUTPUT_SCHEMA);
    expect(summary.protocols).toEqual(['http', 'http-sse']);
    expect(summary.triggerKinds).toEqual(['api', 'webhook']);
  });

  it('keeps the identity fields it already answered', () => {
    const summary = WorkflowExposureDtoMapper.toSummaryResponse(definition());
    expect(summary).toMatchObject({ slug: 'triage', name: 'Triage', description: null, paletteKey: 'core', versionNumber: 4 });
  });

  it('answers null schemas and empty lists for a legacy graph rather than inventing a shape', () => {
    const summary = WorkflowExposureDtoMapper.toSummaryResponse(definition({ graph: { nodes: [{ id: 'a', type: 'core.start', config: {} }] } }));

    expect(summary.inputSchema).toBeNull();
    expect(summary.outputSchema).toBeNull();
    expect(summary.protocols).toEqual([]);
    expect(summary.triggerKinds).toEqual([]);
  });

  it('reads a null / garbled graph column as an empty graph instead of throwing', () => {
    expect(() => WorkflowExposureDtoMapper.toSummaryResponse(definition({ graph: null }))).not.toThrow();
    expect(WorkflowExposureDtoMapper.toSummaryResponse(definition({ graph: null })).protocols).toEqual([]);
  });

  it('agrees with describeWorkflow — the catalogue and GET {slug}/schema cannot disagree', () => {
    const summary = WorkflowExposureDtoMapper.toSummaryResponse(definition());
    const described = describeWorkflow('triage', 4, coreGraph());

    expect(summary.protocols).toEqual(described.protocols);
    expect(summary.triggerKinds).toEqual(described.triggerKinds);
    expect(summary.inputSchema).toEqual(described.components['Workflow_triage_Input']!.type === 'object' ? INPUT_SCHEMA : null);
  });
});

describe('modesFor — the socket lane is named, not silently dropped', () => {
  it('names socket exactly when the Output declares it', () => {
    expect(modesFor(['socket'])).toEqual(['async', 'socket']);
    expect(modesFor(['http', 'http-sse', 'socket'])).toEqual(['async', 'blocking', 'stream', 'socket']);
  });

  it('leaves the three ?mode= values unchanged', () => {
    expect(modesFor([])).toEqual(['async', 'blocking', 'stream']);
    expect(modesFor(['http'])).toEqual(['async', 'blocking']);
    expect(modesFor(['http-sse'])).toEqual(['async', 'stream']);
  });

  it('lists the socket mode for exactly the graphs describeWorkflow gives a ws channel', () => {
    const withSocket = describeWorkflow('triage', 1, coreGraph(['socket'])) as unknown as {
      modes: string[];
      asyncapi: { channels: Record<string, unknown> };
    };
    expect(withSocket.modes).toContain('socket');
    expect(Object.keys(withSocket.asyncapi.channels)).toContain('ws/workflows');

    const withoutSocket = describeWorkflow('triage', 1, coreGraph(['http-sse'])) as unknown as {
      modes: string[];
      asyncapi: { channels: Record<string, unknown> };
    };
    expect(withoutSocket.modes).not.toContain('socket');
    expect(Object.keys(withoutSocket.asyncapi.channels)).not.toContain('ws/workflows');
  });
});
