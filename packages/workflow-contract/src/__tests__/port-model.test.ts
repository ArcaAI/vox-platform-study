/**
 * TASK-809 Task 2 — the port type vocabulary and its compatibility lattice.
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
  it('is the closed vocabulary TASK-809 §2b settles, plus `control` for ordering edges', () => {
    expect([...WORKFLOW_PORT_PRIMITIVES].sort()).toEqual(
      ['context<schemaRef>', 'control', 'document', 'edits', 'entities', 'stream<audio>', 'text', 'transcript', 'verdict'].sort(),
    );
  });

  it('declares a direct supertype (or null) for every member — the lattice is total', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(Object.hasOwn(WORKFLOW_PORT_SUPERTYPE, primitive)).toBe(true);
    }
  });

  it('has exactly two widening pairs: transcript -> text and document -> text', () => {
    const widenings = Object.entries(WORKFLOW_PORT_SUPERTYPE)
      .filter(([, parent]) => parent !== null)
      .sort();
    expect(widenings).toEqual([
      ['document', 'text'],
      ['transcript', 'text'],
    ]);
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

  it('keeps every unrelated primitive mutually incompatible', () => {
    const unrelated: readonly WorkflowPortPrimitive[] = ['control', 'stream<audio>', 'entities', 'edits', 'verdict', 'context<schemaRef>'];
    for (const a of unrelated) {
      for (const b of WORKFLOW_PORT_PRIMITIVES) {
        if (a === b) continue;
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
