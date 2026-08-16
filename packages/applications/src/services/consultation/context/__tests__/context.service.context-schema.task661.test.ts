/**
 * Schema compatibility and lifecycle, at the `ContextService` seam.
 *
 * The earlier context-schema hook built `resolveContextKind`/`addContext`/`updateContext` and wrote
 * the first K7 regression
 * (`context.service.context-schema.task658.test.ts`): a write naming no
 * `kindKey` consults the schema service AT ALL. This file adds the version-header
 * behaviour:
 *
 *  - K7, **written first, as required** — the version-pinning HEADER this
 *    ticket introduces must have ZERO effect on a write that names no
 *    `kindKey`. Carrying `X-Context-Schema-Version` around is meaningless
 *    when there is no schema-governed write to pin; the fallback contract
 *    (every existing consultation, no schema, no kindKey, behaves exactly as
 *    it does today) must hold with or without the header present.
 *  - The header (`contextSchemaVersionId`, threaded down from the
 *    controller) reaches `IConsultationContextSchemaService.validateContextPayload`
 *    on `addContext` — `updateContext` was already wired to the ITEM's
 *    own pinned version; `addContext` had no such thread yet.
 *  - A write with NO header (the overwhelmingly common case) is byte-for-byte
 *    what it was before this ticket — `contextSchemaVersionId: undefined` is
 *    passed through, so `ConsultationContextSchemaService` resolves the
 *    tenant's CURRENT pin exactly as it always has.
 */
import { ContextItemSource, ContextItemType, SysEventType } from '@arcaai/domains';
import { Logger } from '@nestjs/common';
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

function buildService() {
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
    mockSchemaService as never,
  );
}

describe('ContextService — version header on addContext', () => {
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

  describe('K7 — a version header with no kindKey has ZERO effect (written first)', () => {
    it('does not consult the schema service, header or not', async () => {
      const service = buildService();

      await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' }, 'version-99');

      expect(mockSchemaService.validateContextPayload).not.toHaveBeenCalled();
    });

    it('persists identically whether or not a version header is present', async () => {
      const service = buildService();

      const withoutHeader = await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' });
      vi.clearAllMocks();
      mockContextItemRepository.create.mockImplementation(async (entity) => ({ ...createdItem(), ...entity }));
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'user-1' };
        return undefined;
      });
      const withHeader = await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' }, 'version-99');

      expect(withHeader.kindKey ?? null).toBe(withoutHeader.kindKey ?? null);
      expect(withHeader.contextSchemaVersionId ?? null).toBe(withoutHeader.contextSchemaVersionId ?? null);
      expect(mockSchemaService.validateContextPayload).not.toHaveBeenCalled();
    });
  });

  describe('a write that DOES name a kind threads the header through', () => {
    it('passes the header value as `contextSchemaVersionId` to validateContextPayload', async () => {
      const service = buildService();
      mockSchemaService.validateContextPayload.mockResolvedValue({
        kindKey: 'intake',
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'version-3',
        content: '{"severity":"mild"}',
      });

      await service.addContext(
        'consultation-1',
        { type: ContextItemType.STRUCTURED, kindKey: 'intake', payload: { severity: 'mild' } },
        'version-3',
      );

      expect(mockSchemaService.validateContextPayload).toHaveBeenCalledWith(
        expect.objectContaining({ kindKey: 'intake', payload: { severity: 'mild' }, contextSchemaVersionId: 'version-3' }),
      );
    });

    it('with NO header, `contextSchemaVersionId` is undefined — the service resolves the CURRENT pin exactly as before', async () => {
      const service = buildService();
      mockSchemaService.validateContextPayload.mockResolvedValue({
        kindKey: 'intake',
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'version-5',
        content: '{"severity":"mild"}',
      });

      await service.addContext('consultation-1', { type: ContextItemType.STRUCTURED, kindKey: 'intake', payload: { severity: 'mild' } });

      expect(mockSchemaService.validateContextPayload).toHaveBeenCalledWith(
        expect.objectContaining({ kindKey: 'intake', contextSchemaVersionId: undefined }),
      );
    });

    it('logs a warning when the resolved write reports BREAKING versionSkew, without failing the write', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = buildService();
      mockSchemaService.validateContextPayload.mockResolvedValue({
        kindKey: 'intake',
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'version-1',
        content: '{"severity":"mild"}',
        versionSkew: 'BREAKING',
      });

      const result = await service.addContext(
        'consultation-1',
        { type: ContextItemType.STRUCTURED, kindKey: 'intake', payload: { severity: 'mild' } },
        'version-1',
      );

      expect(result.id).toBe('ctx-1');
      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: 'context_schema_version_skew' }));
      warnSpy.mockRestore();
    });
  });

  describe('updateContext — unaffected regression', () => {
    it('still validates against the ITEM its own pinned version, never a header (updateContext has no header parameter)', async () => {
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
      const service = buildService();

      await service.updateContext('ctx-1', { payload: { severity: 'severe' } });

      expect(mockSchemaService.validateContextPayload).toHaveBeenCalledWith(
        expect.objectContaining({ kindKey: 'intake', contextSchemaVersionId: 'version-1' }),
      );
    });
  });

  it('sys-event and live fan-out are unaffected by the header (regression)', async () => {
    const service = buildService();

    await service.addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'hello' }, 'version-99');

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
    expect(mockEventEmitter.emit).toHaveBeenCalledWith('consultation.context.added', expect.objectContaining({ contextType: 'CASE_NOTE' }));
  });
});
