/**
 * the port type vocabulary and its compatibility lattice.
 *
 * The vocabulary is CLOSED and it REFINES `CONTEXT_PRIMITIVES`
 * (`packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:35`
 * = `['STREAM_AUDIO','TEXT','DOCUMENT','IMAGE','STRUCTURED']`), so "an input is any variable in
 * the context object" is both EXPRESSIBLE and CHECKABLE. This package has zero runtime
 * dependencies, so it cannot import that constant — the bridge is asserted here instead.
 *
 * The lattice is what makes the anti-hallucination-laundering rule STRUCTURAL rather than a
 * lint: `transcript` and `document` are SIBLINGS under `text`, so neither satisfies the other,
 * and widening a document to `text` can never reach a `transcript` consumer. See
 * `anti-laundering.test.ts` for that rule stated on its own terms.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PRIMITIVES_MIRROR,
  PORT_PRIMITIVE_CONTEXT_PRIMITIVE,
  WORKFLOW_PORT_PRIMITIVES,
  WORKFLOW_PORT_SUPERTYPE,
  portPrimitiveSatisfies,
} from '../port-model';
import type { WorkflowPortPrimitive } from '../port-model';

describe('WORKFLOW_PORT_PRIMITIVES', () => {
  // extended the vocabulary by TWO: `object` (the unrefined STRUCTURED type the generic
  // agentic nodes' tenant-defined schemas need) and `audio` (a STORED artifact, sibling to the
  // live `stream<audio>`). See `port-model.ts`'s `WORKFLOW_PORT_KINDS` docstring and
  // `port-kinds.task847.test.ts` for why each addition cannot weaken the lattice.
  it('is the closed vocabulary settles, plus `control` for ordering edges', () => {
    expect([...WORKFLOW_PORT_PRIMITIVES].sort()).toEqual(
      // `any` (TASK-864) is the consumer-side wildcard for the `core` vocabulary — see
      // `ANY_PORT_PRIMITIVE` in `port-model.ts` and `core-any-wildcard.test.ts`.
      ['any', 'audio', 'context<schemaRef>', 'control', 'document', 'edits', 'entities', 'object', 'stream<audio>', 'text', 'transcript', 'verdict'],
    );
  });

  it('declares a direct supertype (or null) for every member — the lattice is total', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(Object.hasOwn(WORKFLOW_PORT_SUPERTYPE, primitive)).toBe(true);
    }
  });

  // SIX widening pairs after, and the split matters: TWO into `text` (a transcript and
  // a generated document are both text) and FOUR into `object` (every STRUCTURED refinement is
  // an object). What has NOT changed is that widening only ever goes specific -> general, so no
  // pair here can launder provenance: nothing widens INTO `transcript`, `entities`, `document`
  // or any other refinement, in either group.
  it('widens only specific -> general: two pairs into `text`, four into `object`', () => {
    const widenings = Object.entries(WORKFLOW_PORT_SUPERTYPE)
      .filter(([, parent]) => parent !== null)
      .sort();
    expect(widenings).toEqual([
      ['context<schemaRef>', 'object'],
      ['document', 'text'],
      ['edits', 'object'],
      ['entities', 'object'],
      ['transcript', 'text'],
      ['verdict', 'object'],
    ]);
    // The safety half, stated as its own assertion rather than left implicit: the only two
    // widening TARGETS are the two general types. A refinement is never a target.
    expect([...new Set(widenings.map(([, parent]) => parent))].sort()).toEqual(['object', 'text']);
  });

  it('the lattice is acyclic and bottoms out (no supertype chain loops)', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      const seen = new Set<string>();
      let cursor: WorkflowPortPrimitive | null = primitive;
      while (cursor !== null) {
        expect(seen.has(cursor)).toBe(false);
        seen.add(cursor);
        cursor = WORKFLOW_PORT_SUPERTYPE[cursor];
      }
    }
  });
});

describe('portPrimitiveSatisfies (produced -> consumed)', () => {
  it('is reflexive for every member', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(portPrimitiveSatisfies(primitive, primitive)).toBe(true);
    }
  });

  it('widens specific -> general', () => {
    expect(portPrimitiveSatisfies('transcript', 'text')).toBe(true);
    expect(portPrimitiveSatisfies('document', 'text')).toBe(true);
  });

  it('NEVER narrows general -> specific', () => {
    expect(portPrimitiveSatisfies('text', 'transcript')).toBe(false);
    expect(portPrimitiveSatisfies('text', 'document')).toBe(false);
  });

  it('NEVER crosses siblings — transcript and document are incomparable', () => {
    expect(portPrimitiveSatisfies('document', 'transcript')).toBe(false);
    expect(portPrimitiveSatisfies('transcript', 'document')).toBe(false);
  });

  // The four STRUCTURED refinements are no longer "unrelated to everything": widened
  // each of them to `object`. They stay mutually incompatible with each OTHER and with every
  // member of the text and audio groups, which is the property this test is actually about — an
  // `entities` producer must still never satisfy an `edits` consumer. `object` is excluded from
  // the sweep for each of them, and only `object`.
  it('keeps every unrelated primitive mutually incompatible', () => {
    const unrelated: readonly WorkflowPortPrimitive[] = ['control', 'stream<audio>', 'audio', 'entities', 'edits', 'verdict', 'context<schemaRef>'];
    const widensTo: Partial<Record<WorkflowPortPrimitive, WorkflowPortPrimitive>> = {
      entities: 'object',
      edits: 'object',
      verdict: 'object',
      'context<schemaRef>': 'object',
    };
    for (const a of unrelated) {
      for (const b of WORKFLOW_PORT_PRIMITIVES) {
        if (a === b) continue;
        // `any` is a CONSUMER-side wildcard (TASK-864): every data primitive satisfies it, and it
        // satisfies nothing but itself. Its own test is `core-any-wildcard.test.ts`.
        if (b === 'any') {
          expect(portPrimitiveSatisfies(a, b)).toBe(a !== 'control');
          expect(portPrimitiveSatisfies(b, a)).toBe(false);
          continue;
        }
        if (widensTo[a] === b) {
          // The ONE permitted direction, asserted rather than skipped.
          expect(portPrimitiveSatisfies(a, b)).toBe(true);
          expect(portPrimitiveSatisfies(b, a)).toBe(false);
          continue;
        }
        expect(portPrimitiveSatisfies(a, b)).toBe(false);
        expect(portPrimitiveSatisfies(b, a)).toBe(false);
      }
    }
  });

  it('a control edge can never carry data, and data can never satisfy a control input', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      if (primitive === 'control') continue;
      expect(portPrimitiveSatisfies('control', primitive)).toBe(false);
      expect(portPrimitiveSatisfies(primitive, 'control')).toBe(false);
    }
  });
});

describe('the CONTEXT_PRIMITIVES bridge', () => {
  it('maps every port primitive onto exactly one CONTEXT_PRIMITIVES member (or CONTROL)', () => {
    const allowed = new Set<string>([...CONTEXT_PRIMITIVES_MIRROR, 'CONTROL']);
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(allowed.has(PORT_PRIMITIVE_CONTEXT_PRIMITIVE[primitive])).toBe(true);
    }
  });

  it('mirrors the closed CONTEXT_PRIMITIVES set verbatim', () => {
    expect([...CONTEXT_PRIMITIVES_MIRROR]).toEqual(['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED']);
  });

  it('refines TEXT into transcript/text and STRUCTURED into the four structured ports', () => {
    expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE.transcript).toBe('TEXT');
    expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE.text).toBe('TEXT');
    expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE.document).toBe('DOCUMENT');
    expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE['stream<audio>']).toBe('STREAM_AUDIO');
    for (const structured of ['entities', 'edits', 'verdict', 'context<schemaRef>'] as const) {
      expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE[structured]).toBe('STRUCTURED');
    }
  });

  it('IMAGE has no standalone port type — an image context variable travels inside context<schemaRef>', () => {
    const covered = new Set(Object.values(PORT_PRIMITIVE_CONTEXT_PRIMITIVE));
    expect(covered.has('IMAGE')).toBe(false);
    expect(covered.has('STRUCTURED')).toBe(true);
  });
});
