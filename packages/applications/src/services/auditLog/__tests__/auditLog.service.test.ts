/**
 * AuditLogService Unit Tests
 *
 * Tests for the AuditLogService that handles audit log management and event handling.
 *
 * Testing Strategy:
 * - Tests verify actual audit log behavior and data integrity
 * - Event handlers are tested for correct audit log creation
 * - Mock entities include complete structure to prevent incomplete mock anti-pattern
 * - Error handling in event handlers is verified (graceful degradation)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditLogService } from '../auditLog.service';
import {
    SysEventType,
    AuditAction,
    ResourceType,
    EventTypes,
} from '@arcaai/domains';

// Define ResourceStatus locally to avoid mock issues
const ResourceStatus = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
} as const;

// Mock ClsService (dependency boundary)
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter (dependency boundary)
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock AuditLogRepository (dependency boundary)
const mockAuditLogRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    softDelete: vi.fn(),
};

// Mock CoreDatabaseService (dependency boundary).
// TASK-314 §7: the authentication-audit write must bypass the tenant-scope
// `$extends`, so it goes through the UNSCOPED `baseClient` rather than the
// tenant-scoped repository. The scoped `client` is intentionally distinct so
// tests can assert the bypass invariant (it must never be touched here).
const mockDatabaseService = {
    client: {
        auditLog: {
            create: vi.fn(),
        },
    },
    baseClient: {
        auditLog: {
            create: vi.fn(),
        },
    },
};

/**
 * Creates a complete mock AuditLogEntity matching the real entity structure.
 * Includes all fields to prevent incomplete mock anti-pattern.
 * Updated to include new fields: eventType, success (for high-performance querying)
 *
 * TASK-305 D.8: `tenantId` defaults to 'tenant-1' to match the CLS mock context,
 * so existing tests that load entities by id pass the new ownership assertion.
 */
const createMockAuditLogEntity = (overrides: Partial<{
    id: string;
    tenantId: string | null;
    responsibleUserId: string | null;
    responsibleIp: string | null;
    resourceType: ResourceType;
    resourceId: string | null;
    action: AuditAction;
    eventType: string | null;
    success: boolean | null;
    data: object | null;
    previousData: object | null;
    metadata: object | null;
    createdAt: Date;
    updatedAt: Date;
    resourceStatus: ResourceStatus;
    deletedAt: Date | null;
    deletedBy: string | null;
}> = {}) => {
    const entity = {
        id: overrides.id ?? 'audit-log-id-1',
        tenantId: overrides.tenantId !== undefined ? overrides.tenantId : 'tenant-1',
        responsibleUserId: overrides.responsibleUserId ?? 'user-123',
        responsibleIp: overrides.responsibleIp ?? '192.168.1.1',
        resourceType: overrides.resourceType ?? ResourceType.User,
        resourceId: overrides.resourceId ?? 'resource-456',
        action: overrides.action ?? AuditAction.CREATE,
        eventType: overrides.eventType ?? null,
        success: overrides.success ?? null,
        data: overrides.data ?? { name: 'Test' },
        previousData: overrides.previousData ?? null,
        metadata: overrides.metadata ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-30T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-30T10:00:00Z'),
        resourceStatus: overrides.resourceStatus ?? ResourceStatus.ENABLED,
        deletedAt: overrides.deletedAt ?? null,
        deletedBy: overrides.deletedBy ?? null,
        toObject: vi.fn(),
    };

    entity.toObject.mockReturnValue({
        id: entity.id,
        responsibleUserId: entity.responsibleUserId,
        responsibleIp: entity.responsibleIp,
        resourceType: entity.resourceType,
        resourceId: entity.resourceId,
        action: entity.action,
        eventType: entity.eventType,
        success: entity.success,
        data: entity.data,
        previousData: entity.previousData,
        metadata: entity.metadata,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
    });

    return entity;
};

// Mock AuditLogFactory
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        AuditLogFactory: {
            CreateAuditLog: vi.fn((data) => ({
                ...data,
                id: 'new-audit-log-id',
                createdAt: new Date(),
                updatedAt: new Date(),
                toObject: vi.fn().mockReturnValue({ id: 'new-audit-log-id', ...data }),
            })),
        },
        // TASK-314 §7: the service maps the entity to its persistence shape
        // before the baseClient create. Pass the entity through unchanged so
        // the create payload stays deterministic and assertions can match the
        // factory-built fields directly.
        AuditLogEntityMapper: {
            getInstance: () => ({
                toPersistence: (entity: Record<string, unknown>) => entity,
            }),
        },
    };
});

describe('AuditLogService', () => {
    let service: AuditLogService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Default: return valid user from CLS
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'current-user-id' };
                case 'tenantId':
                    return 'tenant-1';
                case 'correlationId':
                    return 'corr-123';
                case 'requestIp':
                    return '192.168.1.1';
                default:
                    return null;
            }
        });

        // Create service instance with mocks
        service = new AuditLogService(
            mockAuditLogRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
            mockDatabaseService as any,
        );
    });

    describe('fetchAll', () => {
        it('should return paginated audit logs', async () => {
            const auditLogs = [
                createMockAuditLogEntity({ id: 'audit-1' }),
                createMockAuditLogEntity({ id: 'audit-2' }),
            ];
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['audit-1', 'audit-2'] },
                })
            );
        });

        it('should return empty result when no audit logs found', async () => {
            mockAuditLogRepository.findAll.mockResolvedValue([]);
            mockAuditLogRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should apply search filter', async () => {
            mockAuditLogRepository.findAll.mockResolvedValue([]);
            mockAuditLogRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'test' });

            expect(mockAuditLogRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test',
                })
            );
        });
    });

    describe('fetchAllByResource', () => {
        it('should return audit logs filtered by resource', async () => {
            const auditLogs = [createMockAuditLogEntity({ id: 'audit-1' })];
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByResource({
                limit: 10,
                page: 1,
                resourceType: 'User',
                resourceId: 'user-123',
            });

            expect(result.data).toHaveLength(1);
            expect(mockAuditLogRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        resourceId: 'user-123',
                        resourceType: 'User',
                    }),
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: {
                        resourceId: 'user-123',
                        resourceType: 'User',
                        items: ['audit-1'],
                    },
                })
            );
        });

        it('should apply pagination and search', async () => {
            mockAuditLogRepository.findAll.mockResolvedValue([]);
            mockAuditLogRepository.count.mockResolvedValue(0);

            await service.fetchAllByResource({
                limit: 20,
                page: 2,
                search: 'test',
                resourceType: 'Consultation',
                resourceId: 'cons-123',
            });

            expect(mockAuditLogRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test',
                    where: expect.objectContaining({
                        resourceId: 'cons-123',
                        resourceType: 'Consultation',
                    }),
                })
            );
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return audit logs created by specific user', async () => {
            const auditLogs = [createMockAuditLogEntity({ id: 'audit-1', responsibleUserId: 'creator-id' })];
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(mockAuditLogRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        responsibleUserId: 'creator-id',
                    }),
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: {
                        createdBy: 'creator-id',
                        items: ['audit-1'],
                    },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return audit log by ID', async () => {
            const auditLog = createMockAuditLogEntity({ id: 'audit-123' });
            mockAuditLogRepository.findById.mockResolvedValue(auditLog);

            const result = await service.fetchById('audit-123');

            expect(result.id).toBe('audit-123');
            expect(mockAuditLogRepository.findById).toHaveBeenCalledWith('audit-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    resourceId: 'audit-123',
                })
            );
        });

        it('should broadcast event with entity data', async () => {
            const auditLog = createMockAuditLogEntity({ id: 'audit-123' });
            mockAuditLogRepository.findById.mockResolvedValue(auditLog);

            await service.fetchById('audit-123');

            expect(auditLog.toObject).toHaveBeenCalled();
        });
    });

    describe('deleteById', () => {
        it('should soft delete audit log successfully', async () => {
            const deletedAuditLog = createMockAuditLogEntity({ id: 'audit-123' });
            mockAuditLogRepository.findById.mockResolvedValue(deletedAuditLog);
            mockAuditLogRepository.softDelete.mockResolvedValue(deletedAuditLog);

            const result = await service.deleteById('audit-123');

            expect(result.id).toBe('audit-123');
            expect(mockAuditLogRepository.softDelete).toHaveBeenCalledWith('audit-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'audit-123',
                })
            );
        });
    });

    /**
     * TASK-305 D.8 — Multi-tenant isolation for AuditLogService
     *
     * Audit finding C-5 (HIPAA §164.312(b)): fetch methods were tenant-blind,
     * letting a Tenant-A admin enumerate every tenant's audit log.
     *
     * All fetch methods MUST inject `this.tenantId` from CLS into the repository
     * `where` clause; `fetchById`/`deleteById` MUST throw `NotFoundException`
     * (never `Forbidden` — that would leak existence) when the loaded entity's
     * tenant does not match the caller. Only `SUPER_ADMIN` may bypass.
     */
    describe('Multi-tenant scoping (TASK-305 D.8)', () => {
        describe('fetchAll', () => {
            it('should inject caller tenantId into repository where clause', async () => {
                mockAuditLogRepository.findAll.mockResolvedValue([]);
                mockAuditLogRepository.count.mockResolvedValue(0);

                await service.fetchAll({ limit: 10, page: 1 });

                expect(mockAuditLogRepository.findAll).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({ tenantId: 'tenant-1' }),
                    })
                );
                expect(mockAuditLogRepository.count).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({ tenantId: 'tenant-1' }),
                    })
                );
            });

            it('should NOT inject tenantId for SUPER_ADMIN caller', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    switch (key) {
                        case 'user': return { id: 'super-admin-id', roles: ['SUPER_ADMIN'] };
                        case 'tenantId': return 'tenant-1';
                        case 'correlationId': return 'corr-123';
                        case 'requestIp': return '192.168.1.1';
                        default: return null;
                    }
                });
                mockAuditLogRepository.findAll.mockResolvedValue([]);
                mockAuditLogRepository.count.mockResolvedValue(0);

                await service.fetchAll({ limit: 10, page: 1 });

                const findAllCall = mockAuditLogRepository.findAll.mock.calls[0][0];
                expect(findAllCall.where?.tenantId).toBeUndefined();
                const countCall = mockAuditLogRepository.count.mock.calls[0][0];
                expect(countCall.where?.tenantId).toBeUndefined();
            });
        });

        describe('fetchAllByResource', () => {
            it('should merge tenantId with existing resource filter', async () => {
                mockAuditLogRepository.findAll.mockResolvedValue([]);
                mockAuditLogRepository.count.mockResolvedValue(0);

                await service.fetchAllByResource({
                    limit: 10,
                    page: 1,
                    resourceType: 'User',
                    resourceId: 'user-123',
                });

                expect(mockAuditLogRepository.findAll).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: {
                            resourceId: 'user-123',
                            resourceType: 'User',
                            tenantId: 'tenant-1',
                        },
                    })
                );
            });

            it('should NOT inject tenantId for SUPER_ADMIN caller (cross-tenant resource lookup)', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    switch (key) {
                        case 'user': return { id: 'super-admin-id', roles: ['SUPER_ADMIN'] };
                        case 'tenantId': return 'tenant-1';
                        default: return null;
                    }
                });
                mockAuditLogRepository.findAll.mockResolvedValue([]);
                mockAuditLogRepository.count.mockResolvedValue(0);

                await service.fetchAllByResource({
                    limit: 10,
                    page: 1,
                    resourceType: 'User',
                    resourceId: 'user-123',
                });

                const findAllCall = mockAuditLogRepository.findAll.mock.calls[0][0];
                expect(findAllCall.where?.tenantId).toBeUndefined();
                expect(findAllCall.where).toEqual({
                    resourceId: 'user-123',
                    resourceType: 'User',
                });
            });
        });

        describe('fetchAllCreatedByUser', () => {
            it('should merge tenantId with existing user filter', async () => {
                mockAuditLogRepository.findAll.mockResolvedValue([]);
                mockAuditLogRepository.count.mockResolvedValue(0);

                await service.fetchAllCreatedByUser({
                    limit: 10,
                    page: 1,
                    userId: 'creator-id',
                });

                expect(mockAuditLogRepository.findAll).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: {
                            responsibleUserId: 'creator-id',
                            tenantId: 'tenant-1',
                        },
                    })
                );
            });
        });

        describe('fetchById', () => {
            it('should throw NotFoundException when audit log belongs to a different tenant', async () => {
                const foreignAuditLog = createMockAuditLogEntity({
                    id: 'audit-from-tenant-2',
                    tenantId: 'tenant-2',
                });
                mockAuditLogRepository.findById.mockResolvedValue(foreignAuditLog);

                await expect(service.fetchById('audit-from-tenant-2')).rejects.toThrow(
                    'AuditLog audit-from-tenant-2 not found',
                );
                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });

            it('should NOT broadcast ResourceViewed when ownership check fails', async () => {
                const foreignAuditLog = createMockAuditLogEntity({
                    id: 'audit-from-tenant-2',
                    tenantId: 'tenant-2',
                });
                mockAuditLogRepository.findById.mockResolvedValue(foreignAuditLog);

                await expect(service.fetchById('audit-from-tenant-2')).rejects.toThrow();

                expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                    SysEventType.ResourceViewed,
                    expect.anything(),
                );
            });

            it('should return the audit log when SUPER_ADMIN reads a cross-tenant entry', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    switch (key) {
                        case 'user': return { id: 'super-admin-id', roles: ['SUPER_ADMIN'] };
                        case 'tenantId': return 'tenant-1';
                        default: return null;
                    }
                });
                const foreignAuditLog = createMockAuditLogEntity({
                    id: 'audit-from-tenant-2',
                    tenantId: 'tenant-2',
                });
                mockAuditLogRepository.findById.mockResolvedValue(foreignAuditLog);

                const result = await service.fetchById('audit-from-tenant-2');

                expect(result.id).toBe('audit-from-tenant-2');
            });
        });

        describe('deleteById', () => {
            it('should throw NotFoundException when audit log belongs to a different tenant', async () => {
                const foreignAuditLog = createMockAuditLogEntity({
                    id: 'audit-from-tenant-2',
                    tenantId: 'tenant-2',
                });
                mockAuditLogRepository.findById.mockResolvedValue(foreignAuditLog);

                await expect(service.deleteById('audit-from-tenant-2')).rejects.toThrow(
                    'AuditLog audit-from-tenant-2 not found',
                );
                expect(mockAuditLogRepository.softDelete).not.toHaveBeenCalled();
            });

            it('should NOT call softDelete when ownership check fails', async () => {
                const foreignAuditLog = createMockAuditLogEntity({
                    id: 'audit-from-tenant-2',
                    tenantId: 'tenant-2',
                });
                mockAuditLogRepository.findById.mockResolvedValue(foreignAuditLog);

                await expect(service.deleteById('audit-from-tenant-2')).rejects.toThrow();

                expect(mockAuditLogRepository.softDelete).not.toHaveBeenCalled();
            });

            it('should soft delete when SUPER_ADMIN deletes a cross-tenant entry', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    switch (key) {
                        case 'user': return { id: 'super-admin-id', roles: ['SUPER_ADMIN'] };
                        case 'tenantId': return 'tenant-1';
                        default: return null;
                    }
                });
                const foreignAuditLog = createMockAuditLogEntity({
                    id: 'audit-from-tenant-2',
                    tenantId: 'tenant-2',
                });
                mockAuditLogRepository.findById.mockResolvedValue(foreignAuditLog);
                mockAuditLogRepository.softDelete.mockResolvedValue(foreignAuditLog);

                const result = await service.deleteById('audit-from-tenant-2');

                expect(result.id).toBe('audit-from-tenant-2');
                expect(mockAuditLogRepository.softDelete).toHaveBeenCalledWith('audit-from-tenant-2');
            });
        });

        describe('Missing tenant context', () => {
            it('should throw NotFoundException on fetchAll when caller has no tenantId and is not SUPER_ADMIN', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    switch (key) {
                        case 'user': return { id: 'user-no-tenant', roles: ['Doctor'] };
                        case 'tenantId': return null;
                        default: return null;
                    }
                });

                await expect(service.fetchAll({ limit: 10, page: 1 })).rejects.toThrow(
                    'AuditLog scope unavailable',
                );
                expect(mockAuditLogRepository.findAll).not.toHaveBeenCalled();
            });
        });
    });

    describe('Event Handlers', () => {
        /**
         * Architecture Note:
         * CRUD audit logs (CREATE, READ, UPDATE, DELETE) are created exclusively via
         * SysEventService → Redis queue → background worker. The AuditLogService only
         * handles authentication events directly via @OnEvent(EventTypes.UserAuthenticated).
         *
         * SysEventType values (e.g., 'SysEvent.ResourceCreated') differ from
         * EventTypes values (e.g., 'resource.created'). Services broadcast SysEventType
         * events, which are handled by SysEventService, not AuditLogService.
         */

        describe('handleUserAuthenticatedEvent', () => {
            it('should create audit log with LOGIN action for authentication event', async () => {
                const event = {
                    userId: 'user-123',
                    timestamp: new Date('2026-02-06T10:00:00Z'),
                    ip: '10.0.0.1',
                    userAgent: 'Mozilla/5.0',
                    method: 'oauth',
                };

                await service.handleUserAuthenticatedEvent(event);

                expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            action: AuditAction.LOGIN,
                            eventType: 'AUTHENTICATION',
                            success: true,
                            responsibleUserId: 'user-123',
                            responsibleIp: '10.0.0.1',
                            resourceId: 'user-123',
                            resourceType: ResourceType.User,
                        }),
                    })
                );
            });

            it('should use requestIp from context when ip not provided in event', async () => {
                const event = {
                    userId: 'user-123',
                };

                await service.handleUserAuthenticatedEvent(event);

                expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            responsibleIp: '192.168.1.1', // From CLS context
                        }),
                    })
                );
            });

            it('should fallback to event.id when userId is not provided', async () => {
                const event = {
                    id: 'fallback-user-id',
                } as any;

                await service.handleUserAuthenticatedEvent(event);

                expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            responsibleUserId: 'fallback-user-id',
                            resourceId: 'fallback-user-id',
                        }),
                    })
                );
            });

            it('should use default method "oauth" when not provided', async () => {
                const event = {
                    userId: 'user-123',
                };

                await service.handleUserAuthenticatedEvent(event);

                expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            data: expect.objectContaining({
                                method: 'oauth',
                            }),
                        }),
                    })
                );
            });

            it('should handle errors gracefully without throwing', async () => {
                mockDatabaseService.baseClient.auditLog.create.mockRejectedValue(new Error('DB error'));

                const event = {
                    userId: 'user-123',
                };

                // Should not throw - errors are caught internally
                await expect(service.handleUserAuthenticatedEvent(event)).resolves.toBeUndefined();
            });

            describe('impersonation branch (TASK-295 C-3)', () => {
                it('should persist impersonatedUserId, endpoint, httpMethod when event carries impersonatedUserId', async () => {
                    const event = {
                        userId: 'admin-001',
                        impersonatedUserId: 'doctor-001',
                        timestamp: new Date('2026-05-24T15:00:00Z'),
                        ip: '10.0.0.1',
                        userAgent: 'Mozilla/5.0',
                        endpoint: '/api/v1/consultations',
                        method: 'POST',
                    } as any;

                    await service.handleUserAuthenticatedEvent(event);

                    expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                        expect.objectContaining({
                            data: expect.objectContaining({
                                action: AuditAction.IMPERSONATED_ACTION,
                                eventType: 'IMPERSONATION',
                                success: true,
                                responsibleUserId: 'admin-001',
                                resourceId: 'doctor-001',
                                resourceType: ResourceType.User,
                                data: expect.objectContaining({
                                    endpoint: '/api/v1/consultations',
                                    httpMethod: 'POST',
                                    impersonatedUserId: 'doctor-001',
                                    userAgent: 'Mozilla/5.0',
                                }),
                            }),
                        }),
                    );
                });

                it('should NOT use IMPERSONATED_ACTION for a regular login event (no impersonatedUserId)', async () => {
                    const event = {
                        userId: 'user-123',
                        timestamp: new Date('2026-05-24T15:00:00Z'),
                        ip: '10.0.0.1',
                        userAgent: 'Mozilla/5.0',
                        endpoint: '/auth/login',
                        method: 'POST',
                    } as any;

                    await service.handleUserAuthenticatedEvent(event);

                    expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                        expect.objectContaining({
                            data: expect.objectContaining({
                                action: AuditAction.LOGIN,
                                eventType: 'AUTHENTICATION',
                                responsibleUserId: 'user-123',
                                resourceId: 'user-123',
                            }),
                        }),
                    );
                });
            });

            it('should include userAgent and timestamp in audit data', async () => {
                const timestamp = new Date('2026-02-06T15:30:00Z');
                const event = {
                    userId: 'user-123',
                    timestamp,
                    userAgent: 'TestAgent/1.0',
                    method: 'saml',
                };

                await service.handleUserAuthenticatedEvent(event);

                expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            data: expect.objectContaining({
                                method: 'saml',
                                timestamp: timestamp.toISOString(),
                                userAgent: 'TestAgent/1.0',
                            }),
                        }),
                    })
                );
            });

            /**
             * TASK-314 §7 — tenant-scope bypass invariant for the auth audit.
             *
             * `AuthService.trackAuthentication` emits `user.authenticated` while
             * CLS still has NO tenant context (login is a public route handled
             * before any user/tenant is hydrated). `AuditLog` is tenant-scoped
             * (TASK-305 Phase B), so the normal repository write would throw
             * "tenant context required for model AuditLog" and the row would be
             * silently dropped. The fix routes the create through the UNSCOPED
             * `baseClient`; the audit's tenantId is already resolved by the
             * factory (CLS tenant, or SYSTEM_TENANT_ID for tenant-less/system
             * logins), so the scope filter adds nothing here.
             */
            describe('tenant-scope bypass invariant (TASK-314 §7)', () => {
                it('persists the LOGIN audit via the unscoped baseClient when CLS has no tenant context', async () => {
                    // Clean-boot login: no user, no tenantId in CLS.
                    mockClsService.get.mockImplementation((key: string) => {
                        switch (key) {
                            case 'requestIp': return '203.0.113.7';
                            default: return null;
                        }
                    });

                    await service.handleUserAuthenticatedEvent({ userId: 'super-admin-1' });

                    expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledTimes(1);
                    expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledWith(
                        expect.objectContaining({
                            data: expect.objectContaining({
                                action: AuditAction.LOGIN,
                                responsibleUserId: 'super-admin-1',
                            }),
                        }),
                    );
                });

                it('never routes the auth audit through the tenant-scoped repository or client', async () => {
                    await service.handleUserAuthenticatedEvent({ userId: 'user-123' });

                    expect(mockAuditLogRepository.create).not.toHaveBeenCalled();
                    expect(mockDatabaseService.client.auditLog.create).not.toHaveBeenCalled();
                });
            });
        });
    });

    describe('Context Integration', () => {
        it('should use requestIp from CLS context', async () => {
            const auditLog = createMockAuditLogEntity({ id: 'audit-123' });
            mockAuditLogRepository.findById.mockResolvedValue(auditLog);

            await service.fetchById('audit-123');

            // The service should access requestIp from context
            expect(mockClsService.get).toHaveBeenCalledWith('requestIp');
        });

        it('should use user from CLS context for event broadcasting', async () => {
            const auditLog = createMockAuditLogEntity({ id: 'audit-123' });
            mockAuditLogRepository.findById.mockResolvedValue(auditLog);

            await service.fetchById('audit-123');

            expect(mockClsService.get).toHaveBeenCalledWith('user');
        });
    });

    describe('Audit Log Data Integrity', () => {
        it('should preserve complete data structure in audit logs', async () => {
            const complexData = {
                user: { id: 'user-1', name: 'Test User' },
                changes: { field1: 'old', field2: 'new' },
                metadata: { source: 'api', version: '1.0' },
            };
            const auditLog = createMockAuditLogEntity({
                id: 'audit-123',
                data: complexData,
            });
            mockAuditLogRepository.findById.mockResolvedValue(auditLog);

            const result = await service.fetchById('audit-123');

            expect(result.data).toEqual(complexData);
        });

        it('should preserve previousData for update actions', async () => {
            const previousData = { name: 'Old Name', status: 'active' };
            const currentData = { name: 'New Name', status: 'inactive' };
            const auditLog = createMockAuditLogEntity({
                id: 'audit-123',
                action: AuditAction.UPDATE,
                data: currentData,
                previousData: previousData,
            });
            mockAuditLogRepository.findById.mockResolvedValue(auditLog);

            const result = await service.fetchById('audit-123');

            expect(result.previousData).toEqual(previousData);
            expect(result.data).toEqual(currentData);
        });
    });

    describe('Architecture: CRUD Audit Logs via SysEventService', () => {
        /**
         * CRUD audit logs are NOT created by AuditLogService event handlers.
         * They flow through: Service → broadcastSysEvent(SysEventType.*) → SysEventService → Redis queue.
         *
         * These tests verify that AuditLogService does NOT have CRUD event handlers,
         * confirming the architectural boundary is correct.
         */

        it('should not have handleResourceCreatedEvent method (CRUD handled by SysEventService)', () => {
            expect((service as any).handleResourceCreatedEvent).toBeUndefined();
        });

        it('should not have handleResourceUpdatedEvent method (CRUD handled by SysEventService)', () => {
            expect((service as any).handleResourceUpdatedEvent).toBeUndefined();
        });

        it('should not have handleResourceDeletedEvent method (CRUD handled by SysEventService)', () => {
            expect((service as any).handleResourceDeletedEvent).toBeUndefined();
        });

        it('should not have handleResourceViewedEvent method (CRUD handled by SysEventService)', () => {
            expect((service as any).handleResourceViewedEvent).toBeUndefined();
        });

        it('should have handleUserAuthenticatedEvent method (authentication handled directly)', () => {
            expect(typeof service.handleUserAuthenticatedEvent).toBe('function');
        });
    });

    describe('Repository Error Handling', () => {
        it('should propagate repository errors on findById', async () => {
            mockAuditLogRepository.findById.mockRejectedValue(new Error('Entity not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('Entity not found');
        });

        it('should propagate repository errors on findAll', async () => {
            mockAuditLogRepository.findAll.mockRejectedValue(new Error('Database error'));

            await expect(service.fetchAll({ limit: 10, page: 1 })).rejects.toThrow('Database error');
        });

        it('should propagate repository errors on softDelete', async () => {
            // deleteById first loads via findById (for tenant ownership check),
            // then calls softDelete. Mock findById to succeed so the failure surfaces
            // from softDelete itself.
            mockAuditLogRepository.findById.mockResolvedValue(createMockAuditLogEntity({ id: 'audit-123' }));
            mockAuditLogRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('audit-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('Pagination Behavior', () => {
        it('should return correct pagination metadata', async () => {
            const auditLogs = Array.from({ length: 5 }, (_, i) =>
                createMockAuditLogEntity({ id: `audit-${i}` })
            );
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(100);

            const result = await service.fetchAll({ limit: 5, page: 3 });

            expect(result.data).toHaveLength(5);
            expect(result.count).toBe(100);
            expect(result.limit).toBe(5);
            expect(result.page).toBe(3);
        });

        it('should handle last page with fewer items', async () => {
            const auditLogs = [createMockAuditLogEntity({ id: 'audit-last' })];
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(21);

            const result = await service.fetchAll({ limit: 10, page: 3 });

            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(21);
        });
    });

    describe('New Fields: eventType and success', () => {
        describe('eventType field', () => {
            it('should return audit log with eventType field', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-123',
                    eventType: 'AUTHORIZATION',
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-123');

                expect(result.eventType).toBe('AUTHORIZATION');
            });

            it('should return audit log with null eventType', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-123',
                    eventType: null,
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-123');

                expect(result.eventType).toBeNull();
            });

            it('should handle different eventType values', async () => {
                const eventTypes = ['AUTHORIZATION', 'RESOURCE', 'SYSTEM', 'CUSTOM'];

                for (const eventType of eventTypes) {
                    const auditLog = createMockAuditLogEntity({
                        id: `audit-${eventType}`,
                        eventType,
                    });
                    mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                    const result = await service.fetchById(`audit-${eventType}`);

                    expect(result.eventType).toBe(eventType);
                }
            });
        });

        describe('success field', () => {
            it('should return audit log with success=true', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-123',
                    success: true,
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-123');

                expect(result.success).toBe(true);
            });

            it('should return audit log with success=false', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-123',
                    success: false,
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-123');

                expect(result.success).toBe(false);
            });

            it('should return audit log with null success', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-123',
                    success: null,
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-123');

                expect(result.success).toBeNull();
            });
        });

        describe('combined eventType and success', () => {
            it('should return audit log with both eventType and success for authorization', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-auth-success',
                    eventType: 'AUTHORIZATION',
                    success: true,
                    action: AuditAction.READ,
                    metadata: { endpoint: '/api/users', method: 'GET' },
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-auth-success');

                expect(result.eventType).toBe('AUTHORIZATION');
                expect(result.success).toBe(true);
                expect(result.action).toBe(AuditAction.READ);
            });

            it('should return audit log for failed authorization', async () => {
                const auditLog = createMockAuditLogEntity({
                    id: 'audit-auth-failed',
                    eventType: 'AUTHORIZATION',
                    success: false,
                    action: AuditAction.READ,
                    metadata: {
                        endpoint: '/api/admin',
                        method: 'GET',
                        reason: 'Insufficient permissions',
                    },
                });
                mockAuditLogRepository.findById.mockResolvedValue(auditLog);

                const result = await service.fetchById('audit-auth-failed');

                expect(result.eventType).toBe('AUTHORIZATION');
                expect(result.success).toBe(false);
                expect(result.metadata).toEqual({
                    endpoint: '/api/admin',
                    method: 'GET',
                    reason: 'Insufficient permissions',
                });
            });

            it('should return paginated audit logs filtered by eventType', async () => {
                const auditLogs = [
                    createMockAuditLogEntity({ id: 'audit-1', eventType: 'AUTHORIZATION', success: true }),
                    createMockAuditLogEntity({ id: 'audit-2', eventType: 'AUTHORIZATION', success: false }),
                ];
                mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
                mockAuditLogRepository.count.mockResolvedValue(2);

                const result = await service.fetchAll({ limit: 10, page: 1 });

                expect(result.data).toHaveLength(2);
                expect(result.data[0].eventType).toBe('AUTHORIZATION');
                expect(result.data[1].eventType).toBe('AUTHORIZATION');
            });
        });
    });

    describe('High-Performance Query Scenarios', () => {
        it('should handle audit logs for authorization history query pattern', async () => {
            // This tests the query pattern: eventType + responsibleUserId + createdAt
            const auditLogs = [
                createMockAuditLogEntity({
                    id: 'audit-1',
                    eventType: 'AUTHORIZATION',
                    responsibleUserId: 'user-123',
                    success: true,
                    createdAt: new Date('2026-02-04T10:00:00Z'),
                }),
                createMockAuditLogEntity({
                    id: 'audit-2',
                    eventType: 'AUTHORIZATION',
                    responsibleUserId: 'user-123',
                    success: false,
                    createdAt: new Date('2026-02-04T09:00:00Z'),
                }),
            ];
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(2);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'user-123',
            });

            expect(result.data).toHaveLength(2);
            expect(result.data.every(log => log.responsibleUserId === 'user-123')).toBe(true);
        });

        it('should handle audit logs for tenant + time query pattern', async () => {
            // This tests the query pattern: tenantId + createdAt
            const auditLogs = Array.from({ length: 5 }, (_, i) =>
                createMockAuditLogEntity({
                    id: `audit-${i}`,
                    eventType: 'RESOURCE',
                    success: true,
                    createdAt: new Date(`2026-02-0${i + 1}T10:00:00Z`),
                })
            );
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(5);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(5);
        });

        it('should handle audit logs for resource-based query pattern', async () => {
            // This tests the query pattern: resourceType + resourceId
            const auditLogs = [
                createMockAuditLogEntity({
                    id: 'audit-1',
                    resourceType: ResourceType.Consultation,
                    resourceId: 'cons-123',
                    eventType: 'RESOURCE',
                    action: AuditAction.CREATE,
                }),
                createMockAuditLogEntity({
                    id: 'audit-2',
                    resourceType: ResourceType.Consultation,
                    resourceId: 'cons-123',
                    eventType: 'RESOURCE',
                    action: AuditAction.UPDATE,
                }),
            ];
            mockAuditLogRepository.findAll.mockResolvedValue(auditLogs);
            mockAuditLogRepository.count.mockResolvedValue(2);

            const result = await service.fetchAllByResource({
                limit: 10,
                page: 1,
                resourceType: 'Consultation',
                resourceId: 'cons-123',
            });

            expect(result.data).toHaveLength(2);
            expect(result.data.every(log => log.resourceId === 'cons-123')).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // TASK-326 X1 — recordSystemAction: privileged/system action direct-write.
    // Used by the Prisma Studio BFF (raw SQL, untenanted) so every query is on
    // the audit trail. Mirrors the auth direct-write: UNSCOPED baseClient +
    // system-tenant fallback + best-effort (never throws).
    // -------------------------------------------------------------------------
    describe('recordSystemAction (TASK-326 X1)', () => {
        it('writes a privileged-action audit row via the UNSCOPED baseClient', async () => {
            await service.recordSystemAction({
                action: AuditAction.READ,
                eventType: 'PRISMA_STUDIO',
                resourceType: ResourceType.AuditLog,
                data: { kind: 'query' },
            });

            // Direct write bypasses the tenant-scope extension (the operator may
            // be tenant-less), so it MUST go through baseClient — never client.
            expect(mockDatabaseService.baseClient.auditLog.create).toHaveBeenCalledTimes(1);
            expect(mockDatabaseService.client.auditLog.create).not.toHaveBeenCalled();

            const [{ data }] = mockDatabaseService.baseClient.auditLog.create.mock.calls[0];
            expect(data).toEqual(
                expect.objectContaining({
                    action: AuditAction.READ,
                    eventType: 'PRISMA_STUDIO',
                    resourceType: ResourceType.AuditLog,
                    responsibleUserId: 'current-user-id',
                    tenantId: 'tenant-1',
                }),
            );
        });

        it('falls back to the system tenant when the operator has no CLS tenant (super-admin)', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'super-admin-id', roles: ['SUPER_ADMIN'] };
                if (key === 'requestIp') return '10.0.0.1';
                return null; // no tenantId
            });

            await service.recordSystemAction({
                action: AuditAction.UPDATE,
                eventType: 'PRISMA_STUDIO',
                resourceType: ResourceType.AuditLog,
            });

            const [{ data }] = mockDatabaseService.baseClient.auditLog.create.mock.calls[0];
            expect(data.tenantId).toBe('00000000-0000-0000-0000-000000000000');
        });

        it('never throws when the audit write fails (best-effort)', async () => {
            mockDatabaseService.baseClient.auditLog.create.mockRejectedValueOnce(new Error('db down'));

            await expect(
                service.recordSystemAction({
                    action: AuditAction.READ,
                    eventType: 'PRISMA_STUDIO',
                    resourceType: ResourceType.AuditLog,
                }),
            ).resolves.toBeUndefined();
        });
    });
});
