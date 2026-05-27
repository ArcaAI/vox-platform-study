/**
 * WebhookService Unit Tests
 *
 * Tests for the WebhookService that handles webhook management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookService } from '../webhook.service';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock WebhookRepository - simulates database operations
const mockWebhookRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // TASK-302 Stream D Phase E.5 — `update()` now writes via CAS. The
    // legacy `update` stays on the mock so we can assert it is NOT
    // called from the OCC-migrated path.
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Creates a complete mock webhook entity matching the real WebhookEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockWebhookEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    url: string;
    hashedSecret: string | null;
    resourceTypeName: string;
    resourceId: string | null;
    subscriptionMetadata: Record<string, unknown> | null;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    version: number;
}> = {}) => {
    const entity = {
        id: overrides.id ?? 'webhook-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        name: overrides.name ?? 'Test Webhook',
        url: overrides.url ?? 'https://example.com/webhook',
        hashedSecret: overrides.hashedSecret ?? null,
        resourceTypeName: overrides.resourceTypeName ?? 'User',
        resourceId: overrides.resourceId ?? null,
        subscriptionMetadata: overrides.subscriptionMetadata ?? null,
        resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
        createdBy: overrides.createdBy ?? null,
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        // TASK-302 Stream D Phase E.5 — `_version` is required for the
        // CAS write path. Default = first-write (1).
        version: overrides.version ?? 1,
        toObject: vi.fn(),
    };
    // Make toObject return a complete representation
    entity.toObject.mockReturnValue({
        id: entity.id,
        tenantId: entity.tenantId,
        name: entity.name,
        url: entity.url,
        hashedSecret: entity.hashedSecret,
        resourceTypeName: entity.resourceTypeName,
        resourceId: entity.resourceId,
        subscriptionMetadata: entity.subscriptionMetadata,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

// Mock WebhookFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        WebhookFactory: {
            CreateWebhook: vi.fn((data) => ({
                ...data,
                id: 'new-webhook-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-webhook-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
    };
});

describe('WebhookService', () => {
    let service: WebhookService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Default: return valid user from CLS - complete user context
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return {
                        id: 'current-user-id',
                        firstName: 'Test',
                        lastName: 'User',
                        email: 'test@example.com',
                    };
                case 'tenantId':
                    return 'tenant-1';
                case 'tenantCode':
                    return 'TENANT_1';
                case 'correlationId':
                    return 'corr-123';
                case 'requestIp':
                    return '192.168.1.1';
                default:
                    return null;
            }
        });

        // Create service instance with mocks
        service = new WebhookService(
            mockWebhookRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new webhook with all required fields', async () => {
            const newWebhook = createMockWebhookEntity({
                id: 'new-webhook-id',
                tenantId: 'tenant-1',
                name: 'New Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            });

            // Verify the returned entity has correct data
            expect(result.id).toBe('new-webhook-id');
            expect(result.tenantId).toBe('tenant-1');
            expect(result.name).toBe('New Webhook');
            expect(result.url).toBe('https://example.com/webhook');
            expect(result.resourceTypeName).toBe('User');
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newWebhook = createMockWebhookEntity({ id: 'new-webhook-id' });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            await service.create({
                tenantId: 'tenant-1',
                name: 'New Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-webhook-id',
                    createdAt: newWebhook.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockWebhookRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    name: 'New Webhook',
                    url: 'https://example.com/webhook',
                    resourceTypeName: 'User',
                })
            ).rejects.toThrow('Failed to create WebhookEntity');
        });

        it('should create webhook with optional secret', async () => {
            const newWebhook = createMockWebhookEntity({
                id: 'new-webhook-id',
                hashedSecret: 'hashed-secret-value',
            });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'Secure Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
                hashedSecret: 'hashed-secret-value',
            });

            expect(result.hashedSecret).toBe('hashed-secret-value');
        });

        it('should create webhook with subscription metadata', async () => {
            const metadata = { events: ['user.created', 'user.updated'], priority: 'high' };
            const newWebhook = createMockWebhookEntity({
                id: 'new-webhook-id',
                subscriptionMetadata: metadata,
            });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
                subscriptionMetadata: metadata,
            });

            expect(result.subscriptionMetadata).toEqual(metadata);
        });

        it('should create webhook for specific resource', async () => {
            const newWebhook = createMockWebhookEntity({
                id: 'new-webhook-id',
                resourceTypeName: 'Consultation',
                resourceId: 'consultation-123',
            });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'Consultation Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'Consultation',
                resourceId: 'consultation-123',
            });

            expect(result.resourceTypeName).toBe('Consultation');
            expect(result.resourceId).toBe('consultation-123');
        });

        it('should handle repository errors gracefully', async () => {
            mockWebhookRepository.create.mockRejectedValue(new Error('Database connection failed'));

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    name: 'New Webhook',
                    url: 'https://example.com/webhook',
                    resourceTypeName: 'User',
                })
            ).rejects.toThrow('Database connection failed');
        });
    });

    /**
     * TASK-306 P1.4 (audit M-2 / NEW-2 / AC-5 partial) — `WebhookService.create`
     * previously persisted the caller-supplied `request.tenantId` as-is, so a
     * Tenant-A user could create webhooks attributed to Tenant-B by simply
     * setting the DTO field. The new `resolveEffectiveTenantId` helper mirrors
     * the W3.2 NotificationService pattern at the structural level:
     *   - Non-SUPER_ADMIN: silently pin to CLS `tenantId` (ignore the DTO field)
     *   - SUPER_ADMIN: honor `request.tenantId` for cross-tenant impersonation
     *     (admin UI flows / migration tooling)
     *   - Both branches throw `BadRequestException` if no tenant context resolves
     *
     * NOTE: this differs from NotificationService semantically — Notification
     * THROWS ForbiddenException on a non-super-admin explicit mismatch (PHI
     * dispatch is more sensitive). Webhook follows the README W5.1.4 verification
     * contract ("row created with tenant-A") which mandates silent pinning.
     */
    describe('TASK-306 P1.4 — create resolves effective tenantId', () => {
        // Helper mirrors the NotificationService / TenantService test convention:
        // re-installs the CLS mock so the active user carries the given roles
        // without leaking state into sibling tests (each `beforeEach` wipes it).
        const setRequestUserRoles = (roles: string[] | undefined) => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user':
                        return {
                            id: 'current-user-id',
                            firstName: 'Test',
                            lastName: 'User',
                            email: 'test@example.com',
                            roles,
                        };
                    case 'tenantId':
                        return 'tenant-1';
                    case 'tenantCode':
                        return 'TENANT_1';
                    case 'correlationId':
                        return 'corr-123';
                    case 'requestIp':
                        return '192.168.1.1';
                    default:
                        return null;
                }
            });
        };

        it('pins tenantId to CLS when a non-SUPER_ADMIN caller passes a cross-tenant request.tenantId', async () => {
            const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-1' });
            mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

            await service.create({
                tenantId: 'tenant-B',
                name: 'Sneaky Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            });

            const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
            expect(factoryInput.tenantId).toBe('tenant-1');
        });

        it('pins tenantId to CLS when a non-SUPER_ADMIN caller omits request.tenantId', async () => {
            const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-1' });
            mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

            await service.create({
                name: 'No-Tenant Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            } as never);

            const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
            expect(factoryInput.tenantId).toBe('tenant-1');
        });

        it('honors request.tenantId for SUPER_ADMIN callers (cross-tenant impersonation)', async () => {
            setRequestUserRoles(['SUPER_ADMIN']);
            const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-B' });
            mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

            await service.create({
                tenantId: 'tenant-B',
                name: 'Cross-Tenant Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            });

            const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
            expect(factoryInput.tenantId).toBe('tenant-B');
        });
    });

    /**
     * TASK-306 P2.3 (audit M-2 / AC-5) — `WebhookService` was previously
     * tenant-blind on every read/write surface except `create` (W5.1.4).
     * This block exercises the full sweep across the remaining 5 methods:
     *   - 5.3.2 fetchAll: inject `{ tenantId: this.tenantId }` filter
     *     (SUPER_ADMIN bypass)
     *   - 5.3.3 fetchById: load-then-assert via assertEqualTenants
     *   - 5.3.4 update: assert tenant after the pre-write findById
     *   - 5.3.5 deleteById: load + assert + softDelete
     *   - 5.3.6 fetchAllByTenantId: CLS gate (refuse cross-tenant DTO
     *     tenantId for non-SUPER_ADMIN — mirrors W5.1.5
     *     Notification/ApiKey pattern)
     *
     * The CLS default in `beforeEach` is `tenant-1`. Tests use `tenant-2`
     * for cross-tenant probes. The local `setRequestUserRoles` helper
     * re-installs the CLS mock with the requested role list.
     */
    describe('TASK-306 P2.3 — Webhook tenant-guard sweep', () => {
        const setRequestUserRoles = (roles: string[] | undefined) => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user':
                        return {
                            id: 'current-user-id',
                            firstName: 'Test',
                            lastName: 'User',
                            email: 'test@example.com',
                            roles,
                        };
                    case 'tenantId':
                        return 'tenant-1';
                    case 'tenantCode':
                        return 'TENANT_1';
                    case 'correlationId':
                        return 'corr-123';
                    case 'requestIp':
                        return '192.168.1.1';
                    default:
                        return null;
                }
            });
        };

        describe('fetchAll (5.3.2)', () => {
            it('injects the CLS tenantId into the findAll + count where clauses for non-SUPER_ADMIN callers', async () => {
                mockWebhookRepository.findAll.mockResolvedValue([]);
                mockWebhookRepository.count.mockResolvedValue(0);

                await service.fetchAll({ limit: 10, page: 1 });

                expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
                    expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
                );
                expect(mockWebhookRepository.count).toHaveBeenCalledWith(
                    expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
                );
            });

            it('omits the tenant filter when the caller is a SUPER_ADMIN (cross-tenant list)', async () => {
                setRequestUserRoles(['SUPER_ADMIN']);
                mockWebhookRepository.findAll.mockResolvedValue([]);
                mockWebhookRepository.count.mockResolvedValue(0);

                await service.fetchAll({ limit: 10, page: 1 });

                const findAllArgs = mockWebhookRepository.findAll.mock.calls[0][0];
                const countArgs = mockWebhookRepository.count.mock.calls[0][0];
                expect(findAllArgs.where?.tenantId).toBeUndefined();
                expect(countArgs.where?.tenantId).toBeUndefined();
            });
        });
    });

    describe('fetchAll', () => {
        it('should return paginated webhooks with correct pagination metadata', async () => {
            const webhooks = [
                createMockWebhookEntity({ id: 'webhook-1', name: 'Webhook 1' }),
                createMockWebhookEntity({ id: 'webhook-2', name: 'Webhook 2' }),
            ];
            mockWebhookRepository.findAll.mockResolvedValue(webhooks);
            mockWebhookRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual webhook data is returned
            expect(result.data[0].name).toBe('Webhook 1');
            expect(result.data[1].name).toBe('Webhook 2');
        });

        it('should return empty result when no webhooks exist', async () => {
            mockWebhookRepository.findAll.mockResolvedValue([]);
            mockWebhookRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should emit ResourceViewed event with webhook IDs', async () => {
            const webhooks = [
                createMockWebhookEntity({ id: 'webhook-1' }),
                createMockWebhookEntity({ id: 'webhook-2' }),
            ];
            mockWebhookRepository.findAll.mockResolvedValue(webhooks);
            mockWebhookRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['webhook-1', 'webhook-2'] },
                })
            );
        });

        it('should pass search parameter to repository', async () => {
            mockWebhookRepository.findAll.mockResolvedValue([]);
            mockWebhookRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'user-webhook' });

            expect(mockWebhookRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: 'user-webhook' })
            );
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return webhooks filtered by tenant ID', async () => {
            const webhooks = [createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' })];
            mockWebhookRepository.findAll.mockResolvedValue(webhooks);
            mockWebhookRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].tenantId).toBe('tenant-1');
            expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'tenant-1' },
                })
            );
        });

        it('should emit event with tenantId in data', async () => {
            const webhooks = [createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' })];
            mockWebhookRepository.findAll.mockResolvedValue(webhooks);
            mockWebhookRepository.count.mockResolvedValue(1);

            await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { tenantId: 'tenant-1', items: ['webhook-1'] },
                })
            );
        });

        it('should return empty result when no webhooks match tenant', async () => {
            mockWebhookRepository.findAll.mockResolvedValue([]);
            mockWebhookRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'non-existent-tenant',
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return webhooks created by specific user', async () => {
            const webhooks = [createMockWebhookEntity({ id: 'webhook-1', createdBy: 'creator-id' })];
            mockWebhookRepository.findAll.mockResolvedValue(webhooks);
            mockWebhookRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].createdBy).toBe('creator-id');
            expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
        });

        it('should emit event with createdBy in data', async () => {
            const webhooks = [createMockWebhookEntity({ id: 'webhook-1', createdBy: 'creator-id' })];
            mockWebhookRepository.findAll.mockResolvedValue(webhooks);
            mockWebhookRepository.count.mockResolvedValue(1);

            await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['webhook-1'] },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return webhook by ID with complete data', async () => {
            const webhook = createMockWebhookEntity({
                id: 'webhook-123',
                name: 'Test Webhook',
                url: 'https://api.example.com/hook',
                resourceTypeName: 'Consultation',
            });
            mockWebhookRepository.findById.mockResolvedValue(webhook);

            const result = await service.fetchById('webhook-123');

            expect(result.id).toBe('webhook-123');
            expect(result.name).toBe('Test Webhook');
            expect(result.url).toBe('https://api.example.com/hook');
            expect(result.resourceTypeName).toBe('Consultation');
        });

        it('should emit ResourceViewed event with webhook data', async () => {
            const webhook = createMockWebhookEntity({ id: 'webhook-123' });
            mockWebhookRepository.findById.mockResolvedValue(webhook);

            await service.fetchById('webhook-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockWebhookRepository.findById.mockRejectedValue(new Error('Webhook not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('Webhook not found');
        });
    });

    describe('update', () => {
        it('should update webhook successfully via updateWithVersion (TASK-302 Stream D Phase E.5)', async () => {
            const existingWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                name: 'Old Name',
                hasChanges: true,
                changes: { name: 'Updated Webhook' },
                version: 4,
            });
            mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
            mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...existingWebhook, version: 5 });

            const result = await service.update('webhook-123', { name: 'Updated Webhook', expectedVersion: 4 } as never);

            expect(result.id).toBe('webhook-123');
            // CAS-only — the legacy non-versioned write MUST NOT fire.
            expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalledWith('webhook-123', existingWebhook, 4);
            expect(mockWebhookRepository.update).not.toHaveBeenCalled();
        });

        it('should emit ResourceUpdated event with previousVersion + newVersion (TASK-302 Stream D Phase E.5)', async () => {
            const existingWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                hasChanges: true,
                changes: { name: 'Updated Webhook' },
                version: 9,
            });
            mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
            mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...existingWebhook, version: 10 });

            await service.update('webhook-123', { name: 'Updated Webhook', expectedVersion: 9 } as never);

            // Same audit shape as Phase C.8 / E.1 / E.2 / E.3 / E.4.
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'webhook-123',
                    data: expect.objectContaining({
                        name: 'Updated Webhook',
                        previousVersion: 9,
                        newVersion: 10,
                    }),
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                hasChanges: false,
            });
            mockWebhookRepository.findById.mockResolvedValue(existingWebhook);

            await expect(
                service.update('webhook-123', { name: 'Same Name', expectedVersion: 1 } as never)
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                hasChanges: true,
                changes: { name: 'New Name', url: 'https://new.example.com/hook' },
            });
            mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
            mockWebhookRepository.updateWithVersion.mockResolvedValue(existingWebhook);

            await service.update('webhook-123', {
                name: 'New Name',
                url: 'https://new.example.com/hook',
                expectedVersion: 1,
            } as never);

            expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalled();
        });

        it('should update webhook secret', async () => {
            const existingWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                hasChanges: true,
                changes: { hashedSecret: 'new-hashed-secret' },
            });
            mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
            mockWebhookRepository.updateWithVersion.mockResolvedValue(existingWebhook);

            await service.update('webhook-123', { hashedSecret: 'new-hashed-secret', expectedVersion: 1 } as never);

            expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalled();
        });

        it('propagates OptimisticConcurrencyException from the repository CAS write (TASK-302 Stream D Phase E.5)', async () => {
            const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
            const existingWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                hasChanges: true,
                changes: { name: 'Stale write' },
                version: 9,
            });
            mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
            mockWebhookRepository.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('Webhook', 'webhook-123', {
                    expectedVersion: 9,
                    currentVersion: 10,
                }),
            );

            await expect(
                service.update('webhook-123', { name: 'Stale write', expectedVersion: 9 } as never),
            ).rejects.toThrow(OptimisticConcurrencyException);

            // Audit MUST NOT broadcast on a failed CAS write.
            expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.anything(),
            );
        });
    });

    describe('deleteById', () => {
        it('should soft delete webhook and return deleted entity', async () => {
            const deletedWebhook = createMockWebhookEntity({
                id: 'webhook-123',
                deletedAt: new Date(),
            });
            mockWebhookRepository.softDelete.mockResolvedValue(deletedWebhook);

            const result = await service.deleteById('webhook-123');

            expect(result.id).toBe('webhook-123');
            expect(mockWebhookRepository.softDelete).toHaveBeenCalledWith('webhook-123');
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedWebhook = createMockWebhookEntity({ id: 'webhook-123' });
            mockWebhookRepository.softDelete.mockResolvedValue(deletedWebhook);

            await service.deleteById('webhook-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'webhook-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockWebhookRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('webhook-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            // TASK-306 P1.4 — `create` now requires a CLS `tenantId` (or DTO
            // tenantId via SUPER_ADMIN). Preserve the original test intent
            // ("no user") by still surfacing a valid tenantId from CLS — the
            // missing-tenant edge case is independently covered by the
            // helper test below.
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user':
                        return null;
                    case 'tenantId':
                        return 'tenant-1';
                    default:
                        return null;
                }
            });

            const newWebhook = createMockWebhookEntity({ id: 'new-webhook-id' });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
            });

            expect(result.id).toBe('new-webhook-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockWebhookRepository.findAll.mockResolvedValue([]);
            mockWebhookRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockWebhookRepository.findAll.mockResolvedValue([]);
            mockWebhookRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });

        it('should handle webhooks with complex subscription metadata', async () => {
            const complexMetadata = {
                events: ['user.created', 'user.updated', 'user.deleted'],
                filters: {
                    status: ['active', 'pending'],
                    roles: ['admin', 'user'],
                },
                retryPolicy: {
                    maxRetries: 3,
                    backoffMs: 1000,
                },
            };
            const newWebhook = createMockWebhookEntity({
                id: 'new-webhook-id',
                subscriptionMetadata: complexMetadata,
            });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'Complex Webhook',
                url: 'https://example.com/webhook',
                resourceTypeName: 'User',
                subscriptionMetadata: complexMetadata,
            });

            expect(result.subscriptionMetadata).toEqual(complexMetadata);
        });

        it('should handle URLs with special characters', async () => {
            const newWebhook = createMockWebhookEntity({
                id: 'new-webhook-id',
                url: 'https://example.com/webhook?param=value&other=test',
            });
            mockWebhookRepository.create.mockResolvedValue(newWebhook);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'URL Test Webhook',
                url: 'https://example.com/webhook?param=value&other=test',
                resourceTypeName: 'User',
            });

            expect(result.url).toBe('https://example.com/webhook?param=value&other=test');
        });
    });
});
