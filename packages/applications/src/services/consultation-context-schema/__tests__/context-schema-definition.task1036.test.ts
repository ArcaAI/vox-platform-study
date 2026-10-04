/**
 * TASK-1036 OD-6 — context schema v2: audio `delivery` and the attachment MIME allow-list.
 *
 *  - a STREAM_AUDIO kind or output may declare `delivery: 'stream' | 'blob'`; absent, an input
 *    kind is `stream` and an output is `blob` (`effectiveAudioDelivery`);
 *  - a DOCUMENT / IMAGE kind's `constraints.mimeTypes` must be drawn from
 *    `text/plain`, `text/markdown`, `application/pdf`, `image/jpeg` (`image/jpg` normalised);
 *  - every SEEDED definition still validates, byte-for-byte unchanged (backward compatibility).
 */
import { describe, expect, it } from 'vitest';
import {
  ARCAAI_CONSULTATION_SCRIBE_DEFINITION,
  ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION,
} from '../../../../../database/src/prisma/db_main/seed/07g-arcaai-two-schemas';
import { NOTE_CONTEXT_SCHEMA_DEFINITION } from '../../../../../database/src/prisma/db_main/seed/07e-consultation-note-context-schema';
import {
  CONTEXT_ATTACHMENT_MIME_TYPES,
  CONTEXT_AUDIO_DELIVERIES,
  computeDefinitionChecksum,
  contextSchemaDefinitionProblems,
  effectiveAudioDelivery,
  normalizeContextMimeType,
  payloadSchemaFromDefinition,
} from '../context-schema-definition';

const kind = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  key: 'k1',
  label: 'Kind',
  primitive: 'STREAM_AUDIO',
  phiClass: 'PHI',
  cardinality: 'ONE',
  lifecycle: 'DURING',
  producedBy: ['CLIENT'],
  ...overrides,
});

const definition = (kinds: Record<string, unknown>[], outputs?: Record<string, unknown>[]) => ({
  schemaVersion: '1.0',
  kinds,
  ...(outputs === undefined ? {} : { outputs }),
});

describe('audio delivery (OD-6)', () => {
  it('declares the two deliveries', () => {
    expect([...CONTEXT_AUDIO_DELIVERIES]).toEqual(['stream', 'blob']);
  });

  it('accepts stream or blob on a STREAM_AUDIO kind and output', () => {
    expect(contextSchemaDefinitionProblems(definition([kind({ delivery: 'stream' })]))).toEqual([]);
    expect(contextSchemaDefinitionProblems(definition([kind({ delivery: 'blob' })]))).toEqual([]);
    expect(
      contextSchemaDefinitionProblems(definition([kind({})], [{ key: 'reply_audio', label: 'Reply', primitive: 'STREAM_AUDIO', delivery: 'stream' }])),
    ).toEqual([]);
  });

  it('refuses an unknown delivery', () => {
    expect(contextSchemaDefinitionProblems(definition([kind({ delivery: 'push' })]))).toEqual([
      'definition.kinds[0].delivery must be one of stream | blob',
    ]);
  });

  it('refuses delivery on a non-audio kind or output', () => {
    expect(contextSchemaDefinitionProblems(definition([kind({ primitive: 'TEXT', delivery: 'blob' })]))).toEqual([
      'definition.kinds[0].delivery is only allowed on a STREAM_AUDIO kind (this kind is `TEXT`)',
    ]);
    expect(contextSchemaDefinitionProblems(definition([kind({})], [{ key: 'note', primitive: 'TEXT', delivery: 'blob' }]))).toEqual([
      'definition.outputs[0].delivery is only allowed on a STREAM_AUDIO output (this output is `TEXT`)',
    ]);
  });

  it('defaults an input kind to stream and an output to blob', () => {
    expect(effectiveAudioDelivery(kind({}), 'input')).toBe('stream');
    expect(effectiveAudioDelivery({ key: 'a', primitive: 'STREAM_AUDIO' }, 'output')).toBe('blob');
    expect(effectiveAudioDelivery(kind({ delivery: 'blob' }), 'input')).toBe('blob');
    expect(effectiveAudioDelivery({ key: 'a', primitive: 'STREAM_AUDIO', delivery: 'stream' }, 'output')).toBe('stream');
    expect(effectiveAudioDelivery(kind({ primitive: 'TEXT' }), 'input')).toBeNull();
  });

  it('does not move the payload schema or the checksum of a definition that declares none', () => {
    const plain = definition([kind({})]);
    const withDelivery = definition([kind({ delivery: 'stream' })]);
    expect(payloadSchemaFromDefinition(withDelivery)).toEqual(payloadSchemaFromDefinition(plain));
  });
});

describe('attachment MIME allow-list (OD-6)', () => {
  it('declares the four types', () => {
    expect([...CONTEXT_ATTACHMENT_MIME_TYPES]).toEqual(['text/plain', 'text/markdown', 'application/pdf', 'image/jpeg']);
  });

  it('normalises image/jpg and case', () => {
    expect(normalizeContextMimeType('image/jpg')).toBe('image/jpeg');
    expect(normalizeContextMimeType(' Application/PDF ')).toBe('application/pdf');
    expect(normalizeContextMimeType('text/markdown')).toBe('text/markdown');
  });

  it('accepts the allow-list (and image/jpg) on DOCUMENT and IMAGE kinds', () => {
    const constraints = { mimeTypes: ['application/pdf', 'image/jpg', 'TEXT/PLAIN', 'text/markdown'], maxBytes: 1000 };
    expect(contextSchemaDefinitionProblems(definition([kind({ primitive: 'DOCUMENT', cardinality: 'MANY', constraints })]))).toEqual([]);
    expect(contextSchemaDefinitionProblems(definition([kind({ primitive: 'IMAGE', constraints: { mimeTypes: ['image/jpeg'] } })]))).toEqual([]);
  });

  it('refuses anything outside it, naming the value', () => {
    expect(contextSchemaDefinitionProblems(definition([kind({ primitive: 'DOCUMENT', constraints: { mimeTypes: ['application/msword'] } })]))).toEqual([
      'definition.kinds[0].constraints.mimeTypes[0] `application/msword` is not an allowed attachment type (text/plain | text/markdown | application/pdf | image/jpeg)',
    ]);
    expect(contextSchemaDefinitionProblems(definition([kind({ primitive: 'IMAGE', constraints: { mimeTypes: ['image/png'] } })]))).toEqual([
      'definition.kinds[0].constraints.mimeTypes[0] `image/png` is not an allowed attachment type (text/plain | text/markdown | application/pdf | image/jpeg)',
    ]);
  });

  it('leaves non-attachment primitives exactly as before', () => {
    expect(contextSchemaDefinitionProblems(definition([kind({ constraints: { mimeTypes: ['audio/wav'] } })]))).toEqual([]);
  });
});

describe('backward compatibility — every seeded definition still validates unchanged', () => {
  const seeded: Array<[string, Record<string, unknown>]> = [
    ['07e consultation_note_context', NOTE_CONTEXT_SCHEMA_DEFINITION],
    ['07g arcaai_realtime_transcription', ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION],
    ['07g arcaai_consultation_scribe', ARCAAI_CONSULTATION_SCRIBE_DEFINITION],
  ];

  it.each(seeded)('%s publishes clean', (_name, seededDefinition) => {
    const before = JSON.stringify(seededDefinition);
    expect(contextSchemaDefinitionProblems(seededDefinition)).toEqual([]);
    expect(JSON.stringify(seededDefinition)).toBe(before);
    expect(computeDefinitionChecksum(seededDefinition)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(seeded)('%s: its STREAM_AUDIO kinds stream by default', (_name, seededDefinition) => {
    const audio = (seededDefinition.kinds as Array<Record<string, unknown>>).filter((entry) => entry.primitive === 'STREAM_AUDIO');
    expect(audio.length).toBeGreaterThan(0);
    for (const entry of audio) expect(effectiveAudioDelivery(entry, 'input')).toBe('stream');
  });
});
