/**
 * TASK-1036 (OD, section 3.5) — the platform default I/O context schema: `default_io`.
 *
 * A schema a tenant admin can bind to a plain (non-consultation) workflow trigger without having
 * to author one first. It declares the smallest useful contract:
 *
 *   input   `message`    TEXT, optional      the user turn
 *           `documents`  DOCUMENT, optional  zero or more attached documents (text/plain,
 *                                            text/markdown, application/pdf)
 *           `images`     IMAGE, optional     zero or more attached images (image/jpeg,
 *                                            image/png, image/webp)
 *   output  `text`       TEXT                the generated text
 *
 * The MIME allow-lists are the v2 attachment allow-list (`CONTEXT_ATTACHMENT_MIME_TYPES` of
 * `@arcaai/applications`) split by primitive — a DOCUMENT kind carries the document types, an
 * IMAGE kind the image types. Nothing here is PHI-free by assumption: a message and an attachment
 * are whatever the caller sends, so every kind is `phiClass: 'PHI'`, like the consultation kinds.
 *
 * ## Who owns which row — and why it is NOT a tenant default
 *
 * Content is cloned, not cascaded (`00-project-context.md`): Global (the platform-admin
 * playground) AUTHORS it and SYSTEM carries the promoted copy, exactly like
 * `consultation_note_context` (`07e-`). Phase 26 (`copyContextSchemas`) then clones the SYSTEM row
 * into every tenant, create-only, keyed by slug.
 *
 * `isDefault` is `false` on both rows, and that is deliberate. The application-layer rule is "at
 * most one default per (tenant, scope, department)", `copyContextSchemas` copies `isDefault`
 * verbatim, and `consultation_note_context` already holds the DEFAULT of every seeded tenant (it is
 * what makes `LoopConfigService` resolve `enabled: true`). A second default would either break that
 * rule or silently change which schema a consultation resolves. `default_io` is therefore only a
 * tenant's default when the tenant has NO default of its own, and that is set by a tenant admin
 * (the console's "make default"), never by the seed. A new workflow's trigger binds the tenant
 * default in follow-latest mode, so on a seeded tenant it binds `consultation_note_context` until
 * an admin chooses otherwise.
 *
 * The three canonicalisers are the ones `07e-` already copies; they are imported from there so
 * there is ONE copy to keep in step with `@arcaai/applications`.
 *
 * ID block (00-constants.ts): `79000000-...-<slot>-...000002` schema / `89000000-...` version,
 * slot 0000 = Global, 0002 = SYSTEM (the slots `07e-` uses, row 000001 there).
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { definitionChecksum } from './07e-consultation-note-context-schema';

export const DEFAULT_IO_SCHEMA_SLUG = 'default_io';

/** `CONTEXT_ATTACHMENT_MIME_TYPES` of `@arcaai/applications`, split by primitive. */
export const DEFAULT_IO_DOCUMENT_MIME_TYPES = ['text/plain', 'text/markdown', 'application/pdf'] as const;
export const DEFAULT_IO_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const DEFAULT_IO_SCHEMA_DEFINITION: Record<string, unknown> = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'message',
      label: 'Message',
      primitive: 'TEXT',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: 'The user turn the workflow operates on. Optional: a run may carry only attachments.',
    },
    {
      key: 'documents',
      label: 'Documents',
      primitive: 'DOCUMENT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      constraints: { mimeTypes: [...DEFAULT_IO_DOCUMENT_MIME_TYPES] },
      description: 'Documents attached to the run (plain text, Markdown or PDF); their text is extracted before use.',
    },
    {
      key: 'images',
      label: 'Images',
      primitive: 'IMAGE',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      constraints: { mimeTypes: [...DEFAULT_IO_IMAGE_MIME_TYPES] },
      description: 'Images attached to the run (JPEG, PNG or WebP). Used only by a model that accepts images.',
    },
  ],
  outputs: [{ key: 'text', label: 'Text', primitive: 'TEXT', description: 'The text the workflow produces.' }],
};

const TENANT_ID_SLOTS: Array<{ tenantId: string; slot: string }> = [
  { tenantId: SEED_TENANT_ID, slot: '0000' },
  { tenantId: SYSTEM_TENANT_ID, slot: '0002' },
];

export const defaultIoSchemaIdFor = (tenantId: string): string => {
  const slot = TENANT_ID_SLOTS.find((entry) => entry.tenantId === tenantId)?.slot;
  if (!slot) throw new Error(`No seeded default_io slot for tenant ${tenantId}`);
  return `79000000-0000-0000-${slot}-000000000002`;
};

export const defaultIoSchemaVersionIdFor = (tenantId: string): string => `89${defaultIoSchemaIdFor(tenantId).slice(2)}`;

export const DEFAULT_IO_SCHEMAS = TENANT_ID_SLOTS.map(({ tenantId }) => ({
  id: defaultIoSchemaIdFor(tenantId),
  tenantId,
  slug: DEFAULT_IO_SCHEMA_SLUG,
  name: 'Default input and output',
  description:
    'A message with optional documents and images in, text out. A starting point for any workflow that is not a consultation: bind it to a trigger, or copy and extend it. Editable by a tenant admin; a re-seed never overwrites it.',
  scope: 'TENANT' as const,
  departmentId: null as string | null,
  status: 'PUBLISHED' as const,
  pinnedVersionNumber: 1,
  // NOT a tenant default — see the file header.
  isDefault: false,
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
  resourceStatus: 'ENABLED' as const,
  createdBy: SYSTEM_USER_ID,
}));

export const DEFAULT_IO_SCHEMA_VERSIONS = TENANT_ID_SLOTS.map(({ tenantId }) => ({
  id: defaultIoSchemaVersionIdFor(tenantId),
  tenantId,
  schemaId: defaultIoSchemaIdFor(tenantId),
  versionNumber: 1,
  definition: DEFAULT_IO_SCHEMA_DEFINITION,
  checksum: definitionChecksum(DEFAULT_IO_SCHEMA_DEFINITION),
  changeReason: 'The platform default input and output: message, documents and images in, text out (TASK-1036)',
  createdBy: SYSTEM_USER_ID,
}));

/**
 * CREATE-ONLY: skipped when the tenant already has a `default_io` (by id or by slug), so a tenant
 * admin's edits or a re-seed are never overwritten.
 */
export const seedDefaultIoContextSchema = async (client: CorePrismaClient) => {
  console.log('Seeding the default_io context schema (Global + SYSTEM) ...');

  let created = 0;
  let skipped = 0;

  for (const [index, schema] of DEFAULT_IO_SCHEMAS.entries()) {
    const version = DEFAULT_IO_SCHEMA_VERSIONS[index];
    if (!version) throw new Error(`Missing default_io version for ${schema.id}`);

    const existing = await client.consultationContextSchema.findFirst({
      where: { tenantId: schema.tenantId, OR: [{ id: schema.id }, { slug: schema.slug, resourceStatus: 'ENABLED' }] },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    await client.consultationContextSchema.create({ data: schema });
    await client.consultationContextSchemaVersion.create({ data: { ...version, definition: version.definition as never } });
    created += 1;
  }

  console.log(`  ✓ ${DEFAULT_IO_SCHEMA_SLUG}: ${created} created, ${skipped} left untouched (already present)`);
};
