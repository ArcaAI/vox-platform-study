/**
 * TASK-890 L2 §3.4 — the context schema as a REFERENCE, and as a reference SET.
 *
 * Three seams land here and every lane downstream consumes one of them:
 *
 *  - `payloadSchemaFromDefinition` — the DERIVED payload schema. One implementation,
 *    used by the workflow publish gate (this lane), the agent pin (L8) and the console's
 *    variable chips, so "what does `{{context.x}}` mean" has exactly one answer.
 *  - `resolveReference` — TENANT-only resolution with the house 404-over-403 posture,
 *    returning WHICH failure it was so the publish gate can name it
 *    (`CONTEXT_SCHEMA_NOT_FOUND` vs `CONTEXT_SCHEMA_VERSION_NOT_FOUND`).
 *  - `cloneFromSystem` — the reference-set copy (OD-H): a schema is CLONED into a tenant
 *    and never shared from SYSTEM, so the clone must carry its provenance and be servable
 *    on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultationContextSchemaService } from '../consultation-context-schema.service';
import { payloadSchemaFromDefinition } from '../context-schema-definition';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
const TENANT = 'tenant-1';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
  run: vi.fn(),
};
const mockEventEmitter = { emit: vi.fn() };

const mockSchemaRepository = {
  findAll: vi.fn(),
  findById: vi.fn(),
  findFirst: vi.fn(),
  findByTenantAndSlug: vi.fn(),
  findDefaultForScope: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};

const mockVersionRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findAllForSchema: vi.fn(),
  findLatestForSchema: vi.fn(),
  findBySchemaAndVersionNumber: vi.fn(),
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ConsultationContextSchemaFactory: {
      CreateConsultationContextSchema: vi.fn((data) => ({
        ...data,
        id: 'schema-clone',
        pinnedVersionNumber: null,
        status: 'DRAFT',
        createdAt: new Date('2026-09-06T00:00:00Z'),
        updatedAt: new Date('2026-09-06T00:00:00Z'),
        version: 1,
      })),
    },
    ConsultationContextSchemaVersionFactory: {
      CreateConsultationContextSchemaVersion: vi.fn((data) => ({
        ...data,
        id: `clone-version-${data.versionNumber}`,
        createdAt: new Date('2026-09-06T00:00:00Z'),
        version: 1,
      })),
    },
  };
});

const LEGACY_DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'audio_stream',
      label: 'Audio Stream',
      primitive: 'STREAM_AUDIO',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'DURING',
      producedBy: ['CLIENT'],
    },
    {
      key: 'context',
      label: 'Legacy Prompt Context',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'ANY',
      producedBy: ['SYSTEM'],
      required: true,
      fields: {
        type: 'object',
        properties: { conversation_language: { type: 'string' }, ner_entities: { type: 'string' } },
      },
    },
  ],
  outputs: [{ key: 'soap_note', label: 'SOAP Note', primitive: 'TEXT' }],
};

function schemaRow(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 'schema-1',
    tenantId: TENANT,
    slug: 'consultation-legacy-v1',
    name: 'Legacy consultation context',
    description: null,
    scope: 'TENANT',
    departmentId: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 2,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-09-06T00:00:00Z'),
    updatedAt: new Date('2026-09-06T00:00:00Z'),
    version: 1,
    hasChanges: true,
    changes: {},
    ...overrides,
  };
  return { ...base, toObject: () => ({ ...base }) };
}

function versionRow(versionNumber: number, definition: unknown = LEGACY_DEFINITION) {
  return {
    id: `version-${versionNumber}`,
    tenantId: TENANT,
    schemaId: 'schema-1',
    versionNumber,
    definition,
    checksum: `sum-${versionNumber}`,
    changeReason: null,
    createdAt: new Date('2026-09-06T00:00:00Z'),
    version: 1,
  };
}

describe('payloadSchemaFromDefinition', () => {
  it('derives an object schema keyed by kind, STRUCTURED kinds contributing their fields', () => {
    expect(payloadSchemaFromDefinition(LEGACY_DEFINITION)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        // A non-STRUCTURED kind carries no `fields` contract, so it is a reference STUB —
        // `{{context.audio_stream}}` resolves, `{{context.audio_stream.anything}}` is open.
        audio_stream: { type: 'object' },
        context: {
          type: 'object',
          properties: { conversation_language: { type: 'string' }, ner_entities: { type: 'string' } },
        },
      },
      required: ['context'],
    });
  });

  it('omits `required` entirely when no kind declares itself required', () => {
    const definition = { schemaVersion: '1.0', kinds: [{ ...LEGACY_DEFINITION.kinds[1], required: false }] };

    expect(payloadSchemaFromDefinition(definition)).not.toHaveProperty('required');
  });

  it('ignores `outputs` — an output is PRODUCED by the run, never supplied as context', () => {
    const derived = payloadSchemaFromDefinition(LEGACY_DEFINITION) as { properties: Record<string, unknown> };

    expect(Object.keys(derived.properties)).toEqual(['audio_stream', 'context']);
  });

  it('answers an empty object schema for a definition it cannot read', () => {
    expect(payloadSchemaFromDefinition(null)).toEqual({ type: 'object', additionalProperties: false, properties: {} });
  });
});

describe('ConsultationContextSchemaService.resolveReference', () => {
  let service: ConsultationContextSchemaService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : undefined));
    mockClsService.run.mockImplementation((_opts: unknown, work: () => unknown) => work());
    service = new ConsultationContextSchemaService(
      mockSchemaRepository as never,
      mockVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  it('resolves the caller tenant’s own row at an explicit version', async () => {
    mockSchemaRepository.findById.mockResolvedValue(schemaRow());
    mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionRow(1));

    await expect(service.resolveReference('schema-1', 1)).resolves.toEqual({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 1,
      versionId: 'version-1',
      payloadSchema: payloadSchemaFromDefinition(LEGACY_DEFINITION),
    });
  });

  it('falls back to the schema’s own pin when no version is named', async () => {
    mockSchemaRepository.findById.mockResolvedValue(schemaRow({ pinnedVersionNumber: 2 }));
    mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionRow(2));

    const resolved = await service.resolveReference('schema-1');

    expect(mockVersionRepository.findBySchemaAndVersionNumber).toHaveBeenCalledWith('schema-1', 2);
    expect(resolved).toMatchObject({ outcome: 'resolved', versionNumber: 2 });
  });

  it('is a NOT_FOUND failure for a SYSTEM row — a schema is CLONED into a tenant, never shared', async () => {
    mockSchemaRepository.findById.mockResolvedValue(schemaRow({ tenantId: SYSTEM_TENANT }));

    await expect(service.resolveReference('schema-1', 1)).resolves.toEqual({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });
  });

  it('is a NOT_FOUND failure for another tenant’s row (404-over-403, no existence oracle)', async () => {
    mockSchemaRepository.findById.mockResolvedValue(schemaRow({ tenantId: 'tenant-2' }));

    await expect(service.resolveReference('schema-1', 1)).resolves.toEqual({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });
  });

  it('is a NOT_FOUND failure when the row does not exist at all', async () => {
    mockSchemaRepository.findById.mockRejectedValue(new NotFoundException('nope'));

    await expect(service.resolveReference('schema-1', 1)).resolves.toEqual({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });
  });

  it('distinguishes a missing VERSION from a missing schema', async () => {
    mockSchemaRepository.findById.mockResolvedValue(schemaRow());
    mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);

    await expect(service.resolveReference('schema-1', 9)).resolves.toEqual({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' });
  });

  it('treats an unpinned schema with no explicit version as a missing VERSION', async () => {
    mockSchemaRepository.findById.mockResolvedValue(schemaRow({ pinnedVersionNumber: null }));

    await expect(service.resolveReference('schema-1')).resolves.toEqual({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' });
    expect(mockVersionRepository.findBySchemaAndVersionNumber).not.toHaveBeenCalled();
  });
});

describe('ConsultationContextSchemaService.cloneFromSystem', () => {
  let service: ConsultationContextSchemaService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : undefined));
    mockClsService.run.mockImplementation((_opts: unknown, work: () => unknown) => work());
    // The clone is created and then PUBLISHED, and `publish` re-reads the head row by id —
    // so the fake repository has to behave like one: what `create` wrote is what `findById`
    // hands back.
    let stored: Record<string, unknown> | null = null;
    mockSchemaRepository.create.mockImplementation(async (entity: Record<string, unknown>) => {
      stored = entity;
      return entity;
    });
    mockSchemaRepository.findById.mockImplementation(async (id: string) => (stored && stored.id === id ? stored : null));
    mockSchemaRepository.update.mockImplementation(async (_id: string, entity: Record<string, unknown>) => entity);
    mockVersionRepository.create.mockImplementation(async (entity: Record<string, unknown>) => entity);
    service = new ConsultationContextSchemaService(
      mockSchemaRepository as never,
      mockVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  it('copies the SYSTEM row’s pinned definition into the tenant, stamped as a pristine clone', async () => {
    mockSchemaRepository.findByTenantAndSlug.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT ? schemaRow({ tenantId: SYSTEM_TENANT, pinnedVersionNumber: 1 }) : null,
    );
    mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionRow(1));
    mockVersionRepository.findLatestForSchema.mockResolvedValue(null);
    mockSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const created = await service.cloneFromSystem('consultation-legacy-v1', TENANT);

    expect(created).toMatchObject({
      tenantId: TENANT,
      slug: 'consultation-legacy-v1',
      sourceTemplateSlug: 'consultation-legacy-v1',
      templateLocked: true,
      isDefault: true,
    });
    // Servable on its own: the clone is PUBLISHED and pinned, never a bare DRAFT.
    expect(created?.status).toBe('PUBLISHED');
    expect(created?.pinnedVersionNumber).toBe(1);
    // Written under the TARGET tenant's context, never the caller's ambient one.
    expect(mockClsService.set).toHaveBeenCalledWith('tenantId', TENANT);
    expect(mockClsService.set).toHaveBeenCalledWith('tenantId', SYSTEM_TENANT);
  });

  it('is idempotent: a tenant that already has the slug keeps its own row untouched', async () => {
    const existing = schemaRow({ id: 'schema-existing', templateLocked: false });
    mockSchemaRepository.findByTenantAndSlug.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT ? schemaRow({ tenantId: SYSTEM_TENANT, pinnedVersionNumber: 1 }) : existing,
    );

    const result = await service.cloneFromSystem('consultation-legacy-v1', TENANT);

    expect(result).toMatchObject({ id: 'schema-existing' });
    expect(mockSchemaRepository.create).not.toHaveBeenCalled();
    expect(mockVersionRepository.create).not.toHaveBeenCalled();
  });

  it('refuses when SYSTEM has no such schema — a missing reference row is a platform defect, not a silent skip', async () => {
    mockSchemaRepository.findByTenantAndSlug.mockResolvedValue(null);

    await expect(service.cloneFromSystem('consultation-legacy-v1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses when the SYSTEM row carries no pinned version — an unservable source is never cloned', async () => {
    mockSchemaRepository.findByTenantAndSlug.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT ? schemaRow({ tenantId: SYSTEM_TENANT, pinnedVersionNumber: null }) : null,
    );

    await expect(service.cloneFromSystem('consultation-legacy-v1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});
