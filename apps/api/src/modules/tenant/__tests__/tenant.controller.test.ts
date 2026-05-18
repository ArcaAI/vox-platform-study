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
});
