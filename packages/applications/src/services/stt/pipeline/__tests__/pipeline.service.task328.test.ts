/**
 * PipelineService — TASK-328 A6 extensions.
 *
 * Covers the backend audio-pipeline admin surface added in A6:
 *   • setDefault  — marks one pipeline as the tenant default (delegates the
 *                   "exactly one default" flip to the repository transaction).
 *   • toggle      — enable/disable via resourceStatus, OCC-guarded.
 *   • versioning  — a config-YAML change snapshots the next AsrPipelineVersion.
 *   • listVersions/getVersion — read the snapshot history (tenant-scoped).
 *
 * Only external boundaries (repositories, event emitter, CLS) are mocked.
 */

import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineService } from '../pipeline.service';

const ResourceStatusType = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    DELETED: 'DELETED',
} as const;

const SysEventType = {
    ResourceUpdated: 'SysEvent.ResourceUpdated',
} as const;

const validConfigYaml = `
version: "1.0"
models:
  asr: "whisper-large-v3"
`;

const changedConfigYaml = `
version: "1.0"
models:
  asr: "whisper-tiny"
`;

/** Minimal behavioral AsrPipeline entity for the A6 paths. */
function makePipeline(overrides: Partial<{ id: string; tenantId: string; slug: string; configYaml: string; resourceStatus: string; version: number; isDefault: boolean }> = {}) {
    let _status = overrides.resourceStatus ?? ResourceStatusType.ENABLED;
    const _changes: Record<string, unknown> = {};
    return {
        id: overrides.id ?? 'pipeline-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        name: 'Test Pipeline',
        slug: overrides.slug ?? 'test-pipeline',
        description: 'desc',
        configYaml: overrides.configYaml ?? validConfigYaml,
        tags: ['test'],
        version: overrides.version ?? 1,
        isDefault: overrides.isDefault ?? false,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        createdBy: 'user-123',
        updatedBy: null as string | null,
        get resourceStatus() { return _status; },
        enable() { _status = ResourceStatusType.ENABLED; _changes.resourceStatus = _status; },
        disable() { _status = ResourceStatusType.DISABLED; _changes.resourceStatus = _status; },
        get changes() { return _changes; },
    };
}

/** Minimal AsrPipelineVersion entity (mapper reads these + createdAt.toISOString()). */
function makeVersion(versionNumber: number, configYaml: string) {
    return {
        id: `ver-${versionNumber}`,
        asrPipelineId: 'pipeline-1',
        versionNumber,
        configYaml,
        name: 'Test Pipeline',
        description: 'desc',
        changeReason: 'reason',
        changedBy: 'user-123',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
}

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPipelineRepository = {
    findById: vi.fn(),
    updateWithVersion: vi.fn(),
    setDefaultForTenant: vi.fn(),
    findDefault: vi.fn(),
};

const mockVersionRepository = {
    getNextVersionNumber: vi.fn(),
    create: vi.fn(),
    findByPipeline: vi.fn(),
};

describe('PipelineService — TASK-328 A6', () => {
    let service: PipelineService;

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
        vi.clearAllMocks();
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user': return { id: 'current-user-id' };
                case 'tenantId': return 'tenant-1';
                default: return null;
            }
        });
        service = new PipelineService(
            mockPipelineRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
            mockVersionRepository as any,
        );
    });

    describe('setDefault', () => {
        it('delegates the atomic flip to setDefaultForTenant and returns the refreshed default', async () => {
            const before = makePipeline({ id: 'p-1', isDefault: false });
            const after = makePipeline({ id: 'p-1', isDefault: true });
            mockPipelineRepository.findById
                .mockResolvedValueOnce(before) // tenant-scope guard
                .mockResolvedValueOnce(after); // re-fetch after flip
            mockPipelineRepository.setDefaultForTenant.mockResolvedValue(undefined);

            const result = await service.setDefault('p-1');

            expect(mockPipelineRepository.setDefaultForTenant).toHaveBeenCalledWith('tenant-1', 'p-1', 'current-user-id');
            expect(result.isDefault).toBe(true);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'p-1',
                    data: expect.objectContaining({ isDefault: true }),
                }),
            );
        });

        it('throws NotFound for a cross-tenant pipeline (no leak) and never flips', async () => {
            mockPipelineRepository.findById.mockResolvedValue(makePipeline({ id: 'p-x', tenantId: 'tenant-other' }));

            await expect(service.setDefault('p-x')).rejects.toThrow(NotFoundException);
            expect(mockPipelineRepository.setDefaultForTenant).not.toHaveBeenCalled();
        });
    });

    describe('toggle', () => {
        it('disables a pipeline via CAS write and broadcasts the status change', async () => {
            const existing = makePipeline({ id: 'p-1', version: 4 });
            mockPipelineRepository.findById.mockResolvedValue(existing);
            mockPipelineRepository.updateWithVersion.mockImplementation(async (_id: any, entity: any) => ({ ...entity, version: 5 }));

            const result = await service.toggle('p-1', false, 4);

            expect(existing.resourceStatus).toBe(ResourceStatusType.DISABLED);
            expect(mockPipelineRepository.updateWithVersion).toHaveBeenCalledWith('p-1', existing, 4);
            expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({ resourceId: 'p-1', data: expect.objectContaining({ previousVersion: 4, newVersion: 5 }) }),
            );
        });

        it('throws NotFound for a cross-tenant pipeline', async () => {
            mockPipelineRepository.findById.mockResolvedValue(makePipeline({ tenantId: 'tenant-other' }));
            await expect(service.toggle('p-1', true, 1)).rejects.toThrow(NotFoundException);
        });
    });

    describe('versioning on update', () => {
        it('snapshots the next version when configYaml changes', async () => {
            const existing = makePipeline({ id: 'p-1', version: 2, configYaml: validConfigYaml });
            mockPipelineRepository.findById.mockResolvedValue(existing);
            mockPipelineRepository.updateWithVersion.mockImplementation(async (_id: any, entity: any) => ({ ...entity, version: 3 }));
            mockVersionRepository.getNextVersionNumber.mockResolvedValue(3);
            mockVersionRepository.create.mockImplementation(async (v: any) => v);

            await service.update('p-1', { configYaml: changedConfigYaml, changeReason: 'switch model', expectedVersion: 2 } as any);

            expect(mockVersionRepository.getNextVersionNumber).toHaveBeenCalledWith('p-1');
            expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
            const snapshot = mockVersionRepository.create.mock.calls[0][0];
            expect(snapshot.versionNumber).toBe(3);
            expect(snapshot.configYaml).toBe(changedConfigYaml);
            expect(snapshot.changeReason).toBe('switch model');
            expect(snapshot.asrPipelineId).toBe('p-1');
        });

        it('does NOT snapshot a version when configYaml is unchanged (name-only edit)', async () => {
            const existing = makePipeline({ id: 'p-1', version: 2, configYaml: validConfigYaml });
            mockPipelineRepository.findById.mockResolvedValue(existing);
            mockPipelineRepository.updateWithVersion.mockImplementation(async (_id: any, entity: any) => ({ ...entity, version: 3 }));

            await service.update('p-1', { name: 'Renamed', expectedVersion: 2 } as any);

            expect(mockVersionRepository.getNextVersionNumber).not.toHaveBeenCalled();
            expect(mockVersionRepository.create).not.toHaveBeenCalled();
        });
    });

    describe('listVersions / getVersion', () => {
        it('returns mapped snapshots newest-first as provided by the repo', async () => {
            mockPipelineRepository.findById.mockResolvedValue(makePipeline({ id: 'p-1' }));
            mockVersionRepository.findByPipeline.mockResolvedValue([makeVersion(3, changedConfigYaml), makeVersion(2, validConfigYaml), makeVersion(1, validConfigYaml)]);

            const result = await service.listVersions('p-1');

            expect(result).toHaveLength(3);
            expect(result[0].versionNumber).toBe(3);
            expect(typeof result[0].createdAt).toBe('string');
        });

        it('returns [] for a cross-tenant pipeline', async () => {
            mockPipelineRepository.findById.mockResolvedValue(makePipeline({ tenantId: 'tenant-other' }));
            const result = await service.listVersions('p-1');
            expect(result).toEqual([]);
            expect(mockVersionRepository.findByPipeline).not.toHaveBeenCalled();
        });

        it('getVersion returns the matching snapshot or null', async () => {
            mockPipelineRepository.findById.mockResolvedValue(makePipeline({ id: 'p-1' }));
            mockVersionRepository.findByPipeline.mockResolvedValue([makeVersion(2, changedConfigYaml), makeVersion(1, validConfigYaml)]);

            const found = await service.getVersion('p-1', 2);
            expect(found?.versionNumber).toBe(2);

            const missing = await service.getVersion('p-1', 99);
            expect(missing).toBeNull();
        });
    });
});
