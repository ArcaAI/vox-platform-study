/**
 * Port-type compatibility (TASK-809 Task 12). `portPrimitiveSatisfies` pins the lattice
 * verbatim against `@arcaai/workflow-contract`'s `port-model.ts` (the console hand-mirrors it —
 * see `port-compatibility.ts`'s module comment); `checkPortCompatibility` is the predicate the
 * Studio canvas wires into both drag-time (`isValidConnection`) and commit-time (`connect`).
 */
import { describe, expect, it } from 'vitest';
import { checkPortCompatibility, portPrimitiveSatisfies } from '../port-compatibility';
import type { WorkflowNodeDescriptor } from '../../api/types';

function descriptor(type: string, inputs: WorkflowNodeDescriptor['inputs'], outputs: WorkflowNodeDescriptor['outputs']): WorkflowNodeDescriptor {
  return {
    type,
    implemented: true,
    activityName: type,
    classes: [],
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    configSchema: null,
    inputs,
    outputs,
  };
}

// The two real registry node types the anti-laundering case is stated in terms of
// (`node-ports.ts:150,170`): a generation node's `out` produces `document`, NER's `in` consumes
// `transcript`.
const SYNTHESIZE = descriptor('consultation.synthesize', [{ name: 'in', primitive: 'text', required: true, multiple: true }], [
  { name: 'out', primitive: 'document', required: true, multiple: true },
]);
const EXTRACT_ENTITIES = descriptor(
  'consultation.extractEntities',
  [{ name: 'in', primitive: 'transcript', required: true, multiple: false }],
  [{ name: 'out', primitive: 'entities', required: true, multiple: true }],
);
const CAPTURE_BINDING = descriptor('consultation.captureBinding', [], [{ name: 'out', primitive: 'transcript', required: true, multiple: true }]);
const GUARDRAIL_CHECK = descriptor(
  'guardrail.check',
  [{ name: 'in', primitive: 'text', required: true, multiple: false }],
  [{ name: 'out', primitive: 'verdict', required: true, multiple: true }],
);

describe('portPrimitiveSatisfies', () => {
  it('is reflexive: every primitive satisfies itself', () => {
    expect(portPrimitiveSatisfies('text', 'text')).toBe(true);
    expect(portPrimitiveSatisfies('control', 'control')).toBe(true);
  });

  it('widens transcript -> text and document -> text (the two declared widenings)', () => {
    expect(portPrimitiveSatisfies('transcript', 'text')).toBe(true);
    expect(portPrimitiveSatisfies('document', 'text')).toBe(true);
  });

  it('never widens the other direction: text does not satisfy transcript or document', () => {
    expect(portPrimitiveSatisfies('text', 'transcript')).toBe(false);
    expect(portPrimitiveSatisfies('text', 'document')).toBe(false);
  });

  it('transcript and document are SIBLINGS — neither satisfies the other', () => {
    expect(portPrimitiveSatisfies('transcript', 'document')).toBe(false);
    expect(portPrimitiveSatisfies('document', 'transcript')).toBe(false);
  });

  it('unrelated primitives never satisfy each other', () => {
    expect(portPrimitiveSatisfies('entities', 'verdict')).toBe(false);
    expect(portPrimitiveSatisfies('stream<audio>', 'text')).toBe(false);
    expect(portPrimitiveSatisfies('control', 'text')).toBe(false);
  });
});

describe('checkPortCompatibility', () => {
  it('allows an exact primitive match', () => {
    const result = checkPortCompatibility(
      new Map([
        ['consultation.captureBinding', CAPTURE_BINDING],
        ['consultation.extractEntities', EXTRACT_ENTITIES],
      ]),
      { type: 'consultation.captureBinding', handle: 'out' },
      { type: 'consultation.extractEntities', handle: 'in' },
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows a widened connection (document -> text)', () => {
    const result = checkPortCompatibility(
      new Map([
        ['consultation.synthesize', SYNTHESIZE],
        ['guardrail.check', GUARDRAIL_CHECK],
      ]),
      { type: 'consultation.synthesize', handle: 'out' },
      { type: 'guardrail.check', handle: 'in' },
    );
    expect(result).toEqual({ ok: true });
  });

  // The anti-hallucination-laundering rule made structural (TASK-809 §2b / port-model.ts):
  // a generated document must never reach the NER node's transcript input.
  it('ANTI-LAUNDERING: refuses document -> ner (consultation.synthesize.out -> consultation.extractEntities.in)', () => {
    const result = checkPortCompatibility(
      new Map([
        ['consultation.synthesize', SYNTHESIZE],
        ['consultation.extractEntities', EXTRACT_ENTITIES],
      ]),
      { type: 'consultation.synthesize', handle: 'out' },
      { type: 'consultation.extractEntities', handle: 'in' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('`document`');
      expect(result.reason).toContain('`transcript`');
    }
  });

  it('refuses when the source node type is not in the registry', () => {
    const result = checkPortCompatibility(new Map([['consultation.extractEntities', EXTRACT_ENTITIES]]), { type: 'unknown.type', handle: 'out' }, {
      type: 'consultation.extractEntities',
      handle: 'in',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown\.type/);
  });

  it('refuses when the source has no output port with that name', () => {
    const result = checkPortCompatibility(
      new Map([
        ['consultation.captureBinding', CAPTURE_BINDING],
        ['consultation.extractEntities', EXTRACT_ENTITIES],
      ]),
      { type: 'consultation.captureBinding', handle: 'missing' },
      { type: 'consultation.extractEntities', handle: 'in' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing/);
  });

  it('refuses when the target has no input port with that name', () => {
    const result = checkPortCompatibility(
      new Map([
        ['consultation.captureBinding', CAPTURE_BINDING],
        ['consultation.extractEntities', EXTRACT_ENTITIES],
      ]),
      { type: 'consultation.captureBinding', handle: 'out' },
      { type: 'consultation.extractEntities', handle: 'missing' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing/);
  });
});
