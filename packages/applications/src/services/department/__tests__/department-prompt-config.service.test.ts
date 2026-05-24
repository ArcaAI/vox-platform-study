/**
 * DepartmentService.updatePromptConfig — TASK-294 DEF-C3
 *
 * Tenant isolation guard tests. The method MUST refuse to update
 * a department whose `tenantId` does not match the calling tenant.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DepartmentService } from '../department.service';

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockDepartmentRepository = {
    findById: vi.fn(),
    update: vi.fn(),
};

const createMockDepartment = (overrides: Record<string, unknown> = {}) => ({
    id: 'dept-1',
    tenantId: 'tenant-1',
    code: 'CARDIO',
    name: 'Cardiology',
    description: null,
    parentDepartmentId: null,
    isRootDepartment: true,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    preSummaryPromptId: null as string | null,
    newPatientPromptId: null as string | null,
    revisitPromptId: null as string | null,
    hasChanges: true,
    changes: { preSummaryPromptId: 'pre-1' },
    toObject: vi.fn().mockReturnValue({}),
    ...overrides,
});

describe('DepartmentService.updatePromptConfig (TASK-294 DEF-C3)', () => {
    let service: DepartmentService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'user-1' };
                case 'tenantId':
                    return 'tenant-1';
                case 'correlationId':
                    return 'corr-1';
                default:
                    return null;
            }
        });

        service = new DepartmentService(
            mockDepartmentRepository as never,
            mockEventEmitter as never,
            mockClsService as never,
        );
    });

    it('throws BadRequestException when caller has no tenantId', async () => {
        mockClsService.get.mockImplementation((key: string) =>
            key === 'tenantId' ? null : { id: 'user-1' },
        );

        await expect(
            service.updatePromptConfig('dept-1', { preSummaryPromptId: 'pre-1' } as never),
        ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when department does not exist', async () => {
        mockDepartmentRepository.findById.mockResolvedValue(null);

        await expect(
            service.updatePromptConfig('missing', { preSummaryPromptId: 'pre-1' } as never),
        ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when department.tenantId !== caller tenantId (DEF-C3 — no existence leak)', async () => {
        const foreignDept = createMockDepartment({ id: 'dept-2', tenantId: 'tenant-OTHER' });
        mockDepartmentRepository.findById.mockResolvedValue(foreignDept);

        await expect(
            service.updatePromptConfig('dept-2', { preSummaryPromptId: 'pre-1' } as never),
        ).rejects.toThrow(NotFoundException);

        // Critical: must NOT delegate to repository.update on a foreign-tenant resource
        expect(mockDepartmentRepository.update).not.toHaveBeenCalled();
    });

    it('succeeds when department.tenantId matches caller tenantId', async () => {
        const dept = createMockDepartment({ id: 'dept-1', tenantId: 'tenant-1' });
        mockDepartmentRepository.findById.mockResolvedValue(dept);
        mockDepartmentRepository.update.mockResolvedValue(dept);

        await service.updatePromptConfig('dept-1', { preSummaryPromptId: 'pre-1' } as never);

        expect(mockDepartmentRepository.update).toHaveBeenCalledWith('dept-1', dept);
    });
});
