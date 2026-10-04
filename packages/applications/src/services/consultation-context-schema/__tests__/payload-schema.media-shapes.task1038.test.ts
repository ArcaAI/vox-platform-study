/**
 * TASK-1038 (F1) — the derived payload schema of a NON-STRUCTURED kind.
 *
 * `payloadSchemaFromDefinition` used to map every non-STRUCTURED kind to `{ type: 'object' }`. A
 * run's trigger validation (`input.validated`, and the gateway's own checks) therefore refused the
 * most ordinary input there is — `{ message: "hello" }` against the platform `default_io` schema —
 * and had no way to accept an attachment LIST on a `MANY` document kind.
 *
 * The shapes now:
 *  - TEXT: a string, or the legacy object form (`{ text }`); `MANY` also a list of either;
 *  - DOCUMENT / IMAGE (and a `blob` STREAM_AUDIO): a media REFERENCE `{ mediaId, mime, name?, size? }`
 *    — closed, `mime` limited to the kind's declared `constraints.mimeTypes`; `MANY` also a list;
 *  - STREAM_AUDIO (`stream`): an open object whose `sttSessionId`, when present, names the session;
 *  - STRUCTURED: its `fields`, verbatim (unchanged).
 * `additionalProperties: false` stays: a key the definition does not declare (`attachments`,
 * `recording`) is still refused — no back door.
 */
import { describe, expect, it } from 'vitest';
import { authorableJsonSchemaProblems, jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { contextSchemaDefinitionProblems, payloadSchemaFromDefinition } from '../context-schema-definition';

const base = { phiClass: 'PHI', lifecycle: 'ANY', producedBy: ['CLIENT'] };

/** The platform `default_io` schema, as seeded (07h). */
const DEFAULT_IO = {
  schemaVersion: '1.0',
  kinds: [
    { ...base, key: 'message', label: 'Message', primitive: 'TEXT', cardinality: 'ONE' },
    {
      ...base,
      key: 'documents',
      label: 'Documents',
      primitive: 'DOCUMENT',
      cardinality: 'MANY',
      constraints: { mimeTypes: ['text/plain', 'text/markdown', 'application/pdf'] },
    },
    { ...base, key: 'images', label: 'Images', primitive: 'IMAGE', cardinality: 'MANY', constraints: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] } },
  ],
  outputs: [{ key: 'text', label: 'Text', primitive: 'TEXT' }],
};

const problems = (definition: unknown, payload: unknown) => jsonSchemaValueProblems(payloadSchemaFromDefinition(definition), payload);
const pdf = { mediaId: 'm-1', mime: 'application/pdf', name: 'labs.pdf', size: 2048 };
const jpeg = { mediaId: 'm-2', mime: 'image/jpeg' };

describe('default_io — what a run may carry', () => {
  it('the definition is valid and its derived schema is authorable (the subset gate)', () => {
    expect(contextSchemaDefinitionProblems(DEFAULT_IO)).toEqual([]);
    expect(authorableJsonSchemaProblems(payloadSchemaFromDefinition(DEFAULT_IO))).toEqual([]);
  });

  it('accepts `{ message: "hello" }` — a TEXT kind is a string', () => {
    expect(problems(DEFAULT_IO, { message: 'hello' })).toEqual([]);
  });

  it('accepts attachment LISTS of media references on the MANY kinds, and a lone reference', () => {
    expect(problems(DEFAULT_IO, { message: 'see attached', documents: [pdf], images: [jpeg] })).toEqual([]);
    expect(problems(DEFAULT_IO, { documents: pdf })).toEqual([]);
  });

  it('refuses a reference whose MIME type the kind does not declare', () => {
    expect(problems(DEFAULT_IO, { images: [pdf] })).not.toEqual([]);
    expect(problems(DEFAULT_IO, { documents: [jpeg] })).not.toEqual([]);
  });

  it('refuses a reference with no mediaId, or carrying anything beyond the reference (bytes, a URI)', () => {
    expect(problems(DEFAULT_IO, { documents: [{ mime: 'application/pdf' }] })).not.toEqual([]);
    expect(problems(DEFAULT_IO, { documents: [{ ...pdf, uri: 's3://bucket/key' }] })).not.toEqual([]);
    expect(problems(DEFAULT_IO, { documents: [{ ...pdf, bytes: 'JVBERi0' }] })).not.toEqual([]);
  });

  it('still refuses keys the definition does not declare — `attachments` / `recording` are no back door', () => {
    expect(problems(DEFAULT_IO, { message: 'x', attachments: [pdf] })).not.toEqual([]);
    expect(problems(DEFAULT_IO, { message: 'x', recording: { sttSessionId: 's-1' } })).not.toEqual([]);
  });

  it('a TEXT kind is not a back door for binary either: a number or a list on a ONE kind is refused', () => {
    expect(problems(DEFAULT_IO, { message: 42 })).not.toEqual([]);
    expect(problems(DEFAULT_IO, { message: ['a', 'b'] })).not.toEqual([]);
  });
});

describe('the other primitives', () => {
  const definition = {
    schemaVersion: '1.0',
    kinds: [
      { ...base, key: 'transcript', label: 'Transcript', primitive: 'TEXT', cardinality: 'ONE' },
      { ...base, key: 'case_note', label: 'Case note', primitive: 'TEXT', cardinality: 'MANY' },
      { ...base, key: 'audio_stream', label: 'Audio', primitive: 'STREAM_AUDIO', cardinality: 'ONE' },
      { ...base, key: 'dictation', label: 'Dictation', primitive: 'STREAM_AUDIO', cardinality: 'ONE', delivery: 'blob', constraints: { mimeTypes: ['audio/wav'] } },
      { ...base, key: 'scan', label: 'Scan', primitive: 'IMAGE', cardinality: 'ONE' },
      { ...base, key: 'form', label: 'Form', primitive: 'STRUCTURED', cardinality: 'ONE', fields: { type: 'object', properties: { a: { type: 'string' } } } },
    ],
  };

  it('TEXT keeps its legacy object form (`{ text }`) and a MANY kind takes a list', () => {
    expect(problems(definition, { transcript: { text: 'the verbatim transcript' } })).toEqual([]);
    expect(problems(definition, { case_note: ['one', { text: 'two' }] })).toEqual([]);
    expect(problems(definition, { case_note: 'a single note' })).toEqual([]);
  });

  it('a streamed audio kind stays an open object, naming its STT session when it says anything', () => {
    expect(problems(definition, { audio_stream: {} })).toEqual([]);
    expect(problems(definition, { audio_stream: { sttSessionId: 's-1' } })).toEqual([]);
    expect(problems(definition, { audio_stream: { sttSessionId: 7 } })).not.toEqual([]);
  });

  it('a blob audio kind is a media reference of its declared types; an IMAGE with no MIME list takes any MIME string', () => {
    expect(problems(definition, { dictation: { mediaId: 'm-3', mime: 'audio/wav' } })).toEqual([]);
    expect(problems(definition, { dictation: { mediaId: 'm-3', mime: 'audio/mpeg' } })).not.toEqual([]);
    expect(problems(definition, { scan: { mediaId: 'm-4', mime: 'image/png' } })).toEqual([]);
    expect(problems(definition, { scan: [{ mediaId: 'm-4', mime: 'image/png' }] })).not.toEqual([]);
  });

  it('STRUCTURED is unchanged — its own `fields`, verbatim', () => {
    expect((payloadSchemaFromDefinition(definition).properties as Record<string, unknown>).form).toEqual(definition.kinds[5].fields);
  });

  it('`image/jpg` in a declared MIME list is matched in its normalised form', () => {
    const jpg = { schemaVersion: '1.0', kinds: [{ ...base, key: 'photo', label: 'Photo', primitive: 'IMAGE', cardinality: 'ONE', constraints: { mimeTypes: ['IMAGE/JPG'] } }] };
    expect(problems(jpg, { photo: { mediaId: 'm', mime: 'image/jpeg' } })).toEqual([]);
  });
});
