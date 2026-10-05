/**
 * TASK-1036 §3.6 / lane C4 — the Input and Output shape summaries the Integration tab prints.
 *
 * They are derived from the workflow's CONTEXT SCHEMA definition (`kinds` / `outputs`, or an
 * inline payload schema) and from nothing else, so a developer reading the tab and a run being
 * validated agree on the contract. The cases pin the three things a hand-written summary gets
 * wrong: PHI is the KIND's class (inherited by its fields), audio kinds carry their delivery
 * (stream unless they say blob; outputs default to blob), and a missing schema is "not declared"
 * rather than an empty object that reads as "this takes nothing".
 */
import { describe, expect, it } from 'vitest';
import { deriveRunShapes } from '../run-shapes';

const DEFINITION = {
  schemaVersion: 1,
  kinds: [
    {
      key: 'patient',
      label: 'Patient',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      required: true,
      fields: { type: 'object', required: ['age'], properties: { age: { type: 'integer' }, ward: { type: 'string' } } },
    },
    { key: 'message', label: 'Message', primitive: 'TEXT', phiClass: 'NON_PHI', required: true },
    { key: 'consult_audio', label: 'Audio', primitive: 'STREAM_AUDIO', phiClass: 'PHI' },
    { key: 'scan', label: 'Scan', primitive: 'DOCUMENT', phiClass: 'PHI' },
  ],
  outputs: [
    { key: 'note', label: 'Note', primitive: 'TEXT' },
    { key: 'voice', label: 'Voice', primitive: 'STREAM_AUDIO' },
    { key: 'spoken', label: 'Spoken', primitive: 'STREAM_AUDIO', delivery: 'stream' },
  ],
};

describe('deriveRunShapes — a context-schema definition', () => {
  const shapes = deriveRunShapes(DEFINITION);

  it('lists each kind, then the declared fields of a structured one, with required and PHI', () => {
    const byPath = Object.fromEntries(shapes.input.map((row) => [row.path, row]));
    expect(byPath['patient']).toMatchObject({ type: 'STRUCTURED', required: true, phi: 'PHI' });
    expect(byPath['patient.age']).toMatchObject({ type: 'integer', required: true, phi: 'PHI' });
    expect(byPath['patient.ward']).toMatchObject({ type: 'string', required: false, phi: 'PHI' });
    expect(byPath['message']).toMatchObject({ type: 'TEXT', required: true, phi: 'NON_PHI' });
  });

  it('marks audio delivery: an input streams by default, an output is a blob by default', () => {
    expect(shapes.input.find((row) => row.path === 'consult_audio')?.delivery).toBe('stream');
    expect(shapes.output.find((row) => row.path === 'voice')?.delivery).toBe('blob');
    expect(shapes.output.find((row) => row.path === 'spoken')?.delivery).toBe('stream');
  });

  it('says what the caller has to DO differently: stream audio, blob upload', () => {
    expect(shapes.streamAudioIn).toBe(true);
    expect(shapes.attachmentsIn).toBe(true);
    expect(shapes.streamAudioOut).toBe(true);
  });

  it('builds an example input from the REQUIRED kinds only and never invents the audio', () => {
    expect(shapes.exampleInput).toEqual({ patient: { age: 0 }, message: '…' });
  });

  it('lists the declared outputs', () => {
    expect(shapes.output.map((row) => row.path)).toEqual(['note', 'voice', 'spoken']);
  });
});

describe('deriveRunShapes — an inline payload schema', () => {
  it('reads the properties one level deep, with no PHI class (an inline schema declares none)', () => {
    const shapes = deriveRunShapes({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, tone: { type: 'string' } } });
    expect(shapes.input.map((row) => [row.path, row.required, row.phi])).toEqual([
      ['text', true, null],
      ['tone', false, null],
    ]);
    expect(shapes.output).toEqual([]);
    expect(shapes.exampleInput).toEqual({ text: '…' });
  });
});

describe('deriveRunShapes — nothing declared', () => {
  it.each([[null], [undefined], [{}], ['nope']])('%j yields empty shapes, not a fabricated one', (schema) => {
    const shapes = deriveRunShapes(schema);
    expect(shapes.input).toEqual([]);
    expect(shapes.output).toEqual([]);
    expect(shapes.exampleInput).toBeNull();
    expect(shapes.streamAudioIn).toBe(false);
  });
});
