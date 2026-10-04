/**
 * TASK-1036 (section 3.5) — the platform default I/O context schema, `default_io`.
 *
 * Hermetic. The definition is validated by the REAL `contextSchemaDefinitionProblems` of
 * `@arcaai/applications` (imported from source, the task-930 pattern) so the seed cannot ship a
 * schema the publish gate would refuse, and the checksum / payload schema are compared against
 * the real canonicalisers.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { NOTE_CONTEXT_SCHEMAS, NOTE_CONTEXT_SCHEMA_VERSIONS, payloadSchemaFromDefinition } from '../07e-consultation-note-context-schema';
import { ARCAAI_TWO_CONTEXT_SCHEMAS, ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS } from '../07g-arcaai-two-schemas';
import {
  DEFAULT_IO_DOCUMENT_MIME_TYPES,
  DEFAULT_IO_IMAGE_MIME_TYPES,
  DEFAULT_IO_SCHEMAS,
  DEFAULT_IO_SCHEMA_DEFINITION,
  DEFAULT_IO_SCHEMA_SLUG,
  DEFAULT_IO_SCHEMA_VERSIONS,
  seedDefaultIoContextSchema,
} from '../07h-default-io-context-schema';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFINITION_MODULE = path.resolve(HERE, '../../../../../../applications/src/services/consultation-context-schema/context-schema-definition.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const definitionModule: any = await import(/* @vite-ignore */ DEFINITION_MODULE);

const kinds = DEFAULT_IO_SCHEMA_DEFINITION.kinds as Array<Record<string, any>>;

describe('default_io — the definition', () => {
  it('passes the real publish-time grammar with no problem', () => {
    expect(definitionModule.contextSchemaDefinitionProblems(DEFAULT_IO_SCHEMA_DEFINITION)).toEqual([]);
  });

  it('input: an optional message (TEXT) and optional attachments (DOCUMENT, IMAGE); output: text', () => {
    expect(kinds.map((kind) => [kind.key, kind.primitive])).toEqual([
      ['message', 'TEXT'],
      ['documents', 'DOCUMENT'],
      ['images', 'IMAGE'],
    ]);
    // Nothing is required: a run may carry a message only, or attachments only.
    for (const kind of kinds) expect(kind.required, kind.key).toBeUndefined();
    expect(DEFAULT_IO_SCHEMA_DEFINITION.outputs).toEqual([expect.objectContaining({ key: 'text', primitive: 'TEXT' })]);
  });

  it('the attachment MIME lists split the v2 allow-list by primitive: together exactly CONTEXT_ATTACHMENT_MIME_TYPES, none repeated', () => {
    const all = [...DEFAULT_IO_DOCUMENT_MIME_TYPES, ...DEFAULT_IO_IMAGE_MIME_TYPES];
    expect([...all].sort()).toEqual([...definitionModule.CONTEXT_ATTACHMENT_MIME_TYPES].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(kinds.find((kind) => kind.key === 'documents')!.constraints.mimeTypes).toEqual([...DEFAULT_IO_DOCUMENT_MIME_TYPES]);
    expect(kinds.find((kind) => kind.key === 'images')!.constraints.mimeTypes).toEqual([...DEFAULT_IO_IMAGE_MIME_TYPES]);
  });

  it('the checksum and the derived payload schema equal the real canonicalisers`', () => {
    for (const version of DEFAULT_IO_SCHEMA_VERSIONS) {
      expect(version.checksum).toBe(definitionModule.computeDefinitionChecksum(DEFAULT_IO_SCHEMA_DEFINITION));
    }
    expect(payloadSchemaFromDefinition(DEFAULT_IO_SCHEMA_DEFINITION)).toEqual(
      definitionModule.payloadSchemaFromDefinition(DEFAULT_IO_SCHEMA_DEFINITION),
    );
  });
});

describe('default_io — the rows', () => {
  it('Global authors and SYSTEM carries the promoted copy; PUBLISHED, TENANT-scoped, pinned at v1', () => {
    expect(DEFAULT_IO_SCHEMAS.map((row) => row.tenantId).sort()).toEqual([SYSTEM_TENANT_ID, SEED_TENANT_ID].sort());
    for (const row of DEFAULT_IO_SCHEMAS) {
      expect(row).toMatchObject({ slug: DEFAULT_IO_SCHEMA_SLUG, scope: 'TENANT', status: 'PUBLISHED', pinnedVersionNumber: 1, departmentId: null });
    }
    expect(DEFAULT_IO_SCHEMA_VERSIONS.map((version) => version.schemaId)).toEqual(DEFAULT_IO_SCHEMAS.map((row) => row.id));
  });

  it('is NOT a tenant default: consultation_note_context holds the default and phase 26 copies `isDefault` verbatim', () => {
    for (const row of DEFAULT_IO_SCHEMAS) expect(row.isDefault).toBe(false);
    for (const row of NOTE_CONTEXT_SCHEMAS) expect(row.isDefault).toBe(true);
  });

  it('the slug is a valid kind-key slug (the clone path goes through create())', () => {
    expect(DEFAULT_IO_SCHEMA_SLUG).toMatch(/^[a-z0-9_]{2,48}$/);
  });

  it('allocates ids that collide with no other seeded context schema or version', () => {
    const mine = [...DEFAULT_IO_SCHEMAS.map((row) => row.id), ...DEFAULT_IO_SCHEMA_VERSIONS.map((row) => row.id)];
    const others = [
      ...NOTE_CONTEXT_SCHEMAS.map((row) => row.id),
      ...NOTE_CONTEXT_SCHEMA_VERSIONS.map((row) => row.id),
      ...ARCAAI_TWO_CONTEXT_SCHEMAS.map((row) => row.id),
      ...ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS.map((row) => row.id),
    ];
    expect(new Set(mine).size).toBe(mine.length);
    for (const id of mine) expect(others).not.toContain(id);
  });
});

describe('default_io — seeding', () => {
  it('is CREATE-ONLY: a second run writes nothing, and a tenant that already owns the slug keeps its edit', async () => {
    const schemas: Array<Record<string, any>> = [];
    const versions: Array<Record<string, unknown>> = [];
    const client = {
      consultationContextSchema: {
        findFirst: async ({ where }: any) =>
          schemas.find(
            (row) => row.tenantId === where.tenantId && where.OR.some((clause: any) => clause.id === row.id || clause.slug === row.slug),
          ) ?? null,
        create: async ({ data }: any) => {
          schemas.push(data);
          return data;
        },
      },
      consultationContextSchemaVersion: {
        create: async ({ data }: any) => {
          versions.push(data);
          return data;
        },
      },
    };
    await seedDefaultIoContextSchema(client as never);
    expect(schemas).toHaveLength(2);
    expect(versions).toHaveLength(2);
    await seedDefaultIoContextSchema(client as never);
    expect(schemas).toHaveLength(2);
    expect(versions).toHaveLength(2);
  });
});
