import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ITenantService, UnifiedAuthGuard } from '@arcaai/applications';
import { TenantController } from '../tenant.controller';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const PERMISSION_MODE_KEY = 'permission_mode';

class AlwaysAllowGuard {
    canActivate() {
        return true;
    }
}

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

describe('TenantController', () => {
    let controller: TenantController;
    let tenantService: ReturnType<typeof createMockTenantService>;
    let module: TestingModule;

    beforeEach(async () => {
        tenantService = createMockTenantService();

        module = await Test.createTestingModule({
            controllers: [TenantController],
            providers: [
                {
                    provide: ITenantService,
                    useValue: tenantService,
                },
            ],
        })
            // Replace the real authorization guard so the testing module does
            // not need to wire IApiKeyService / PolicyEngine / Reflector / CLS.
            // Class-level @CanManage('Tenant') metadata is asserted separately
            // in the "Authorization metadata" test block.
            .overrideGuard(UnifiedAuthGuard)
            .useClass(AlwaysAllowGuard)
            .compile();

        controller = module.get<TenantController>(TenantController);
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

    describe('Authorization metadata (@CanManage("Tenant"))', () => {
        it('should declare manage:Tenant as the required class-level permission', () => {
            const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, TenantController);

            expect(required).toBeDefined();
            expect(Array.isArray(required)).toBe(true);
            expect(required).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ action: 'manage', subject: 'Tenant' }),
                ]),
            );
        });

        it('should use AND permission mode at the class level', () => {
            const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, TenantController);
            expect(mode).toBe('AND');
        });
    });

    // TASK-302 Stream D Phase E.1 — update() now requires `@RequiresIfMatch()`
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
});
