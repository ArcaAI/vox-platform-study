/**
 * TASK-661 — schema compatibility and lifecycle, at the
 * `ConsultationContextSchemaService` layer.
 *
 * TASK-658 already built the mechanism this ticket needs: `publish` refuses a
 * BREAKING change without `allowBreakingChange` (`classifyDefinitionChange`),
 * and `validateContextPayload` already resolves an EXPLICIT
 * `contextSchemaVersionId` over the tenant's current pin
 * (`consultation-context-schema.service.test.ts` — "honours an explicitly
 * supplied version pin over the schema default"). What TASK-661 adds:
 *
 *  1. Proof that a SUPERSEDED version — one that is no longer the pin, and
 *     was never pinned at all if it was skipped — stays fully readable and
 *     fully validatable, not merely resolvable by id.
 *  2. A `versionSkew` compatibility judgement (reusing
 *     `classifyDefinitionChange` — the SAME classifier `publish` uses) on the
 *     drift between the version a write was validated against and the
 *     tenant's CURRENT pin, so a caller pinned to an old version can be told
 *     it is falling behind without that ever changing what got validated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

function definitionWith(fields: Record<string, unknown>): Record<string, unknown> {
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
      },
    ],
  };
}

/** v1: `severity` required, closed object. */
const V1_DEFINITION = definitionWith({
  type: 'object',
  properties: { severity: { type: 'string' } },
  required: ['severity'],
  additionalProperties: false,
});

/** v2: ADDITIVE over v1 — a new OPTIONAL property. */
const V2_DEFINITION = definitionWith({
  type: 'object',
  properties: { severity: { type: 'string' }, onsetDays: { type: 'integer' } },
  required: ['severity'],
  additionalProperties: false,
});

/** v3: BREAKING over v2 — `severity` renamed. */
const V3_DEFINITION = definitionWith({
  type: 'object',
  properties: { severityLevel: { type: 'string' }, onsetDays: { type: 'integer' } },
  required: ['severityLevel'],
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
    pinnedVersionNumber: 3,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-08-11T00:00:00Z'),
    updatedAt: new Date('2026-08-11T00:00:00Z'),
    version: 1,
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

describe('ConsultationContextSchemaService — TASK-661 version pinning + lifecycle', () => {
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

  describe('a superseded version stays readable', () => {
    beforeEach(() => {
      // The tenant is PINNED to v3; v1 and v2 are superseded but must still
      // exist and resolve.
      mockSchemaRepository.findById.mockResolvedValue(createSchemaEntity({ pinnedVersionNumber: 3 }));
      mockVersionRepository.findAllForSchema.mockResolvedValue([
        createVersionEntity(3, V3_DEFINITION),
        createVersionEntity(2, V2_DEFINITION),
        createVersionEntity(1, V1_DEFINITION),
      ]);
    });

    it('listVersions still returns a superseded version with its ORIGINAL definition intact', async () => {
      const versions = await service.listVersions('schema-1');
      const v1 = versions.find((v) => v.versionNumber === 1);
      expect(v1).toBeDefined();
      expect(v1!.definition).toEqual(V1_DEFINITION);
    });

    it('a write pinned to the superseded version validates against it, not the current v3 pin', async () => {
      mockVersionRepository.findById.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      mockSchemaRepository.findDefaultForScope.mockResolvedValue(createSchemaEntity({ pinnedVersionNumber: 3 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(3, V3_DEFINITION));

      // Valid under v1 (`severity`) but v3 requires `severityLevel` instead —
      // proving this resolved against v1, not v3.
      const result = await service.validateContextPayload({
        kindKey: 'intake',
        payload: { severity: 'mild' },
        contextSchemaVersionId: 'version-1',
      });

      expect(result.contextSchemaVersionId).toBe('version-1');
      expect(JSON.parse(result.content!)).toEqual({ severity: 'mild' });
    });
  });

  describe('versionSkew — reusing classifyDefinitionChange for a compatibility judgement', () => {
    beforeEach(() => {
      mockSchemaRepository.findDefaultForScope.mockResolvedValue(createSchemaEntity({ pinnedVersionNumber: 3 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockImplementation(async (_id: string, n: number) => {
        if (n === 1) return createVersionEntity(1, V1_DEFINITION);
        if (n === 2) return createVersionEntity(2, V2_DEFINITION);
        return createVersionEntity(3, V3_DEFINITION);
      });
    });

    it('is UNDEFINED when no explicit version is supplied (back-compat: current pin is simply used)', async () => {
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(createVersionEntity(3, V3_DEFINITION));
      const result = await service.validateContextPayload({ kindKey: 'intake', payload: { severityLevel: 'mild' } });
      expect(result.versionSkew).toBeUndefined();
    });

    it('is UNDEFINED when the explicit version IS the current pin (no drift)', async () => {
      mockVersionRepository.findById.mockResolvedValue(createVersionEntity(3, V3_DEFINITION));
      const result = await service.validateContextPayload({
        kindKey: 'intake',
        payload: { severityLevel: 'mild' },
        contextSchemaVersionId: 'version-3',
      });
      expect(result.versionSkew).toBeUndefined();
    });

    it('is ADDITIVE when the pinned-by-caller version (v1) differs from the current pin only additively (v1 -> v2)', async () => {
      mockVersionRepository.findById.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      mockSchemaRepository.findDefaultForScope.mockResolvedValue(createSchemaEntity({ pinnedVersionNumber: 2 }));
      const result = await service.validateContextPayload({
        kindKey: 'intake',
        payload: { severity: 'mild' },
        contextSchemaVersionId: 'version-1',
      });
      expect(result.versionSkew).toBe('ADDITIVE');
    });

    it('is BREAKING when the pinned-by-caller version (v1) is now incompatible with the current pin (v3)', async () => {
      mockVersionRepository.findById.mockResolvedValue(createVersionEntity(1, V1_DEFINITION));
      const result = await service.validateContextPayload({
        kindKey: 'intake',
        payload: { severity: 'mild' },
        contextSchemaVersionId: 'version-1',
      });
      expect(result.versionSkew).toBe('BREAKING');
      // Crucially: BREAKING skew does NOT change what got validated or stamped.
      expect(result.contextSchemaVersionId).toBe('version-1');
    });
  });
});
