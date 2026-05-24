import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DepartmentController } from '../department.controller';

const createMockDepartmentEntity = (overrides: Record<string, unknown> = {}) => ({
    id: overrides.id ?? 'dept-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    code: overrides.code ?? 'CARDIO',
    name: overrides.name ?? 'Cardiology',
    description: overrides.description ?? 'Cardiology Department',
    parentDepartmentId: overrides.parentDepartmentId ?? null,
    isRootDepartment: overrides.isRootDepartment ?? true,
    resourceStatus: overrides.resourceStatus ?? 'ENABLED',
    createdAt: overrides.createdAt ?? '2026-01-29T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-29T10:00:00.000Z',
});

const createMockService = () => ({
    create: vi.fn(),
    getAll: vi.fn(),
    getRootDepartments: vi.fn(),
    getById: vi.fn(),
    getByCode: vi.fn(),
    getChildren: vi.fn(),
    update: vi.fn(),
    updatePromptConfig: vi.fn(),
    deleteById: vi.fn(),
});

describe('DepartmentController', () => {
    let controller: DepartmentController;
    let mockService: ReturnType<typeof createMockService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockService = createMockService();
        controller = new DepartmentController(mockService as any);
    });

    describe('GET /admin/departments (fetchAll)', () => {
        it('should call service.getAll with includeDisabled: true when query param is "true"', async () => {
            mockService.getAll.mockResolvedValue([]);

            await controller.fetchAll('true');

            expect(mockService.getAll).toHaveBeenCalledWith({
                includeDisabled: true,
            });
        });

        it('should call service.getAll with includeDisabled: false when query param is absent', async () => {
            mockService.getAll.mockResolvedValue([]);

            await controller.fetchAll(undefined);

            expect(mockService.getAll).toHaveBeenCalledWith({
                includeDisabled: false,
            });
        });

        it('should call service.getAll with includeDisabled: false when query param is "false"', async () => {
            mockService.getAll.mockResolvedValue([]);

            await controller.fetchAll('false');

            expect(mockService.getAll).toHaveBeenCalledWith({
                includeDisabled: false,
            });
        });

        it('should call service.getAll with includeDisabled: false for non-boolean string values', async () => {
            mockService.getAll.mockResolvedValue([]);

            await controller.fetchAll('1');

            expect(mockService.getAll).toHaveBeenCalledWith({
                includeDisabled: false,
            });
        });

        it('should return mixed ENABLED and DISABLED departments when includeDisabled is true', async () => {
            const departments = [
                createMockDepartmentEntity({ id: 'dept-1', resourceStatus: 'ENABLED' }),
                createMockDepartmentEntity({ id: 'dept-2', resourceStatus: 'DISABLED' }),
                createMockDepartmentEntity({ id: 'dept-3', resourceStatus: 'ENABLED' }),
            ];
            mockService.getAll.mockResolvedValue(departments);

            const result = await controller.fetchAll('true');

            expect(result).toHaveLength(3);
            expect(result[1].resourceStatus).toBe('DISABLED');
        });

        it('should return all-DISABLED departments without filtering them out', async () => {
            const departments = [
                createMockDepartmentEntity({ id: 'dept-1', resourceStatus: 'DISABLED' }),
                createMockDepartmentEntity({ id: 'dept-2', resourceStatus: 'DISABLED' }),
            ];
            mockService.getAll.mockResolvedValue(departments);

            const result = await controller.fetchAll('true');

            expect(result).toHaveLength(2);
            expect(result.every((d: any) => d.resourceStatus === 'DISABLED')).toBe(true);
        });

        it('should return empty array when no departments exist', async () => {
            mockService.getAll.mockResolvedValue([]);

            const result = await controller.fetchAll('true');

            expect(result).toEqual([]);
        });
    });

    // TASK-302 Stream D Phase E.2 — update() now requires `@RequiresIfMatch()`
    // and the param decorator fires 428 in HTTP land if the header is
    // missing. These unit tests cover the controller-internal logic of
    // folding the header value into the body-field `expectedVersion`.
    describe('PATCH /admin/departments/:id (update) — If-Match handling (TASK-302 Stream D Phase E.2)', () => {
        it('folds the If-Match header into the body-field expectedVersion (header wins)', async () => {
            mockService.update.mockResolvedValue(createMockDepartmentEntity({ version: 8 }));

            // Body says version 99 (stale); header carries 7. Header MUST
            // override.
            await controller.update('dept-1', { name: 'Renamed', expectedVersion: 99 } as any, 7);

            expect(mockService.update).toHaveBeenCalledWith('dept-1', expect.objectContaining({
                name: 'Renamed',
                expectedVersion: 7,
            }));
        });

        it('preserves the body-field expectedVersion when header is absent (service-to-service fallback)', async () => {
            mockService.update.mockResolvedValue(createMockDepartmentEntity({ version: 8 }));

            await controller.update('dept-1', { name: 'Renamed', expectedVersion: 5 } as any, undefined);

            expect(mockService.update).toHaveBeenCalledWith('dept-1', expect.objectContaining({
                name: 'Renamed',
                expectedVersion: 5,
            }));
        });
    });

    describe('PATCH /admin/departments/:id/prompt-config (updatePromptConfig) — If-Match handling (TASK-302 Stream D Phase E.2)', () => {
        it('folds the If-Match header into the body-field expectedVersion (header wins)', async () => {
            mockService.updatePromptConfig.mockResolvedValue(createMockDepartmentEntity({ version: 8 }));

            await controller.updatePromptConfig(
                'dept-1',
                { preSummaryPromptId: 'p-1', expectedVersion: 99 } as any,
                7,
            );

            expect(mockService.updatePromptConfig).toHaveBeenCalledWith('dept-1', expect.objectContaining({
                preSummaryPromptId: 'p-1',
                expectedVersion: 7,
            }));
        });

        it('preserves the body-field expectedVersion when header is absent (service-to-service fallback)', async () => {
            mockService.updatePromptConfig.mockResolvedValue(createMockDepartmentEntity({ version: 8 }));

            await controller.updatePromptConfig(
                'dept-1',
                { preSummaryPromptId: 'p-1', expectedVersion: 5 } as any,
                undefined,
            );

            expect(mockService.updatePromptConfig).toHaveBeenCalledWith('dept-1', expect.objectContaining({
                preSummaryPromptId: 'p-1',
                expectedVersion: 5,
            }));
        });
    });
});
