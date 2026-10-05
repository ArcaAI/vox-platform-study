/**
 * TASK-1038 (F1) — the payload-shape change of `payloadSchemaFromDefinition` keeps every SEEDED
 * context schema valid.
 *
 * Hermetic. For each seeded definition (the note context, the two ArcaAI schemas, `default_io`):
 *  - it still passes the real publish-time grammar;
 *  - the seed's COPY of the derivation equals the real one in `@arcaai/applications` (imported from
 *    source, the task-930 pattern), so the frozen `resolved` blocks the regen script writes are the
 *    bytes the gateway would derive;
 *  - the derived schema is authorable (the subset gate) and declares the SAME kind keys as before
 *    (so the context-schema impact gate sees no new key on any consumer);
 *  - STRUCTURED kinds derive byte-identically to their `fields`;
 *  - a TEXT kind accepts both a string and its legacy object form (`{ text }`), so a payload that
 *    passed before still passes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { NOTE_CONTEXT_SCHEMA_DEFINITION, payloadSchemaFromDefinition } from '../07e-consultation-note-context-schema';
import { ARCAAI_CONSULTATION_SCRIBE_DEFINITION, ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION } from '../07g-arcaai-two-schemas';
import { DEFAULT_IO_SCHEMA_DEFINITION } from '../07h-default-io-context-schema';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLICATIONS = path.resolve(HERE, '../../../../../../applications/src/services/consultation-context-schema/context-schema-definition.ts');
const SUBSET = path.resolve(HERE, '../../../../../../json-schema-subset/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const real: any = await import(/* @vite-ignore */ APPLICATIONS);
const subset: any = await import(/* @vite-ignore */ SUBSET);
/* eslint-enable @typescript-eslint/no-explicit-any */

const SEEDED: Array<[string, Record<string, unknown>]> = [
  ['consultation_note_context', NOTE_CONTEXT_SCHEMA_DEFINITION],
  ['arcaai_realtime_transcription', ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION],
  ['arcaai_consultation_scribe', ARCAAI_CONSULTATION_SCRIBE_DEFINITION],
  ['default_io', DEFAULT_IO_SCHEMA_DEFINITION],
];

type Kind = { key: string; primitive: string; fields?: unknown; cardinality: string };

describe.each(SEEDED)('%s', (_slug, definition) => {
  const kinds = definition.kinds as Kind[];
  const derived = payloadSchemaFromDefinition(definition) as { properties: Record<string, unknown> };

  it('passes the real publish-time grammar', () => {
    expect(real.contextSchemaDefinitionProblems(definition)).toEqual([]);
  });

  it('the seed copy of the derivation equals the real one', () => {
    expect(derived).toEqual(real.payloadSchemaFromDefinition(definition));
  });

  it('is authorable, and declares exactly the kind keys', () => {
    expect(subset.authorableJsonSchemaProblems(derived)).toEqual([]);
    expect(Object.keys(derived.properties)).toEqual(kinds.map((kind) => kind.key));
  });

  it('STRUCTURED kinds are their fields, verbatim', () => {
    for (const kind of kinds.filter((k) => k.primitive === 'STRUCTURED')) expect(derived.properties[kind.key], kind.key).toEqual(kind.fields);
  });

  it('a TEXT kind accepts a string AND its legacy object form', () => {
    for (const kind of kinds.filter((k) => k.primitive === 'TEXT')) {
      expect(subset.jsonSchemaValueProblems(derived, { [kind.key]: 'plain text' }), kind.key).toEqual([]);
      expect(subset.jsonSchemaValueProblems(derived, { [kind.key]: { text: 'legacy' } }), kind.key).toEqual([]);
    }
  });
});

describe('default_io — the message-plus-attachments run', () => {
  it('accepts `{ message, documents: [ref], images: [ref] }` and refuses an undeclared `attachments` key', () => {
    const schema = payloadSchemaFromDefinition(DEFAULT_IO_SCHEMA_DEFINITION);
    const doc = { mediaId: 'm-1', mime: 'application/pdf', name: 'labs.pdf', size: 10 };
    const img = { mediaId: 'm-2', mime: 'image/png' };
    expect(subset.jsonSchemaValueProblems(schema, { message: 'hello' })).toEqual([]);
    expect(subset.jsonSchemaValueProblems(schema, { message: 'hello', documents: [doc], images: [img] })).toEqual([]);
    expect(subset.jsonSchemaValueProblems(schema, { message: 'hello', attachments: [doc] })).not.toEqual([]);
  });
});
