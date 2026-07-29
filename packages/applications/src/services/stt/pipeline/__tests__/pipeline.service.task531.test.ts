/**
 * Pipeline template governance.
 *
 * Covers two service-layer behaviours of `PipelineService`:
 *
 *   1. LOCKED TEMPLATE COPIES are read-only for content edits and delete.
 *      A tenant's 9 provisioned pipelines are copies of the SYSTEM templates;
 *      `update()`/`delete()` on one answers 403 with actionable guidance.
 *      `toggle()` and `setDefault()` stay ALLOWED — a tenant may still
 *      enable/disable a copy or elect it as their default.
 *
 *   2. CLONE is the sanctioned customization path: it produces an UNLOCKED row
 *      that keeps its template provenance and carries the source's current
 *      config forward as the clone's v1 version snapshot.
 *
 * Guard ORDER matters and is asserted explicitly: the cross-tenant ownership
 * check (404) must run BEFORE the lock check (403), or the lock message would
 * confirm the existence of another tenant's pipeline — leaking exactly what the
 * house 404-over-403 posture hides.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineService } from '../pipeline.service';

const LOCK_MESSAGE = 'Template copies are read-only — clone to customize';

const ResourceStatusType = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  DELETED: 'DELETED',
} as const;

const SysEventType = {
  ResourceCreated: 'SysEvent.ResourceCreated',
  ResourceUpdated: 'SysEvent.ResourceUpdated',
  ResourceDeleted: 'SysEvent.ResourceDeleted',
} as const;

const validConfigYaml = `
version: "1.0"
models:
  asr: "whisper-large-v3"
`;

const customizedConfigYaml = `
version: "1.0"
models:
  asr: "whisper-tiny"
`;

/** Minimal behavioural pipeline entity (mirrors pipeline.service.test.ts). */
function createPipelineEntity(
  overrides: {
    id?: string;
    tenantId?: string;
    name?: string;
    slug?: string;
    configYaml?: string;
    version?: number;
    templateLocked?: boolean;
    sourceTemplateSlug?: string | null;
  } = {},
) {
  let _name = overrides.name ?? 'Production Whisper';
  let _slug = overrides.slug ?? 'production-whisper-large-v3';
  let _configYaml = overrides.configYaml ?? validConfigYaml;
  let _resourceStatus: string = ResourceStatusType.ENABLED;
  const _changes: Record<string, unknown> = {};

  return {
    id: overrides.id ?? 'pipeline-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    description: 'A pipeline',
    tags: ['matrix'],
    version: overrides.version ?? 3,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'user-1',
    updatedBy: null,
    isDefault: false,
    templateLocked: overrides.templateLocked ?? false,
    sourceTemplateSlug: overrides.sourceTemplateSlug ?? null,

    get name() {
      return _name;
    },
    set name(v: string) {
      _name = v;
      _changes.name = v;
    },
    get slug() {
      return _slug;
    },
    set slug(v: string) {
      _slug = v;
      _changes.slug = v;
    },
    get configYaml() {
      return _configYaml;
    },
    set configYaml(v: string) {
      _configYaml = v;
      _changes.configYaml = v;
    },
    get resourceStatus() {
      return _resourceStatus;
    },
    get changes() {
      return _changes;
    },
    get hasChanges() {
      return Object.keys(_changes).length > 0;
    },
    get isEnabled() {
      return _resourceStatus === ResourceStatusType.ENABLED;
    },
    enable() {
      _resourceStatus = ResourceStatusType.ENABLED;
      _changes.resourceStatus = _resourceStatus;
    },
    disable() {
      _resourceStatus = ResourceStatusType.DISABLED;
      _changes.resourceStatus = _resourceStatus;
    },
  };
}

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPipelineRepository = {
  findById: vi.fn(),
  findBySlug: vi.fn(),
  findAll: vi.fn(),
  findEnabledPipelines: vi.fn(),
  findAllForAdmin: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  isSlugUnique: vi.fn(),
  findDefault: vi.fn(),
  setDefaultForTenant: vi.fn(),
};

const mockVersionRepository = {
  getNextVersionNumber: vi.fn(),
  create: vi.fn(),
  findByPipeline: vi.fn(),
};

const mockEntitlements = {
  isEnforcementEnabled: vi.fn(),
  assertQuantityQuota: vi.fn(),
};

describe('PipelineService — template governance', () => {
  let service: PipelineService;

  beforeEach(() => {
    vi.clearAllMocks();
    // validateYaml hops to stt; keep unit tests off the network.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'current-user-id' };
        case 'tenantId':
          return 'tenant-1';
        default:
          return null;
      }
    });

    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockPipelineRepository.isSlugUnique.mockResolvedValue(true);
    mockPipelineRepository.create.mockImplementation(async (e: unknown) => e);
    mockPipelineRepository.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
    mockVersionRepository.findByPipeline.mockResolvedValue([]);
    mockVersionRepository.getNextVersionNumber.mockResolvedValue(1);

    service = new PipelineService(
      mockPipelineRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockVersionRepository as never,
      mockEntitlements as never,
    );
  });

  // ===================================================================
  // 1. Locked copies reject content edits and delete
  // ===================================================================

  describe('write guards on locked template copies', () => {
    it('update() on a locked copy throws Forbidden with the clone guidance', async () => {
      mockPipelineRepository.findById.mockResolvedValue(
        createPipelineEntity({ templateLocked: true, sourceTemplateSlug: 'production-whisper-large-v3' }),
      );

      await expect(service.update('pipeline-1', { name: 'Mine', expectedVersion: 3 })).rejects.toThrow(ForbiddenException);
      await expect(service.update('pipeline-1', { name: 'Mine', expectedVersion: 3 })).rejects.toThrow(LOCK_MESSAGE);
      expect(mockPipelineRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('delete() on a locked copy throws Forbidden with the clone guidance', async () => {
      mockPipelineRepository.findById.mockResolvedValue(
        createPipelineEntity({ templateLocked: true, sourceTemplateSlug: 'production-whisper-large-v3' }),
      );

      await expect(service.delete('pipeline-1')).rejects.toThrow(ForbiddenException);
      await expect(service.delete('pipeline-1')).rejects.toThrow(LOCK_MESSAGE);
      expect(mockPipelineRepository.softDelete).not.toHaveBeenCalled();
    });

    it('update()/delete() on an UNLOCKED row are unaffected', async () => {
      mockPipelineRepository.findById.mockResolvedValue(createPipelineEntity({ templateLocked: false }));

      await expect(service.update('pipeline-1', { name: 'Mine', expectedVersion: 3 })).resolves.toBeDefined();
      expect(mockPipelineRepository.updateWithVersion).toHaveBeenCalled();

      await expect(service.delete('pipeline-1')).resolves.toBeUndefined();
      expect(mockPipelineRepository.softDelete).toHaveBeenCalled();
    });

    // The lock covers CONTENT only. A tenant still owns the lifecycle of
    // their copy — enabling/disabling it and choosing it as their default.
    it('toggle() on a locked copy still succeeds', async () => {
      mockPipelineRepository.findById.mockResolvedValue(createPipelineEntity({ templateLocked: true }));

      await expect(service.toggle('pipeline-1', false, 3)).resolves.toBeDefined();
      expect(mockPipelineRepository.updateWithVersion).toHaveBeenCalled();
    });

    it('setDefault() on a locked copy still succeeds', async () => {
      mockPipelineRepository.findById.mockResolvedValue(createPipelineEntity({ templateLocked: true }));
      mockPipelineRepository.setDefaultForTenant.mockResolvedValue(undefined);

      await expect(service.setDefault('pipeline-1')).resolves.toBeDefined();
      expect(mockPipelineRepository.setDefaultForTenant).toHaveBeenCalledWith('tenant-1', 'pipeline-1', 'current-user-id');
    });
  });

  // ===================================================================
  // 2. Guard ORDER — ownership (404) before lock (403)
  // ===================================================================

  describe('cross-tenant probes never see the lock signal', () => {
    const foreignLocked = () => createPipelineEntity({ tenantId: 'tenant-OTHER', templateLocked: true });

    it('update() on another tenant’s locked row throws NotFound, not Forbidden', async () => {
      mockPipelineRepository.findById.mockResolvedValue(foreignLocked());
      const call = service.update('pipeline-1', { name: 'x', expectedVersion: 3 });
      await expect(call).rejects.toThrow(NotFoundException);
      await expect(call).rejects.not.toThrow(LOCK_MESSAGE);
    });

    it('delete() on another tenant’s locked row throws NotFound, not Forbidden', async () => {
      mockPipelineRepository.findById.mockResolvedValue(foreignLocked());
      const call = service.delete('pipeline-1');
      await expect(call).rejects.toThrow(NotFoundException);
      await expect(call).rejects.not.toThrow(LOCK_MESSAGE);
    });

    it('clone() of another tenant’s row throws NotFound', async () => {
      mockPipelineRepository.findById.mockResolvedValue(foreignLocked());
      await expect(service.clone('pipeline-1', { name: 'Copy', slug: 'copy' })).rejects.toThrow(NotFoundException);
      expect(mockPipelineRepository.create).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // 3. Clone — the sanctioned customization path
  // ===================================================================

  describe('clone()', () => {
    const lockedSource = () =>
      createPipelineEntity({
        id: 'source-1',
        templateLocked: true,
        sourceTemplateSlug: 'production-whisper-large-v3',
        configYaml: validConfigYaml,
      });

    it('produces an UNLOCKED row that keeps the template provenance', async () => {
      mockPipelineRepository.findById.mockResolvedValue(lockedSource());

      await service.clone('source-1', { name: 'My Whisper', slug: 'my-whisper' });

      expect(mockPipelineRepository.create).toHaveBeenCalledTimes(1);
      const created = mockPipelineRepository.create.mock.calls[0][0];
      expect(created.templateLocked).toBe(false);
      expect(created.sourceTemplateSlug).toBe('production-whisper-large-v3');
      expect(created.name).toBe('My Whisper');
      expect(created.slug).toBe('my-whisper');
      expect(created.tenantId).toBe('tenant-1');
      // Built through the factory — a real id was generated, not reused.
      expect(created.id).toBeDefined();
      expect(created.id).not.toBe('source-1');
    });

    it('propagates lineage through clone chains (clone of a clone)', async () => {
      mockPipelineRepository.findById.mockResolvedValue(
        createPipelineEntity({
          id: 'clone-1',
          templateLocked: false,
          sourceTemplateSlug: 'production-whisper-large-v3',
        }),
      );

      await service.clone('clone-1', { name: 'Second', slug: 'second' });

      expect(mockPipelineRepository.create.mock.calls[0][0].sourceTemplateSlug).toBe('production-whisper-large-v3');
    });

    it('leaves lineage null when cloning a wholly hand-made pipeline', async () => {
      mockPipelineRepository.findById.mockResolvedValue(createPipelineEntity({ id: 'hand-1', templateLocked: false, sourceTemplateSlug: null }));

      await service.clone('hand-1', { name: 'Copy', slug: 'copy' });

      expect(mockPipelineRepository.create.mock.calls[0][0].sourceTemplateSlug).toBeNull();
    });

    it("copies the source's CURRENT version config as the clone's v1", async () => {
      mockPipelineRepository.findById.mockResolvedValue(lockedSource());
      mockVersionRepository.findByPipeline.mockResolvedValue([
        { versionNumber: 4, configYaml: customizedConfigYaml },
        { versionNumber: 3, configYaml: validConfigYaml },
      ]);
      mockVersionRepository.getNextVersionNumber.mockResolvedValue(1);

      await service.clone('source-1', { name: 'Copy', slug: 'copy' });

      expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
      const version = mockVersionRepository.create.mock.calls[0][0];
      expect(version.versionNumber).toBe(1);
      // newest-first: the v4 snapshot is the source's current config
      expect(version.configYaml).toBe(customizedConfigYaml);
    });

    it("falls back to the source's pipeline-level YAML when it has no version rows", async () => {
      mockPipelineRepository.findById.mockResolvedValue(lockedSource());
      mockVersionRepository.findByPipeline.mockResolvedValue([]);

      await service.clone('source-1', { name: 'Copy', slug: 'copy' });

      expect(mockVersionRepository.create.mock.calls[0][0].configYaml).toBe(validConfigYaml);
    });

    it('broadcasts ResourceCreated carrying the clone provenance', async () => {
      mockPipelineRepository.findById.mockResolvedValue(lockedSource());

      await service.clone('source-1', { name: 'Copy', slug: 'copy' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          data: expect.objectContaining({
            clonedFrom: 'source-1',
            sourceTemplateSlug: 'production-whisper-large-v3',
          }),
        }),
      );
    });

    it('rejects a duplicate slug with 400', async () => {
      mockPipelineRepository.findById.mockResolvedValue(lockedSource());
      mockPipelineRepository.isSlugUnique.mockResolvedValue(false);

      await expect(service.clone('source-1', { name: 'Copy', slug: 'taken' })).rejects.toThrow(BadRequestException);
      expect(mockPipelineRepository.create).not.toHaveBeenCalled();
    });

    it('enforces the maxAsrPipelines quota when enforcement is on', async () => {
      mockPipelineRepository.findById.mockResolvedValue(lockedSource());
      mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
      mockPipelineRepository.count.mockResolvedValue(7);

      await service.clone('source-1', { name: 'Copy', slug: 'copy' });

      expect(mockEntitlements.assertQuantityQuota).toHaveBeenCalledWith('tenant-1', 'maxAsrPipelines', 7);
    });

    it('throws NotFound when the source does not exist', async () => {
      mockPipelineRepository.findById.mockResolvedValue(null);

      await expect(service.clone('missing', { name: 'Copy', slug: 'copy' })).rejects.toThrow(NotFoundException);
    });
  });
});
