import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DepartmentController } from '../department.controller';

// CLS mock so the controller can read the caller's `user`/
// `tenantId` for the defence-in-depth tenant guard on the list route.
function createMockCls(user: { id?: string; tenantId?: string | null; roles?: string[] } | null, tenantId?: string | null) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'user') return user;
            if (key === 'tenantId') return tenantId ?? user?.tenantId ?? undefined;
            return undefined;
        }),
    };
}

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
        // Default to a tenant-scoped (non-global-admin) caller so the generic
        // CRUD specs below pass the X5 list guard. Scoping specs build their
        // own per-case CLS mock.
        const cls = createMockCls({ id: 'u-1', tenantId: 'tenant-1', roles: ['DEPARTMENT_ADMIN'] }, 'tenant-1');
        controller = new DepartmentController(mockService as any, cls as any);
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

    // -------------------------------------------------------------------------
    // GET /admin/departments tenant scoping.
    // `DepartmentService.getAll` already requires `this.tenantId` server-side,
    // but we mirror the AuditLogController guard so a non-global-admin with no
    // tenant context is rejected at the request entry point and never reaches
    // the service. GLOBAL_ADMIN bypasses the controller guard.
    // -------------------------------------------------------------------------
    describe('GET /admin/departments tenant scoping', () => {
        const buildController = (cls: ReturnType<typeof createMockCls>) =>
            new DepartmentController(mockService as any, cls as any);

        it('rejects a non-global-admin with NO tenant context (ForbiddenException, service untouched)', async () => {
            const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DEPARTMENT_ADMIN'] }, null);

            await expect(buildController(cls).fetchAll('true')).rejects.toBeInstanceOf(ForbiddenException);
            expect(mockService.getAll).not.toHaveBeenCalled();
        });

        it('allows a non-global-admin WITH a tenant context (service.getAll scopes to that tenant)', async () => {
            mockService.getAll.mockResolvedValue([]);
            const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DEPARTMENT_ADMIN'] }, 't-OWN');

            await buildController(cls).fetchAll('true');

            expect(mockService.getAll).toHaveBeenCalledWith({ includeDisabled: true });
        });

        it('passes a GLOBAL_ADMIN WITH an elevated tenant context through to the service', async () => {
            // After ContextInterceptor elevates the
            // console-selected tenant into CLS, a global-admin reads INSIDE that
            // tenant. The controller guard bypasses global-admins; the service
            // then scopes to the elevated CLS tenant.
            mockService.getAll.mockResolvedValue([]);
            const cls = createMockCls({ id: 'admin', tenantId: '', roles: ['GLOBAL_ADMIN'] }, 't-elevated');

            await buildController(cls).fetchAll('false');

            expect(mockService.getAll).toHaveBeenCalledWith({ includeDisabled: false });
        });

        it('does NOT mask the service tenant rule for a GLOBAL_ADMIN with NO tenant context', async () => {
            // The controller guard intentionally bypasses
            // global-admins, so the call reaches the service. But the REAL
            // `DepartmentService.getAll` requires `this.tenantId` and throws
            // `BadRequestException('Tenant ID is required')` for a global-admin's
            // empty tenant. The previous test mocked getAll → `[]` and asserted
            // "allows GLOBAL_ADMIN through", masking Finding #1. Model the real
            // rejection here (no DB wired).
            mockService.getAll.mockRejectedValue(new BadRequestException('Tenant ID is required'));
            const cls = createMockCls({ id: 'admin', tenantId: '', roles: ['GLOBAL_ADMIN'] }, null);

            await expect(buildController(cls).fetchAll('false')).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    // update() now requires `@RequiresIfMatch()`
    // and the param decorator fires 428 in HTTP land if the header is
    // missing. These unit tests cover the controller-internal logic of
    // folding the header value into the body-field `expectedVersion`.
    describe('PATCH /admin/departments/:id (update) — If-Match handling', () => {
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

    describe('PATCH /admin/departments/:id/prompt-config (updatePromptConfig) — If-Match handling', () => {
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
