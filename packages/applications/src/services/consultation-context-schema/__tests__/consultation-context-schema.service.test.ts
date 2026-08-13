/**
 * ConsultationContextSchemaService unit tests.
 *
 * Mirrors the DepartmentService / TenantAllowedOriginService conventions
 * (mocked repositories, EventEmitter2, ClsService) and locks the acceptance
 * criteria the ticket calls out by name:
 *
 *  - a kind declaring an unknown primitive is REJECTED AT PUBLISH
 *  - a payload validates against the PINNED version, not the latest
 *  - a cross-tenant schema id answers 404, never 403
 *  - an additive change publishes unacknowledged; a rename does not
 *  - the discovery ETag moves only when the SERVED version moves
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationContextSchemaService } from '../consultation-context-schema.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
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
        id: 'schema-new',
        pinnedVersionNumber: null,
        createdAt: new Date('2026-08-11T00:00:00Z'),
        updatedAt: new Date('2026-08-11T00:00:00Z'),
        version: 1,
      })),
    },
    ConsultationContextSchemaVersionFactory: {
      CreateConsultationContextSchemaVersion: vi.fn((data) => ({
        ...data,
        id: `version-${data.versionNumber}`,
        createdAt: new Date('2026-08-11T00:00:00Z'),
        version: 1,
      })),
    },
  };
});

/** A definition with one STRUCTURED kind whose `fields` the tests vary. */
function definitionWith(fields: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kinds: [
      {
        key: 'intake',
        label: 'Intake',
        primitive: 'STRUCTURED',
        phiClass: 'PHI',
        cardinality: 'ONE',
        lifecycle: 'PRE',
        producedBy: ['CLIENT'],
        fields,
        ...extra,
      },
    ],
  };
}

const V1_DEFINITION = definitionWith({
  type: 'object',
  properties: { severity: { type: 'string' } },
  required: ['severity'],
  additionalProperties: false,
});

/** ADDITIVE over v1: adds one OPTIONAL property. */
const V2_DEFINITION = definitionWith({
  type: 'object',
  properties: { severity: { type: 'string' }, onsetDays: { type: 'integer' } },
  required: ['severity'],
  additionalProperties: false,
});

const createSchemaEntity = (overrides: Record<string, unknown> = {}) => {
  const base = {
    id: 'schema-1',
    tenantId: 'tenant-1',
    slug: 'default_context',
    name: 'Default Context',
    description: null,
    scope: 'TENANT',
    departmentId: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 1,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-08-11T00:00:00Z'),
    updatedAt: new Date('2026-08-11T00:00:00Z'),
    version: 1,
    hasChanges: true,
    changes: {},
    ...overrides,
  };
  return { ...base, toObject: () => ({ ...base }) };
};

const createVersionEntity = (versionNumber: number, definition: Record<string, unknown>, checksum = `sum-${versionNumber}`) => ({
  id: `version-${versionNumber}`,
  tenantId: 'tenant-1',
  schemaId: 'schema-1',
  versionNumber,
  definition,
  checksum,
  changeReason: null,
  createdAt: new Date('2026-08-11T00:00:00Z'),
  version: 1,
});

describe('ConsultationContextSchemaService', () => {
  let service: ConsultationContextSchemaService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'user-1', roles: ['TENANT_ADMIN'] };
        case 'tenantId':
          return 'tenant-1';
        default:
          return undefined;
      }
    });

    service = new ConsultationContextSchemaService(
      mockSchemaRepository as never,
      mockVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  describe('publish — definition validation', () => {
    it('REJECTS a kind declaring a primitive outside the closed five-value set', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity({ status: 'DRAFT', pinnedVersionNumber: null }));

      const bad = definitionWith({ type: 'object' });
      (bad.kinds as Record<string, unknown>[])[0].primitive = 'VIDEO';

      await expect(service.publish('schema-1', { definition: bad })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an `if`/`then`/`else` field schema (authorable subset)', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity({ status: 'DRAFT', pinnedVersionNumber: null }));

      await expect(service.publish('schema-1', { definition: definitionWith({ type: 'object', if: { const: 1 } }) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('publishes a first version and moves the pin to it', async () => {
      const entity = createSchemaEntity({ status: 'DRAFT', pinnedVersionNumber: null });
      mockSchemaRepository.findById.mockResolvedValue(entity);
      mockVersionRepository.findLatestForSchema.mockResolvedValue(null);
      mockVersionRepository.create.mockImplementation(async (v) => v);
      mockSchemaRepository.update.mockImplementation(async (_id, e) => e);

      const result = await service.publish('schema-1', { definition: V1_DEFINITION });

      expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
      expect(mockVersionRepository.create.mock.calls[0][0].versionNumber).toBe(1);
      expect(result.pinnedVersionNumber).toBe(1);
      expect(result.status).toBe('PUBLISHED');
    });
  });

  describe('publish — change classification', () => {
    it('an ADDITIVE change (new optional field) publishes with NO acknowledgement', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity());
      mockVersionRepository.findLatestForSchema.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      mockVersionRepository.create.mockImplementation(async (v) => v);
      mockSchemaRepository.update.mockImplementation(async (_id, e) => e);

      const result = await service.publish('schema-1', { definition: V2_DEFINITION });

      expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
      expect(result.pinnedVersionNumber).toBe(2);
    });

    it('a RENAME is refused without `allowBreakingChange`, and the message names the break', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity());
      mockVersionRepository.findLatestForSchema.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));

      const renamed = definitionWith({
        type: 'object',
        properties: { severityLevel: { type: 'string' } },
        required: ['severityLevel'],
        additionalProperties: false,
      });

      await expect(service.publish('schema-1', { definition: renamed })).rejects.toThrow(/severity/);
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('the same RENAME publishes once acknowledged', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity());
      mockVersionRepository.findLatestForSchema.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      mockVersionRepository.create.mockImplementation(async (v) => v);
      mockSchemaRepository.update.mockImplementation(async (_id, e) => e);

      const renamed = definitionWith({
        type: 'object',
        properties: { severityLevel: { type: 'string' } },
        required: ['severityLevel'],
        additionalProperties: false,
      });

      const result = await service.publish('schema-1', { definition: renamed, allowBreakingChange: true });
      expect(result.pinnedVersionNumber).toBe(2);
    });

    it('an IDENTICAL republish writes NO new version and leaves the pin alone', async () => {
      const entity = createSchemaEntity();
      mockSchemaRepository.findById.mockResolvedValue(entity);
      // The stored checksum must be the one the service itself computes.
      const { computeDefinitionChecksum } = await import('../context-schema-definition');
      mockVersionRepository.findLatestForSchema.mockResolvedValue(createVersionEntity(1, V1_DEFINITION, computeDefinitionChecksum(V1_DEFINITION)));

      const result = await service.publish('schema-1', { definition: V1_DEFINITION });

      expect(mockVersionRepository.create).not.toHaveBeenCalled();
      expect(result.pinnedVersionNumber).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it('a cross-tenant schema id answers 404, never 403', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity({ tenantId: 'tenant-OTHER' }));
      await expect(service.getById('schema-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a missing schema id answers 404', async () => {
      mockSchemaRepository.findById.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('publish on a cross-tenant id answers 404 BEFORE the definition is even validated', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity({ tenantId: 'tenant-OTHER' }));
      const bad = definitionWith({ type: 'object' });
      (bad.kinds as Record<string, unknown>[])[0].primitive = 'VIDEO';
      await expect(service.publish('schema-1', { definition: bad })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('validateContextPayload — pinned, not latest', () => {
    beforeEach(() => {
      // Latest is v2 (which accepts `onsetDays`); the schema is PINNED to v1
      // (which does not, because additionalProperties is false).
      mockSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
        scope === 'TENANT' ? createSchemaEntity({ pinnedVersionNumber: 1 }) : null,
      );
      mockVersionRepository.findBySchemaAndVersionNumber.mockImplementation(async (_id: string, n: number) =>
        n === 1 ? createVersionEntity(1, V1_DEFINITION) : createVersionEntity(2, V2_DEFINITION),
      );
      mockVersionRepository.findLatestForSchema.mockResolvedValue(createVersionEntity(2, V2_DEFINITION));
    });

    it('accepts a payload valid under the PINNED version', async () => {
      const result = await service.validateContextPayload({ kindKey: 'intake', payload: { severity: 'mild' } });
      expect(result.contextSchemaVersionId).toBe('version-1');
      expect(result.primitive).toBe('STRUCTURED');
    });

    it('REJECTS a payload that is only valid under the LATEST version', async () => {
      await expect(service.validateContextPayload({ kindKey: 'intake', payload: { severity: 'mild', onsetDays: 3 } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a kind the pinned version does not declare', async () => {
      await expect(service.validateContextPayload({ kindKey: 'unknown_kind', payload: {} })).rejects.toThrow(/unknown_kind/);
    });

    it('rejects when the tenant has no servable schema at all', async () => {
      mockSchemaRepository.findDefaultForScope.mockResolvedValue(null);
      await expect(service.validateContextPayload({ kindKey: 'intake', payload: {} })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('honours an explicitly supplied version pin over the schema default', async () => {
      mockVersionRepository.findById.mockResolvedValue(createVersionEntity(2, V2_DEFINITION));
      const result = await service.validateContextPayload({
        kindKey: 'intake',
        payload: { severity: 'mild', onsetDays: 3 },
        contextSchemaVersionId: 'version-2',
      });
      expect(result.contextSchemaVersionId).toBe('version-2');
    });

    it('serialises a STRUCTURED payload into `content` so it rides the existing PHI encryption path', async () => {
      const result = await service.validateContextPayload({ kindKey: 'intake', payload: { severity: 'mild' } });
      expect(JSON.parse(result.content!)).toEqual({ severity: 'mild' });
    });
  });

  describe('getEffectiveBundle — discovery', () => {
    it('serves the PINNED version with a strong ETag', async () => {
      mockSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
        scope === 'TENANT' ? createSchemaEntity({ pinnedVersionNumber: 1 }) : null,
      );
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));

      const bundle = await service.getEffectiveBundle();
      expect(bundle.versionNumber).toBe(1);
      expect(bundle.definition).toEqual(V1_DEFINITION);
      expect(bundle.etag).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it('the ETag changes when the SERVED version changes, and only then', async () => {
      mockSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
        scope === 'TENANT' ? createSchemaEntity({ pinnedVersionNumber: 1 }) : null,
      );
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      const first = await service.getEffectiveBundle();
      const again = await service.getEffectiveBundle();
      expect(again.etag).toBe(first.etag);

      // Same schema, name edited on the HEAD row — the served representation
      // is unchanged, so the validator must not move.
      mockSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
        scope === 'TENANT' ? createSchemaEntity({ pinnedVersionNumber: 1, name: 'Renamed head row' }) : null,
      );
      expect((await service.getEffectiveBundle()).etag).toBe(first.etag);

      // Pin moved to v2 — the served bytes changed, so the validator must.
      mockSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
        scope === 'TENANT' ? createSchemaEntity({ pinnedVersionNumber: 2 }) : null,
      );
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(2, V2_DEFINITION));
      expect((await service.getEffectiveBundle()).etag).not.toBe(first.etag);
    });

    it('a DEPARTMENT-scoped default wins over the tenant default', async () => {
      mockSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
        scope === 'DEPARTMENT'
          ? createSchemaEntity({ id: 'schema-dept', scope: 'DEPARTMENT', departmentId: 'dept-1', pinnedVersionNumber: 1 })
          : createSchemaEntity({ pinnedVersionNumber: 1 }),
      );
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));

      expect((await service.getEffectiveBundle('dept-1')).schemaId).toBe('schema-dept');
    });

    it('reports an unconfigured tenant rather than 404-ing the client', async () => {
      mockSchemaRepository.findDefaultForScope.mockResolvedValue(null);
      const bundle = await service.getEffectiveBundle();
      expect(bundle.schemaId).toBeNull();
      expect(bundle.definition).toBeNull();
      expect(bundle.etag).toBe('"none"');
    });
  });

  describe('pin', () => {
    it('moves the pin to an existing version and rejects an unknown one', async () => {
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity({ pinnedVersionNumber: 2 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      mockSchemaRepository.update.mockImplementation(async (_id, e) => e);

      expect((await service.pin('schema-1', { versionNumber: 1 })).pinnedVersionNumber).toBe(1);

      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);
      await expect(service.pin('schema-1', { versionNumber: 99 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
