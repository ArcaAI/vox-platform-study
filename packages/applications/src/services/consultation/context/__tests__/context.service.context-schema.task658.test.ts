/**
 * The context-schema validation hook on `ContextService`.
 *
 * The FIRST test in this file is the most important one: an
 * existing context write that names no `kindKey` must behave EXACTLY as it did
 * before schema validation — same factory call, same encryption, same version row, same
 * sys-event, same ContextAdded fan-out, and no schema lookup whatsoever. The
 * schema plane is opt-in per write; anything else would make every clinician
 * in every tenant depend on a tenant admin having configured a schema.
 */
import { ContextItemSource, ContextItemType, SysEventType } from '@arcaai/domains';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextService } from '../context.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const createdItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'ctx-1',
  tenantId: 'tenant-1',
  consultationId: 'consultation-1',
  type: ContextItemType.CASE_NOTE,
  source: ContextItemSource.USER,
  content: 'hello',
  kindKey: null,
  contextSchemaVersionId: null,
  currentVersionNumber: 1,
  createdAt: new Date('2026-08-11T00:00:00Z'),
  updatedAt: new Date('2026-08-11T00:00:00Z'),
  version: 1,
  // Plain-object stand-in for BaseEntity change tracking, as in the sibling
  // ContextService suites.
  changes: {},
  ...overrides,
});

const mockContextItemRepository = {
  create: vi.fn(async (entity) => ({ ...createdItem(), ...entity })),
  findById: vi.fn(),
  findAll: vi.fn(async () => []),
  update: vi.fn(),
  // TASK-709: updateContext now writes through the OCC-aware
  // Compare-And-Set variant; delegate to `update` so this suite's existing
  // `.update` configuration keeps driving behavior unchanged.
  updateWithVersion: vi.fn((id: string, entity: unknown, _expectedVersion?: number, _tx?: unknown) => mockContextItemRepository.update(id, entity)),
};
const mockContextItemVersionRepository = {
  create: vi.fn(),
  getLatestVersionNumber: vi.fn(async () => 1),
  encryptFieldsIntoEntity: vi.fn(),
};
const mockConsultationRepository = {
  findById: vi.fn(async () => ({ id: 'consultation-1', tenantId: 'tenant-1' })),
};
const noopRepository = { findAll: vi.fn(async () => []), create: vi.fn(), findById: vi.fn() };

const mockSchemaService = {
  validateContextPayload: vi.fn(),
};

function buildService(withSchemaService: boolean) {
  return new ContextService(
    mockContextItemRepository as never,
    mockContextItemVersionRepository as never,
    noopRepository as never,
    noopRepository as never,
    noopRepository as never,
    mockConsultationRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    withSchemaService ? (mockSchemaService as never) : undefined,
  );
}

describe('ContextService — context-schema hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'user-1' };
      return undefined;
    });
    mockContextItemRepository.create.mockImplementation(async (entity) => ({ ...createdItem(), ...entity }));
    mockContextItemVersionRepository.getLatestVersionNumber.mockResolvedValue(1);
  });

  describe('REGRESSION (AC-9) — a write with no kindKey is untouched', () => {
    it('does not consult the schema service at all', async () => {
      const service = buildService(true);

      await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' });

      expect(mockSchemaService.validateContextPayload).not.toHaveBeenCalled();
    });

    it('persists no kindKey / contextSchemaVersionId, and still versions + broadcasts + fans out', async () => {
      const service = buildService(true);

      await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' });

      const persisted = mockContextItemRepository.create.mock.calls[0][0];
      expect(persisted.kindKey ?? null).toBeNull();
      expect(persisted.contextSchemaVersionId ?? null).toBeNull();

      // Version row for a non-media type, unchanged.
      expect(mockContextItemVersionRepository.create).toHaveBeenCalledTimes(1);
      // Sys-event, unchanged.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
      // Live ContextAdded fan-out for CASE_NOTE, unchanged.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('consultation.context.added', expect.objectContaining({ contextType: 'CASE_NOTE' }));
    });

    it('behaves identically when the schema service is not wired at all', async () => {
      const service = buildService(false);

      const result = await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' });

      expect(result.id).toBe('ctx-1');
      expect(mockContextItemRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('a write that DOES name a kind', () => {
    it('validates against the schema and stamps kindKey + contextSchemaVersionId onto the row', async () => {
      const service = buildService(true);
      mockSchemaService.validateContextPayload.mockResolvedValue({
        kindKey: 'intake',
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'version-1',
        content: '{"severity":"mild"}',
      });

      await service.addContext('consultation-1', {
        type: ContextItemType.STRUCTURED,
        kindKey: 'intake',
        payload: { severity: 'mild' },
      });

      expect(mockSchemaService.validateContextPayload).toHaveBeenCalledWith(
        expect.objectContaining({ kindKey: 'intake', payload: { severity: 'mild' } }),
      );
      const persisted = mockContextItemRepository.create.mock.calls[0][0];
      expect(persisted.kindKey).toBe('intake');
      expect(persisted.contextSchemaVersionId).toBe('version-1');
      // The validated STRUCTURED payload becomes `content`, so it rides the
      // existing PHI encryption path rather than a new plaintext column.
      expect(persisted.content).toBe('{"severity":"mild"}');
    });

    it('propagates the validation failure and persists NOTHING', async () => {
      const service = buildService(true);
      mockSchemaService.validateContextPayload.mockRejectedValue(new BadRequestException('nope'));

      await expect(
        service.addContext('consultation-1', { type: ContextItemType.STRUCTURED, kindKey: 'intake', payload: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockContextItemRepository.create).not.toHaveBeenCalled();
    });

    it('fails closed when a kind is named but the schema plane is not wired', async () => {
      const service = buildService(false);

      await expect(
        service.addContext('consultation-1', { type: ContextItemType.STRUCTURED, kindKey: 'intake', payload: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockContextItemRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a `payload` submitted without a `kindKey` — there would be nothing to validate it against', async () => {
      const service = buildService(true);

      await expect(
        service.addContext('consultation-1', { type: ContextItemType.STRUCTURED, payload: { severity: 'mild' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockSchemaService.validateContextPayload).not.toHaveBeenCalled();
    });
  });

  describe('updateContext', () => {
    it('re-validates through the SAME seam, against the version the row was written with', async () => {
      const service = buildService(true);
      mockContextItemRepository.findById.mockResolvedValue({
        ...createdItem({ kindKey: 'intake', contextSchemaVersionId: 'version-1' }),
        markQdrantNeedsSync: vi.fn(),
      });
      mockContextItemRepository.update.mockImplementation(async (_id, entity) => entity);
      mockSchemaService.validateContextPayload.mockResolvedValue({
        kindKey: 'intake',
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'version-1',
        content: '{"severity":"severe"}',
      });

      await service.updateContext('ctx-1', { payload: { severity: 'severe' } });

      expect(mockSchemaService.validateContextPayload).toHaveBeenCalledWith(
        expect.objectContaining({ kindKey: 'intake', contextSchemaVersionId: 'version-1' }),
      );
    });

    it('leaves a kind-less item on exactly its old path', async () => {
      const service = buildService(true);
      mockContextItemRepository.findById.mockResolvedValue({
        ...createdItem(),
        markQdrantNeedsSync: vi.fn(),
      });
      mockContextItemRepository.update.mockImplementation(async (_id, entity) => entity);

      await service.updateContext('ctx-1', { content: 'edited' });

      expect(mockSchemaService.validateContextPayload).not.toHaveBeenCalled();
    });
  });
});
