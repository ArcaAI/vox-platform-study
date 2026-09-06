/**
 * step 7 — TIER 2, and the whole point of it is what it does NOT do.
 *
 * > *Shallow structural (required props, one level of primitive types): **warning only, never
 * > blocking.** Skip `oneOf`/`allOf`/patterns entirely. A validator that cries wolf is the most
 * > hated feature you can ship.*
 *
 * So this file asserts the restraint as hard as it asserts the detection: every finding is a
 * WARNING, the walk stops after one level, and a schema using a composition keyword is skipped
 * outright rather than guessed at. A tier-2 finding that blocks a publish is a defect, and the
 * tests below are what make that statement checkable rather than aspirational.
 *
 * The escape hatch is in the message: when tier 2 warns, the fix is a `agentic.data` node on the
 * edge, which is exactly what that node type is for.
 */
import { describe, expect, it } from 'vitest';
import * as schemaCompat from '../schema-compat';

const { schemaCompatWarnings, workflowEdgeSchemaWarnings } = schemaCompat;

const PRODUCER = {
  type: 'object',
  properties: { note: { type: 'string' }, count: { type: 'integer' } },
  required: ['note'],
};

describe(' tier 2 — shallow structural compatibility', () => {
  it('says nothing when the producer satisfies the consumer', () => {
    expect(schemaCompatWarnings(PRODUCER, { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] })).toEqual([]);
  });

  it('WARNS about a required property the producer does not declare', () => {
    const warnings = schemaCompatWarnings(PRODUCER, { type: 'object', properties: { patientId: { type: 'string' } }, required: ['patientId'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('patientId');
    // The escape hatch, named in the message — a warning with no remedy is just noise.
    expect(warnings[0]).toContain('agentic.data');
  });

  it('WARNS about a one-level primitive type mismatch', () => {
    const warnings = schemaCompatWarnings(PRODUCER, { type: 'object', properties: { count: { type: 'string' } }, required: ['count'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('count');
  });

  it('does NOT descend past one level — a nested mismatch is tier 3`s job, at run time', () => {
    const nestedProducer = {
      type: 'object',
      properties: { patient: { type: 'object', properties: { id: { type: 'integer' } } } },
      required: ['patient'],
    };
    const nestedConsumer = {
      type: 'object',
      properties: { patient: { type: 'object', properties: { id: { type: 'string' } } } },
      required: ['patient'],
    };
    expect(schemaCompatWarnings(nestedProducer, nestedConsumer)).toEqual([]);
  });

  it('SKIPS a schema using a composition keyword entirely, rather than guessing', () => {
    // `oneOf`/`allOf`/`anyOf`/`if` change what "required" and "type" even mean. A shallow
    // reader that ignores them reports confident nonsense, which is precisely the cried wolf.
    for (const keyword of ['oneOf', 'allOf', 'anyOf', 'if'] as const) {
      expect(schemaCompatWarnings(PRODUCER, { type: 'object', [keyword]: [{ type: 'object' }], required: ['ghost'] })).toEqual([]);
      expect(schemaCompatWarnings({ ...PRODUCER, [keyword]: [{ type: 'object' }] }, { type: 'object', required: ['ghost'] })).toEqual([]);
    }
  });

  it('SKIPS `patternProperties` — a pattern can satisfy a name this reader cannot predict', () => {
    expect(
      schemaCompatWarnings({ type: 'object', patternProperties: { '^p_': { type: 'string' } } }, { type: 'object', required: ['p_id'] }),
    ).toEqual([]);
  });

  it('says nothing when either side declares no schema — absence is not a mismatch', () => {
    expect(schemaCompatWarnings(undefined, PRODUCER)).toEqual([]);
    expect(schemaCompatWarnings(PRODUCER, undefined)).toEqual([]);
    expect(schemaCompatWarnings({ type: 'object' }, { type: 'object' })).toEqual([]);
  });
});

describe(' tier 2 — over a graph', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'in_node', type: 'agentic.input', config: { ioSchema: PRODUCER } },
      {
        id: 'out_node',
        type: 'agentic.output',
        config: { ioSchema: { type: 'object', properties: { patientId: { type: 'string' } }, required: ['patientId'] } },
      },
      {
        id: 'ok_node',
        type: 'agentic.output',
        config: { ioSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
      },
    ],
    edges: [
      { id: 'e1', from: 'in_node', to: 'out_node', fromPort: 'out', toPort: 'in' },
      { id: 'e2', from: 'in_node', to: 'ok_node', fromPort: 'out', toPort: 'in' },
    ],
  };

  it('attributes each warning to the EDGE, so the canvas can draw it where the problem is', () => {
    const findings = workflowEdgeSchemaWarnings(graph as never);
    expect(findings).toHaveLength(1);
    expect(findings[0].edgeId).toBe('e1');
    expect(findings[0].message).toContain('patientId');
  });

  it('emits WARNING severity and NOTHING else — tier 2 never blocks a publish', () => {
    for (const finding of workflowEdgeSchemaWarnings(graph as never)) {
      expect(finding.severity).toBe('WARNING');
    }
  });

  it('ignores CONTROL edges — an ordering edge carries no payload to mismatch', () => {
    const controlOnly = {
      version: 1,
      nodes: graph.nodes,
      edges: [{ id: 'c1', from: 'in_node', to: 'out_node', fromPort: 'next', toPort: 'after' }],
    };
    expect(workflowEdgeSchemaWarnings(controlOnly as never)).toEqual([]);
  });
});
