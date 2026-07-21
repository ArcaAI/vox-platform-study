import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantController } from '../tenant.controller';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const PERMISSION_MODE_KEY = 'permission_mode';

function createMockTenantService() {
    return {
        create: vi.fn(),
        fetchAll: vi.fn(),
        fetchAllCreatedByUser: vi.fn(),
        fetchByCodeName: vi.fn(),
        fetchById: vi.fn(),
        update: vi.fn(),
        deleteById: vi.fn(),
        getUsageStats: vi.fn(),
        fetchTenantConfigs: vi.fn(),
        updateTenantConfigs: vi.fn(),
    };
}

// Direct construction mirrors the pattern used by every other controller
// test in apps/api/src/modules/**/__tests__ (consultation, auth, etc.).
// Default CLS = global-admin so the existing pre-W5.5 test blocks below
// remain agnostic to the W5.5 tenant-scope guard.
function createMockCls(user: { id?: string; tenantId?: string | null; roles?: string[] } | null = { id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'user') return user;
            if (key === 'tenantId') return user?.tenantId ?? undefined;
            return undefined;
        }),
    };
}

describe('TenantController', () => {
    let controller: TenantController;
    let tenantService: ReturnType<typeof createMockTenantService>;

    beforeEach(() => {
        tenantService = createMockTenantService();
        controller = new TenantController(
            tenantService as never,
            createMockCls() as never,
        );
    });

    describe('Smoke', () => {
        it('should be instantiated via Nest testing module', () => {
            expect(controller).toBeDefined();
            expect(controller).toBeInstanceOf(TenantController);
        });

        it('create() should call tenantService.create with the request payload', async () => {
            const request = {
                name: 'Acme Hospital',
                key: 'acme-hospital',
                description: 'Acme test tenant',
            } as any;

            const created = {
                id: 'tenant-uuid-1',
                name: request.name,
                key: request.key,
                description: request.description,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            tenantService.create.mockResolvedValue(created);

            const response = await controller.create(request);

            expect(tenantService.create).toHaveBeenCalledTimes(1);
            expect(tenantService.create).toHaveBeenCalledWith(request);
            expect(response).toBeDefined();
            expect(response.id).toBe('tenant-uuid-1');
            expect(response.name).toBe(request.name);
            expect(response.key).toBe(request.key);
        });
    });

    // The class-level guard is @CanAny(['manage','Tenant'], ['update','Tenant']) (mode OR)
    // so a TENANT_ADMIN (who holds tenant-scoped update:Tenant, not manage)
    // clears the controller guard for self-service tenant config reads/updates.
    // create()/delete() stay GLOBAL_ADMIN-only via method-level @CanManage('Tenant')
    // — covered behaviorally by the inline-guard block below and by the
    // PolicyEngine TENANT_ADMIN regression in @arcaai/applications.
    describe('Authorization metadata (@CanAny manage|update Tenant)', () => {
        it('should declare BOTH manage:Tenant and update:Tenant as class-level permissions', () => {
            const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, TenantController);

            expect(required).toBeDefined();
            expect(Array.isArray(required)).toBe(true);
            expect(required).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ action: 'manage', subject: 'Tenant' }),
                    expect.objectContaining({ action: 'update', subject: 'Tenant' }),
                ]),
            );
        });

        it('should use OR permission mode at the class level (manage OR update)', () => {
            const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, TenantController);
            expect(mode).toBe('OR');
        });
    });

    // update() requires `@RequiresIfMatch()`
    // and the param decorator fires 428 in HTTP land if the header is
    // missing. These unit tests cover the controller-internal logic of
    // folding the header value into the body-field `expectedVersion`.
    describe('update() — If-Match header handling (TASK-302 Stream D Phase E.1)', () => {
        function makeUpdatedTenant(id: string, name: string, version: number) {
            return {
                id,
                name,
                key: 'k',
                description: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                resourceStatus: null,
                resourceStatusUpdatedAt: null,
                resourceStatusUpdatedBy: '',
                createdBy: null,
                updatedBy: null,
                projectId: null,
                version,
                toObject() {
                    return {
                        id,
                        name,
                        key: 'k',
                        description: null,
                        createdAt: this.createdAt,
                        updatedAt: this.updatedAt,
                        resourceStatus: null,
                        resourceStatusUpdatedAt: null,
                        resourceStatusUpdatedBy: '',
                        createdBy: null,
                        updatedBy: null,
                        projectId: null,
                        version,
                    };
                },
            };
        }

        it('folds the If-Match header into the body-field expectedVersion (header wins)', async () => {
            tenantService.update.mockResolvedValue(makeUpdatedTenant('t-1', 'New', 8));

            // Body says version 99 (stale); header carries 7. The header
            // MUST override.
            await controller.update('t-1', { name: 'New', expectedVersion: 99 } as any, 7);

            expect(tenantService.update).toHaveBeenCalledWith('t-1', expect.objectContaining({
                name: 'New',
                expectedVersion: 7,
            }));
        });

        it('preserves the body-field expectedVersion when the header is absent (service-to-service fallback)', async () => {
            // This branch is only reachable off-route in production (the
            // `@RequiresIfMatch()` route guard + `@ExpectedVersion()` param
            // decorator fire 428 before the handler runs). It documents the
            // controller invariant for the service-to-service path.
            tenantService.update.mockResolvedValue(makeUpdatedTenant('t-1', 'New', 8));

            await controller.update('t-1', { name: 'New', expectedVersion: 5 } as any, undefined);

            expect(tenantService.update).toHaveBeenCalledWith('t-1', expect.objectContaining({
                name: 'New',
                expectedVersion: 5,
            }));
        });

        it('surfaces the row version on the TenantResponse so clients can echo it back', async () => {
            tenantService.update.mockResolvedValue(makeUpdatedTenant('t-1', 'New', 8));

            const response = await controller.update('t-1', { name: 'New', expectedVersion: 7 } as any, 7);

            // The version round-trips so the SDK can set
            // `If-Match: "<version>"` on the next PATCH without another GET.
            expect(response.version).toBe(8);
        });
    });

    // Every per-row endpoint must
    // inline-assert that the caller is either a GLOBAL_ADMIN or operating
    // on their own tenant. The class-level @CanManage('Tenant') was
    // insufficient because that policy is `tenantId: ${user.tenantId}`
    // and these methods take an arbitrary `:id` path parameter.
    describe('TASK-307 W5.5 — inline tenant guards on per-row endpoints (AC-19, audit D-5)', () => {
        function buildWithCls(user: { id?: string; tenantId?: string | null; roles?: string[] } | null) {
            const svc = createMockTenantService();
            svc.fetchById.mockResolvedValue({ id: 't-A', name: 'A', toObject: () => ({ id: 't-A' }) });
            svc.fetchByCodeName.mockResolvedValue({ id: 't-A', name: 'A', toObject: () => ({ id: 't-A' }) });
            svc.update.mockResolvedValue({ id: 't-A', name: 'A', version: 1, toObject: () => ({ id: 't-A', version: 1 }) });
            svc.deleteById.mockResolvedValue({ id: 't-A', name: 'A', toObject: () => ({ id: 't-A' }) });
            svc.getUsageStats.mockResolvedValue({ tenantId: 't-A', totalConsultations: 0 } as any);
            const cls = createMockCls(user);
            const c = new TenantController(svc as never, cls as never);
            return { controller: c, tenantService: svc, cls };
        }

        describe('update(:id)', () => {
            it('throws ForbiddenException when caller is NOT global-admin AND id != user.tenantId', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                await expect(
                    controller.update('t-OTHER', { name: 'x' } as any, 1),
                ).rejects.toBeInstanceOf(ForbiddenException);
                expect(tenantService.update).not.toHaveBeenCalled();
            });

            it('allows the call when caller is GLOBAL_ADMIN even if id != user.tenantId', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['GLOBAL_ADMIN'],
                });
                await controller.update('t-OTHER', { name: 'x' } as any, 1);
                expect(tenantService.update).toHaveBeenCalledTimes(1);
            });

            it('allows the call when id === user.tenantId (own-tenant)', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                await controller.update('t-OWN', { name: 'x' } as any, 1);
                expect(tenantService.update).toHaveBeenCalledTimes(1);
            });
        });

        describe('delete(:id)', () => {
            it('throws ForbiddenException when caller is NOT global-admin AND id != user.tenantId', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                await expect(controller.delete('t-OTHER')).rejects.toBeInstanceOf(ForbiddenException);
                expect(tenantService.deleteById).not.toHaveBeenCalled();
            });

            it('allows the call when caller is GLOBAL_ADMIN', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['GLOBAL_ADMIN'],
                });
                await controller.delete('t-OTHER');
                expect(tenantService.deleteById).toHaveBeenCalledTimes(1);
            });
        });

        describe('getUsage(:id)', () => {
            it('throws ForbiddenException when caller is NOT global-admin AND id != user.tenantId', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                await expect(controller.getUsage('t-OTHER')).rejects.toBeInstanceOf(ForbiddenException);
                expect(tenantService.getUsageStats).not.toHaveBeenCalled();
            });

            it('allows the call when caller is GLOBAL_ADMIN', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['GLOBAL_ADMIN'],
                });
                await controller.getUsage('t-OTHER');
                expect(tenantService.getUsageStats).toHaveBeenCalledTimes(1);
            });

            it('allows the call when id === user.tenantId', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                await controller.getUsage('t-OWN');
                expect(tenantService.getUsageStats).toHaveBeenCalledTimes(1);
            });
        });

        describe('fetchByCodeName(:code-name)', () => {
            // codeName guard compares the LOADED tenant's id to the caller's
            // tenantId — code-name is not the same as the row's UUID id.
            it('throws ForbiddenException when caller is NOT global-admin AND loaded tenant.id != user.tenantId', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                tenantService.fetchByCodeName.mockResolvedValue({
                    id: 't-OTHER',
                    name: 'Other',
                    toObject: () => ({ id: 't-OTHER' }),
                });
                await expect(controller.fetchByCodeName('other-clinic')).rejects.toBeInstanceOf(
                    ForbiddenException,
                );
            });

            it('allows the call when caller is GLOBAL_ADMIN even for foreign code-name', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['GLOBAL_ADMIN'],
                });
                tenantService.fetchByCodeName.mockResolvedValue({
                    id: 't-OTHER',
                    name: 'Other',
                    toObject: () => ({ id: 't-OTHER' }),
                });
                const r = await controller.fetchByCodeName('other-clinic');
                expect(r.id).toBe('t-OTHER');
            });

            it('allows the call when loaded tenant.id === user.tenantId (own-tenant lookup by code-name)', async () => {
                const { controller, tenantService } = buildWithCls({
                    id: 'u-1',
                    tenantId: 't-OWN',
                    roles: ['DOCTOR'],
                });
                tenantService.fetchByCodeName.mockResolvedValue({
                    id: 't-OWN',
                    name: 'Own',
                    toObject: () => ({ id: 't-OWN' }),
                });
                const r = await controller.fetchByCodeName('own-clinic');
                expect(r.id).toBe('t-OWN');
            });
        });
    });

    // fetchAll tenant scoping.
    //
    // `Tenant` rows are NOT tenant-scoped by the Prisma extension, and the
    // class-level @CanManage('Tenant') admits any TENANT_ADMIN (their policy is
    // tenantId-conditioned). Without an explicit guard a tenant admin could
    // enumerate EVERY tenant via GET /admin/tenants. Non-global-admins must see
    // only their own tenant; GLOBAL_ADMIN keeps the full cross-tenant listing.
    //
    // (fetchById / fetchByCodeName / fetchTenantConfigs are already tenant-scoped
    // at the service layer, so they are intentionally not
    // re-guarded here; a controller 403 would weaken their no-existence-leak 404.)
    describe('TASK-319 F5 — fetchAll tenant scoping', () => {
        function build(user: { id?: string; tenantId?: string | null; roles?: string[] } | null) {
            const svc = createMockTenantService();
            const cls = createMockCls(user);
            return { controller: new TenantController(svc as never, cls as never), svc };
        }

        it('non-global-admin sees ONLY their own tenant (never the full list)', async () => {
            const { controller, svc } = build({ id: 'u-1', tenantId: 't-OWN', roles: ['TENANT_ADMIN'] });
            svc.fetchById.mockResolvedValue({ id: 't-OWN', name: 'Own', toObject: () => ({ id: 't-OWN' }) });

            const res = await controller.fetchAll({ page: 1, limit: 10 } as any);

            expect(svc.fetchAll).not.toHaveBeenCalled();
            expect(svc.fetchById).toHaveBeenCalledWith('t-OWN');
            expect(res.count).toBe(1);
            expect(res.data).toHaveLength(1);
            expect(res.data[0].id).toBe('t-OWN');
        });

        it('GLOBAL_ADMIN gets the full tenant list via tenantService.fetchAll', async () => {
            const { controller, svc } = build({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] });
            svc.fetchAll.mockResolvedValue({
                data: [
                    { id: 't-1', toObject: () => ({ id: 't-1' }) },
                    { id: 't-2', toObject: () => ({ id: 't-2' }) },
                ],
                count: 2,
                page: 1,
                limit: 10,
            });

            const res = await controller.fetchAll({ page: 1, limit: 10 } as any);

            expect(svc.fetchAll).toHaveBeenCalledTimes(1);
            expect(svc.fetchById).not.toHaveBeenCalled();
            expect(res.count).toBe(2);
            expect(res.data).toHaveLength(2);
        });

        it('throws ForbiddenException for a non-global-admin with no tenant context', async () => {
            const { controller, svc } = build({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] });

            await expect(controller.fetchAll({ page: 1, limit: 10 } as any)).rejects.toBeInstanceOf(ForbiddenException);
            expect(svc.fetchById).not.toHaveBeenCalled();
            expect(svc.fetchAll).not.toHaveBeenCalled();
        });
    });

    // The tenant-config read/update routes take a dual
    // `:identifier` (tenant UUID OR code-name) and previously forwarded it (and
    // the raw config body) straight to the service. Add a controller-layer scope
    // guard (404, NOT 403 — preserves the service's no-existence-leak posture for
    // configs) plus an explicit updatable-key allow-list on update (the global
    // ValidationPipe does NOT whitelist array-body elements).
    describe('AC-10 — tenant config scope guard + updatable-key allow-list', () => {
        const OWN_UUID = '11111111-1111-1111-1111-111111111111';
        const FOREIGN_UUID = '00000000-0000-0000-0000-0000000000ff';

        function build(user: { id?: string; tenantId?: string | null; roles?: string[] } | null) {
            const svc = createMockTenantService();
            svc.fetchTenantConfigs.mockResolvedValue({ page: 1, limit: 10, count: 0, data: [] });
            svc.updateTenantConfigs.mockResolvedValue({ page: 1, limit: 10, count: 0, data: [] });
            const cls = createMockCls(user);
            return { controller: new TenantController(svc as never, cls as never), svc };
        }

        describe('fetchTenantConfigs', () => {
            it('404s a non-global-admin addressing a FOREIGN tenant by UUID (no leak, service untouched)', async () => {
                const { controller, svc } = build({ id: 'u-1', tenantId: OWN_UUID, roles: ['TENANT_ADMIN'] });
                await expect(controller.fetchTenantConfigs(FOREIGN_UUID, {} as any)).rejects.toBeInstanceOf(NotFoundException);
                expect(svc.fetchTenantConfigs).not.toHaveBeenCalled();
            });

            it('allows a non-global-admin to read their OWN tenant by UUID', async () => {
                const { controller, svc } = build({ id: 'u-1', tenantId: OWN_UUID, roles: ['TENANT_ADMIN'] });
                await controller.fetchTenantConfigs(OWN_UUID, {} as any);
                expect(svc.fetchTenantConfigs).toHaveBeenCalledTimes(1);
            });

            it('defers a code-name identifier to the service no-leak guard', async () => {
                const { controller, svc } = build({ id: 'u-1', tenantId: OWN_UUID, roles: ['TENANT_ADMIN'] });
                await controller.fetchTenantConfigs('acme-clinic', {} as any);
                expect(svc.fetchTenantConfigs).toHaveBeenCalledTimes(1);
            });

            it('lets a GLOBAL_ADMIN read any tenant', async () => {
                const { controller, svc } = build({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] });
                await controller.fetchTenantConfigs(FOREIGN_UUID, {} as any);
                expect(svc.fetchTenantConfigs).toHaveBeenCalledTimes(1);
            });
        });

        describe('updateTenantConfigs', () => {
            it('404s a non-global-admin updating a FOREIGN tenant by UUID (service untouched)', async () => {
                const { controller, svc } = build({ id: 'u-1', tenantId: OWN_UUID, roles: ['TENANT_ADMIN'] });
                await expect(
                    controller.updateTenantConfigs(FOREIGN_UUID, [{ id: 'c1', value: 'v', expectedVersion: 1 } as any]),
                ).rejects.toBeInstanceOf(NotFoundException);
                expect(svc.updateTenantConfigs).not.toHaveBeenCalled();
            });

            it('forwards ONLY the allow-listed keys (id, value, description, expectedVersion) to the service', async () => {
                const { controller, svc } = build({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] });
                await controller.updateTenantConfigs(OWN_UUID, [
                    {
                        id: 'c1',
                        value: 'v',
                        description: 'd',
                        expectedVersion: 1,
                        // smuggled keys — must be stripped before reaching the service:
                        locked: true,
                        tenantId: 'evil',
                        key: 'default-stt-model',
                    } as any,
                ]);
                const passed = svc.updateTenantConfigs.mock.calls[0][1];
                expect(passed[0]).toEqual({ id: 'c1', value: 'v', description: 'd', expectedVersion: 1 });
                expect('locked' in passed[0]).toBe(false);
                expect('tenantId' in passed[0]).toBe(false);
                expect('key' in passed[0]).toBe(false);
            });
        });
    });
});
