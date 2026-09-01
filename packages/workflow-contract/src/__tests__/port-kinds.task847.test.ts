/**
 * TASK-847 step 7, TIER 1 — the blocking kind check, and the two port primitives the generic
 * (`agentic`) node types need in order to be typed at all.
 *
 * `object` and `audio` are ADDITIONS to a closed vocabulary, so this file asserts three things
 * that together make the addition safe rather than merely present:
 *
 *  1. the two new members exist and carry the right `CONTEXT_PRIMITIVES` refinement;
 *  2. the FOUR existing STRUCTURED refinements widen to `object` — a widening, never a
 *     narrowing, so nothing that was refused becomes permitted in the dangerous direction; and
 *  3. `stream<audio>` and `audio` are SIBLINGS. A live capture stream is not a stored artifact:
 *     the batch transcriber cannot be handed a stream, and that boundary is exactly the
 *     determinism boundary rule 06 draws (no per-frame audio inside a Temporal workflow).
 *
 * Tier 1 itself is `portKindOf` — the five-kind projection (`text | object | audio | flag |
 * control`) the Studio's `isValidConnection` can compute at zero cost. It is DELIBERATELY
 * coarser than `portPrimitiveSatisfies`, which stays the publish-time gate: a kind check that
 * passed must never be read as "this edge is legal".
 */
import { describe, expect, it } from 'vitest';
// A NAMESPACE import on purpose. A named import of a symbol the module does not export yet is a
// module-LINK failure under this vitest, which manifests as a hung worker rather than a readable
// red test — so the RED half of this ticket's TDD loop would have been unobservable. Reading the
// symbols off the namespace turns "not exported yet" into an ordinary assertion failure.
import * as portModel from '../port-model';

const {
  PORT_PRIMITIVE_CONTEXT_PRIMITIVE,
  WORKFLOW_PORT_KINDS,
  WORKFLOW_PORT_PRIMITIVES,
  WORKFLOW_PORT_SUPERTYPE,
  portKindOf,
  portKindsCompatible,
  portPrimitiveSatisfies,
} = portModel;

describe('TASK-847 — the two new port primitives', () => {
  it('adds `object` and `audio` to the closed vocabulary', () => {
    expect(WORKFLOW_PORT_PRIMITIVES).toContain('object');
    expect(WORKFLOW_PORT_PRIMITIVES).toContain('audio');
  });

  it('refines the right CONTEXT_PRIMITIVES member', () => {
    expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE.object).toBe('STRUCTURED');
    expect(PORT_PRIMITIVE_CONTEXT_PRIMITIVE.audio).toBe('STREAM_AUDIO');
  });

  it('widens every STRUCTURED refinement to `object`', () => {
    const structuredRefinements = ['entities', 'edits', 'verdict', 'context<schemaRef>'] as const;
    for (const structured of structuredRefinements) {
      expect(WORKFLOW_PORT_SUPERTYPE[structured]).toBe('object');
      expect(portPrimitiveSatisfies(structured, 'object')).toBe(true);
      // ...and never the other way: `object` is not substitutable for a refinement.
      expect(portPrimitiveSatisfies('object', structured)).toBe(false);
    }
  });

  it('keeps `audio` and `stream<audio>` as siblings — a stream is not a stored artifact', () => {
    expect(portPrimitiveSatisfies('stream<audio>', 'audio')).toBe(false);
    expect(portPrimitiveSatisfies('audio', 'stream<audio>')).toBe(false);
  });

  it('never lets `object` launder a generated document back into a transcript', () => {
    expect(portPrimitiveSatisfies('document', 'transcript')).toBe(false);
    expect(portPrimitiveSatisfies('object', 'transcript')).toBe(false);
    expect(portPrimitiveSatisfies('object', 'text')).toBe(false);
  });
});

describe('TASK-847 tier 1 — the kind projection', () => {
  it('projects every primitive onto exactly one of the five kinds', () => {
    for (const primitive of WORKFLOW_PORT_PRIMITIVES) {
      expect(WORKFLOW_PORT_KINDS).toContain(portKindOf(primitive));
    }
  });

  it('maps the vocabulary onto the kinds the ticket names', () => {
    expect(portKindOf('text')).toBe('text');
    expect(portKindOf('transcript')).toBe('text');
    expect(portKindOf('document')).toBe('text');
    expect(portKindOf('object')).toBe('object');
    expect(portKindOf('entities')).toBe('object');
    expect(portKindOf('context<schemaRef>')).toBe('object');
    expect(portKindOf('edits')).toBe('object');
    expect(portKindOf('verdict')).toBe('flag');
    expect(portKindOf('audio')).toBe('audio');
    expect(portKindOf('stream<audio>')).toBe('audio');
    expect(portKindOf('control')).toBe('control');
  });

  it('is coarser than the lattice — it admits edges the publish gate still refuses', () => {
    // `text -> transcript` is a KIND match and a LATTICE error. Tier 1 is a cheap pre-filter,
    // never the authority; asserting it here is what stops anyone promoting it to one.
    expect(portKindsCompatible('text', 'transcript')).toBe(true);
    expect(portPrimitiveSatisfies('text', 'transcript')).toBe(false);
  });

  it('refuses a cross-kind edge, which is the ~80% tier 1 exists to catch', () => {
    expect(portKindsCompatible('audio', 'text')).toBe(false);
    expect(portKindsCompatible('object', 'text')).toBe(false);
    expect(portKindsCompatible('control', 'text')).toBe(false);
    expect(portKindsCompatible('text', 'control')).toBe(false);
  });
});
