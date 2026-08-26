/**
 * TASK-810 Task 6 + Task 10 — `DocumentTemplateService`.
 *
 * Mirrors the `ConsultationContextSchemaService` suite's conventions (mocked
 * repositories, EventEmitter2, ClsService) and locks the behaviours that would
 * otherwise be silent when broken:
 *
 *  - a shape that does not validate never reaches a version row
 *  - an identical republish writes NOTHING and moves NOTHING
 *  - a NEW COMPILER makes an identical shape publishable again (the half of
 *    idempotency that a checksum alone gets wrong)
 *  - a removed section / a section newly made `required` is BREAKING
 *  - a cross-tenant id answers 404, never 403
 *  - resolution serves the PINNED version and never throws
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocumentTemplateService } from '../document-template.service';
import { DOCUMENT_TEMPLATE_COMPILER_VERSION } from '../document-template-compiler';
import { computeShapeChecksum } from '../document-shape-diff';
import { SOAP_NOTE_SLUG } from '../platform-document-shapes';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockTemplateRepository = {
  findAll: vi.fn(),
  findById: vi.fn(),
  findByTenantAndSlug: vi.fn(),
  findDefaultForTenant: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};

const mockVersionRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findAllForTemplate: vi.fn(),
  findLatestForTemplate: vi.fn(),
  findByTemplateAndVersionNumber: vi.fn(),
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DocumentTemplateFactory: {
      CreateDocumentTemplate: vi.fn((data) => ({
        ...data,
        id: 'template-new',
        pinnedVersionNumber: null,
        createdAt: new Date('2026-08-26T00:00:00Z'),
        updatedAt: new Date('2026-08-26T00:00:00Z'),
        version: 1,
      })),
    },
    DocumentTemplateVersionFactory: {
      CreateDocumentTemplateVersion: vi.fn((data) => ({
        ...data,
        id: `version-${data.versionNumber}`,
        createdAt: new Date('2026-08-26T00:00:00Z'),
        version: 1,
      })),
    },
  };
});

const SHAPE_V1 = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [
    { key: 'admission_reason', title: 'Reason for Admission', form: 'PROSE', required: true },
    { key: 'follow_up', title: 'Follow-up', form: 'PROSE' },
  ],
};

/** ADDITIVE over v1: one NEW optional section. */
const SHAPE_V2_ADDITIVE = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [...SHAPE_V1.sections, { key: 'procedures', title: 'Procedures', form: 'BULLETS' }],
};

/** BREAKING: `follow_up` is gone. */
const SHAPE_V2_REMOVED = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [SHAPE_V1.sections[0]],
};

/** BREAKING: `follow_up` becomes required — the model loses its "not discussed" option. */
const SHAPE_V2_NEWLY_REQUIRED = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [SHAPE_V1.sections[0], { key: 'follow_up', title: 'Follow-up', form: 'PROSE', required: true }],
};

const createTemplateEntity = (overrides: Record<string, unknown> = {}) => {
  const base = {
    id: 'template-1',
    tenantId: 'tenant-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 1,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-08-26T00:00:00Z'),
    updatedAt: new Date('2026-08-26T00:00:00Z'),
    version: 1,
    hasChanges: true,
    changes: {},
    ...overrides,
  };
  return { ...base, toObject: () => ({ ...base }) };
};

const createVersionEntity = (versionNumber: number, shape: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: `version-${versionNumber}`,
  tenantId: 'tenant-1',
  templateId: 'template-1',
  versionNumber,
  shape,
  compiled: { compilerVersion: DOCUMENT_TEMPLATE_COMPILER_VERSION, sectionKeys: ['admission_reason'], responseFormat: { type: 'json_schema' } },
  compilerVersion: DOCUMENT_TEMPLATE_COMPILER_VERSION,
  checksum: computeShapeChecksum(shape),
  changeReason: null,
  createdAt: new Date('2026-08-26T00:00:00Z'),
  version: 1,
  ...overrides,
});

describe('DocumentTemplateService', () => {
  let service: DocumentTemplateService;

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
    mockTemplateRepository.update.mockImplementation(async (_id, entity) => entity);

    service = new DocumentTemplateService(
      mockTemplateRepository as never,
      mockVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  describe('publish — shape validation', () => {
    it('REJECTS a section declaring a form outside the closed set, and writes no version', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity({ status: 'DRAFT', pinnedVersionNumber: null }));

      await expect(
        service.publish('template-1', { shape: { schemaVersion: '1.0', title: 'x', sections: [{ key: 'a1', title: 'A', form: 'HAIKU' }] } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an `if`/`then`/`else` STRUCTURED field schema (the authorable subset)', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity({ status: 'DRAFT', pinnedVersionNumber: null }));

      await expect(
        service.publish('template-1', {
          shape: {
            schemaVersion: '1.0',
            title: 'x',
            sections: [{ key: 'vitals', title: 'Vitals', form: 'STRUCTURED', fields: { type: 'object', if: {}, then: {} } }],
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('publish — the compile step', () => {
    it('FREEZES the compiled artifacts onto the version row alongside the shape', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity({ status: 'DRAFT', pinnedVersionNumber: null }));
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(null);
      mockVersionRepository.create.mockImplementation(async (entity) => entity);

      await service.publish('template-1', { shape: SHAPE_V1 });

      const written = mockVersionRepository.create.mock.calls[0][0];
      expect(written.versionNumber).toBe(1);
      expect(written.compilerVersion).toBe(DOCUMENT_TEMPLATE_COMPILER_VERSION);
      // The whole point of compiling at PUBLISH: what constrained the model is
      // a property of the pinned version, not of whatever compiler happens to
      // be deployed when a consultation runs.
      expect(written.compiled.responseFormat.strict).toBe(true);
      expect(written.compiled.sectionKeys).toEqual(['admission_reason', 'follow_up']);
      expect(written.compiled.responseFormat.json_schema.properties.follow_up.type).toEqual(['string', 'null']);
    });

    it('moves the pin and marks the template PUBLISHED', async () => {
      const entity = createTemplateEntity({ status: 'DRAFT', pinnedVersionNumber: null });
      mockTemplateRepository.findById.mockResolvedValue(entity);
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(null);
      mockVersionRepository.create.mockImplementation(async (v) => v);

      const result = await service.publish('template-1', { shape: SHAPE_V1 });

      expect(result.pinnedVersionNumber).toBe(1);
      expect(result.status).toBe('PUBLISHED');
    });

    it('does NOT drop an APPROVED template back to PUBLISHED on re-publish', async () => {
      const entity = createTemplateEntity({ status: 'APPROVED' });
      mockTemplateRepository.findById.mockResolvedValue(entity);
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(createVersionEntity(1, SHAPE_V1));
      mockVersionRepository.create.mockImplementation(async (v) => v);

      const result = await service.publish('template-1', { shape: SHAPE_V2_ADDITIVE });

      // Re-publishing must not silently discard a clinical sign-off.
      expect(result.status).toBe('APPROVED');
      expect(result.pinnedVersionNumber).toBe(2);
    });
  });

  describe('publish — idempotency', () => {
    it('writes NOTHING and moves NOTHING when the shape is byte-identical', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity());
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(createVersionEntity(1, SHAPE_V1));

      const result = await service.publish('template-1', { shape: SHAPE_V1 });

      expect(mockVersionRepository.create).not.toHaveBeenCalled();
      expect(mockTemplateRepository.update).not.toHaveBeenCalled();
      expect(result.pinnedVersionNumber).toBe(1);
    });

    it('ignores key ORDER but not array order (canonical JSON)', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity());
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(createVersionEntity(1, SHAPE_V1));

      const reordered = { sections: SHAPE_V1.sections, title: SHAPE_V1.title, schemaVersion: SHAPE_V1.schemaVersion };
      await service.publish('template-1', { shape: reordered });

      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('DOES mint a new version when the shape is identical but the COMPILER moved', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity());
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(createVersionEntity(1, SHAPE_V1, { compilerVersion: '0.9.0' }));
      mockVersionRepository.create.mockImplementation(async (v) => v);

      await service.publish('template-1', { shape: SHAPE_V1 });

      // On a checksum-only predicate this would be a no-op, leaving the pin
      // serving artifacts the current compiler would no longer produce and
      // nothing in the row to say so.
      expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
      expect(mockVersionRepository.create.mock.calls[0][0].compilerVersion).toBe(DOCUMENT_TEMPLATE_COMPILER_VERSION);
    });
  });

  describe('publish — the breaking-change gate', () => {
    beforeEach(() => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity());
      mockVersionRepository.findLatestForTemplate.mockResolvedValue(createVersionEntity(1, SHAPE_V1));
      mockVersionRepository.create.mockImplementation(async (v) => v);
    });

    it('publishes an ADDITIVE change with no acknowledgement', async () => {
      await service.publish('template-1', { shape: SHAPE_V2_ADDITIVE });
      expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
    });

    it('REFUSES a removed section and names the break in the message', async () => {
      await expect(service.publish('template-1', { shape: SHAPE_V2_REMOVED })).rejects.toMatchObject({
        response: { breakingChanges: [expect.stringContaining('follow_up')] },
      });
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('REFUSES a section newly made `required` — that is where confabulation comes back', async () => {
      await expect(service.publish('template-1', { shape: SHAPE_V2_NEWLY_REQUIRED })).rejects.toMatchObject({
        response: { breakingChanges: [expect.stringContaining('D-21')] },
      });
    });

    it('publishes a break once acknowledged', async () => {
      await service.publish('template-1', { shape: SHAPE_V2_REMOVED, allowBreakingChange: true });
      expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('cross-tenant posture', () => {
    it('answers 404 (never 403) for a template owned by another tenant, BEFORE validating the shape', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity({ tenantId: 'tenant-2' }));

      // The shape here is nonsense; the point is the caller never finds out.
      await expect(service.publish('template-1', { shape: { nope: true } })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
    });

    it('answers 404 for a cross-tenant getById', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity({ tenantId: 'tenant-2' }));
      await expect(service.getById('template-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('pin', () => {
    it('404s when the named version does not exist', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity());
      mockVersionRepository.findByTemplateAndVersionNumber.mockResolvedValue(null);

      await expect(service.pin('template-1', { versionNumber: 9 })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('moves the pin to an existing version (the rollback path)', async () => {
      mockTemplateRepository.findById.mockResolvedValue(createTemplateEntity({ pinnedVersionNumber: 3 }));
      mockVersionRepository.findByTemplateAndVersionNumber.mockResolvedValue(createVersionEntity(1, SHAPE_V1));

      const result = await service.pin('template-1', { versionNumber: 1 });
      expect(result.pinnedVersionNumber).toBe(1);
    });
  });

  describe('resolveForGeneration', () => {
    it('serves the PINNED version, not the latest', async () => {
      mockTemplateRepository.findDefaultForTenant.mockResolvedValue(createTemplateEntity({ pinnedVersionNumber: 1 }));
      mockVersionRepository.findByTemplateAndVersionNumber.mockResolvedValue(createVersionEntity(1, SHAPE_V1));

      const resolved = await service.resolveForGeneration('tenant-1');

      expect(mockVersionRepository.findByTemplateAndVersionNumber).toHaveBeenCalledWith('template-1', 1);
      expect(resolved.documentTemplateVersionId).toBe('version-1');
      expect(resolved.versionNumber).toBe(1);
    });

    it('falls back to the compiled PLATFORM shape when the tenant configured nothing', async () => {
      mockTemplateRepository.findDefaultForTenant.mockResolvedValue(null);

      const resolved = await service.resolveForGeneration('tenant-1');

      expect(resolved.templateId).toBeNull();
      expect(resolved.slug).toBe(SOAP_NOTE_SLUG);
      expect(resolved.compiled.sectionKeys).toEqual(['subjective', 'objective', 'assessment', 'plan']);
    });

    it('falls back rather than THROWING when the repository fails — a live consultation must not die', async () => {
      mockTemplateRepository.findDefaultForTenant.mockRejectedValue(new Error('database is on fire'));

      const resolved = await service.resolveForGeneration('tenant-1');

      expect(resolved.templateId).toBeNull();
      expect(resolved.compiled.responseFormat.strict).toBe(true);
    });

    it('falls back when a template is published but its pin dangles', async () => {
      mockTemplateRepository.findDefaultForTenant.mockResolvedValue(createTemplateEntity({ pinnedVersionNumber: 7 }));
      mockVersionRepository.findByTemplateAndVersionNumber.mockResolvedValue(null);

      const resolved = await service.resolveForGeneration('tenant-1');
      expect(resolved.templateId).toBeNull();
    });

    it('does NOT silently serve the default when an explicitly named slug is unservable', async () => {
      // The bind was explicit. Generating a DIFFERENT document than the one the
      // workflow named would be worse than the platform fallback, which the
      // caller can at least detect from `templateId: null`.
      mockTemplateRepository.findByTenantAndSlug.mockResolvedValue(createTemplateEntity({ status: 'DRAFT', pinnedVersionNumber: null }));

      const resolved = await service.resolveForGeneration('tenant-1', 'discharge_summary');

      expect(mockTemplateRepository.findDefaultForTenant).not.toHaveBeenCalled();
      expect(resolved.templateId).toBeNull();
    });
  });

  describe('getEffectiveBundle', () => {
    it('returns a 200-shaped null bundle with ETag "none" for an unconfigured tenant', async () => {
      mockTemplateRepository.findDefaultForTenant.mockResolvedValue(null);

      const bundle = await service.getEffectiveBundle();

      expect(bundle.templateId).toBeNull();
      expect(bundle.etag).toBe('"none"');
    });

    it('serves an ETag over the SHAPE bytes, not the head row’s `_version`', async () => {
      mockTemplateRepository.findDefaultForTenant.mockResolvedValue(createTemplateEntity({ version: 1 }));
      mockVersionRepository.findByTemplateAndVersionNumber.mockResolvedValue(createVersionEntity(1, SHAPE_V1));
      const first = await service.getEffectiveBundle();

      // Renaming a template bumps `_version` but changes nothing that is served.
      mockTemplateRepository.findDefaultForTenant.mockResolvedValue(createTemplateEntity({ version: 99, name: 'Renamed' }));
      const second = await service.getEffectiveBundle();

      expect(second.etag).toBe(first.etag);
    });
  });
});
