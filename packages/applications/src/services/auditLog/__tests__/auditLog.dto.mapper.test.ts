/**
 * AuditLogDtoMapper Unit Tests
 *
 * Tests for the AuditLogDtoMapper that handles DTO transformations.
 *
 * Testing Strategy:
 * - We mock AutoClassMapper to simulate the actual mapping behavior
 * - Tests verify the mapper produces correct output structure
 * - Complete mock entities prevent Anti-Pattern #4 (Incomplete Mocks)
 * - Tests verify all audit action types and resource types
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditLogDtoMapper } from '../auditLog.dto.mapper';
import { AuditLogResponse, PaginatedAuditLogResponse } from '../dto';
import { FetchResponse } from '../../../common';
import { AuditAction, ResourceType } from '@arcaai/domains';

// Define ResourceStatus locally to avoid mock issues
const ResourceStatus = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
} as const;

// Mock AutoClassMapper to simulate real mapping behavior
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        AutoClassMapper: vi.fn((source, TargetClass) => {
            // Simulate AutoClassMapper behavior for AuditLogResponse
            // Updated to include new fields: eventType, success
            return new AuditLogResponse({
                id: source.id,
                responsibleUserId: source.responsibleUserId,
                responsibleIp: source.responsibleIp,
                resourceType: source.resourceType,
                resourceId: source.resourceId,
                action: source.action,
                eventType: source.eventType ?? null,
                success: source.success ?? null,
                data: source.data,
                previousData: source.previousData,
                metadata: source.metadata,
                createdAt: source.createdAt ?? new Date(),
                updatedAt: source.updatedAt ?? new Date(),
            });
        }),
    };
});

/**
 * Creates a complete mock AuditLogEntity matching the real entity structure.
 * Includes all fields to prevent incomplete mock anti-pattern.
 * Uses 'in' operator to properly handle explicit null values in overrides.
 * Updated to include new fields: eventType, success (for high-performance querying)
 */
const createMockAuditLogEntity = (overrides: Partial<{
    id: string;
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
    resourceStatus: typeof ResourceStatus[keyof typeof ResourceStatus];
    deletedAt: Date | null;
    deletedBy: string | null;
}> = {}) => ({
    id: 'id' in overrides ? overrides.id! : 'audit-log-id-1',
    responsibleUserId: 'responsibleUserId' in overrides ? overrides.responsibleUserId : 'user-123',
    responsibleIp: 'responsibleIp' in overrides ? overrides.responsibleIp : '192.168.1.1',
    resourceType: 'resourceType' in overrides ? overrides.resourceType! : ResourceType.User,
    resourceId: 'resourceId' in overrides ? overrides.resourceId : 'resource-456',
    action: 'action' in overrides ? overrides.action! : AuditAction.CREATE,
    eventType: 'eventType' in overrides ? overrides.eventType : null,
    success: 'success' in overrides ? overrides.success : null,
    data: 'data' in overrides ? overrides.data : { name: 'Test' },
    previousData: 'previousData' in overrides ? overrides.previousData : null,
    metadata: 'metadata' in overrides ? overrides.metadata : null,
    createdAt: 'createdAt' in overrides ? overrides.createdAt! : new Date('2026-01-30T10:00:00Z'),
    updatedAt: 'updatedAt' in overrides ? overrides.updatedAt! : new Date('2026-01-30T10:00:00Z'),
    resourceStatus: 'resourceStatus' in overrides ? overrides.resourceStatus! : ResourceStatus.ENABLED,
    deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : null,
    deletedBy: 'deletedBy' in overrides ? overrides.deletedBy : null,
});

describe('AuditLogDtoMapper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('ToResponse', () => {
        it('should map AuditLogEntity to AuditLogResponse', () => {
            const entity = createMockAuditLogEntity();

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result).toBeInstanceOf(AuditLogResponse);
            expect(result.id).toBe('audit-log-id-1');
            expect(result.responsibleUserId).toBe('user-123');
            expect(result.responsibleIp).toBe('192.168.1.1');
            expect(result.resourceType).toBe(ResourceType.User);
            expect(result.resourceId).toBe('resource-456');
            expect(result.action).toBe(AuditAction.CREATE);
        });

        it('should map data field', () => {
            const entity = createMockAuditLogEntity({
                data: { key: 'value', nested: { data: true } },
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.data).toEqual({ key: 'value', nested: { data: true } });
        });

        it('should map previousData field', () => {
            const entity = createMockAuditLogEntity({
                previousData: { oldKey: 'oldValue' },
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.previousData).toEqual({ oldKey: 'oldValue' });
        });

        it('should map metadata field', () => {
            const entity = createMockAuditLogEntity({
                metadata: { source: 'api', version: '1.0' },
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.metadata).toEqual({ source: 'api', version: '1.0' });
        });

        it('should handle null responsibleUserId', () => {
            const entity = createMockAuditLogEntity({
                responsibleUserId: null,
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.responsibleUserId).toBeNull();
        });

        it('should handle null responsibleIp', () => {
            const entity = createMockAuditLogEntity({
                responsibleIp: null,
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.responsibleIp).toBeNull();
        });

        it('should handle null resourceId', () => {
            const entity = createMockAuditLogEntity({
                resourceId: null,
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.resourceId).toBeNull();
        });

        it('should handle null data', () => {
            const entity = createMockAuditLogEntity({
                data: null,
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.data).toBeNull();
        });

        it('should handle different action types', () => {
            const actions = [AuditAction.CREATE, AuditAction.READ, AuditAction.UPDATE, AuditAction.DELETE];

            for (const action of actions) {
                const entity = createMockAuditLogEntity({ action });
                const result = AuditLogDtoMapper.ToResponse(entity as any);
                expect(result.action).toBe(action);
            }
        });

        it('should handle different resource types', () => {
            const resourceTypes = [
                ResourceType.User,
                ResourceType.Consultation,
                ResourceType.Tag,
                ResourceType.AuditLog,
            ];

            for (const resourceType of resourceTypes) {
                const entity = createMockAuditLogEntity({ resourceType });
                const result = AuditLogDtoMapper.ToResponse(entity as any);
                expect(result.resourceType).toBe(resourceType);
            }
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map FetchResponse to PaginatedAuditLogResponse', () => {
            const entities = [
                createMockAuditLogEntity({ id: 'audit-1' }),
                createMockAuditLogEntity({ id: 'audit-2' }),
            ];
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 2,
                limit: 10,
                page: 1,
            });

            const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedAuditLogResponse);
            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should map each entity to response', () => {
            const entities = [
                createMockAuditLogEntity({ id: 'audit-1', action: AuditAction.CREATE }),
                createMockAuditLogEntity({ id: 'audit-2', action: AuditAction.UPDATE }),
                createMockAuditLogEntity({ id: 'audit-3', action: AuditAction.DELETE }),
            ];
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].id).toBe('audit-1');
            expect(result.data[0].action).toBe(AuditAction.CREATE);
            expect(result.data[1].id).toBe('audit-2');
            expect(result.data[1].action).toBe(AuditAction.UPDATE);
            expect(result.data[2].id).toBe('audit-3');
            expect(result.data[2].action).toBe(AuditAction.DELETE);
        });

        it('should handle empty data array', () => {
            const fetchResponse = new FetchResponse({
                data: [],
                count: 0,
                limit: 10,
                page: 1,
            });

            const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should preserve pagination metadata', () => {
            const fetchResponse = new FetchResponse({
                data: [createMockAuditLogEntity()] as any,
                count: 100,
                limit: 20,
                page: 5,
            });

            const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(100);
            expect(result.limit).toBe(20);
            expect(result.page).toBe(5);
        });

        it('should handle large data sets', () => {
            const entities = Array.from({ length: 100 }, (_, i) =>
                createMockAuditLogEntity({ id: `audit-${i}` })
            );
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 1000,
                limit: 100,
                page: 1,
            });

            const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(100);
            expect(result.count).toBe(1000);
        });
    });

    describe('Edge Cases', () => {
        it('should handle entity with complex nested data', () => {
            const entity = createMockAuditLogEntity({
                data: {
                    user: {
                        profile: {
                            settings: {
                                notifications: true,
                                theme: 'dark',
                            },
                        },
                    },
                    roles: ['admin', 'user'],
                    metadata: {
                        timestamp: '2026-01-30T10:00:00Z',
                    },
                },
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.data).toEqual(entity.data);
        });

        it('should handle entity with array data', () => {
            const entity = createMockAuditLogEntity({
                data: ['item1', 'item2', 'item3'],
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.data).toEqual(['item1', 'item2', 'item3']);
        });

        it('should handle entity with special characters in data', () => {
            const entity = createMockAuditLogEntity({
                data: {
                    message: "Special chars: <>&\"'",
                    unicode: '日本語 한국어',
                },
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.data).toEqual({
                message: "Special chars: <>&\"'",
                unicode: '日本語 한국어',
            });
        });
    });

    describe('Response Type Verification', () => {
        it('should return AuditLogResponse instance with correct prototype', () => {
            const entity = createMockAuditLogEntity();

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result).toBeInstanceOf(AuditLogResponse);
            expect(Object.getPrototypeOf(result).constructor.name).toBe('AuditLogResponse');
        });

        it('should return PaginatedAuditLogResponse instance with correct prototype', () => {
            const fetchResponse = new FetchResponse({
                data: [createMockAuditLogEntity()] as any,
                count: 1,
                limit: 10,
                page: 1,
            });

            const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedAuditLogResponse);
            expect(Object.getPrototypeOf(result).constructor.name).toBe('PaginatedAuditLogResponse');
        });

        it('should produce serializable JSON output', () => {
            const entity = createMockAuditLogEntity({
                id: 'audit-123',
                action: AuditAction.UPDATE,
                data: { field: 'value' },
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);
            const json = JSON.stringify(result);
            const parsed = JSON.parse(json);

            expect(parsed.id).toBe('audit-123');
            expect(parsed.action).toBe(AuditAction.UPDATE);
            expect(parsed.data).toEqual({ field: 'value' });
        });
    });

    describe('Data Integrity', () => {
        it('should not mutate the source entity', () => {
            const originalData = { name: 'Original' };
            const entity = createMockAuditLogEntity({
                data: originalData,
            });

            AuditLogDtoMapper.ToResponse(entity as any);

            expect(entity.data).toEqual(originalData);
        });

        it('should preserve date precision in mapping', () => {
            const preciseDate = new Date('2026-01-30T10:30:45.123Z');
            const entity = createMockAuditLogEntity({
                createdAt: preciseDate,
                updatedAt: preciseDate,
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            // Verify dates are preserved (may be Date or ISO string depending on serialization)
            expect(new Date(result.createdAt).getTime()).toBe(preciseDate.getTime());
            expect(new Date(result.updatedAt).getTime()).toBe(preciseDate.getTime());
        });

        it('should preserve previousData and data relationship', () => {
            const previousData = { status: 'active', name: 'Old Name' };
            const currentData = { status: 'inactive', name: 'New Name' };
            const entity = createMockAuditLogEntity({
                action: AuditAction.UPDATE,
                previousData,
                data: currentData,
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.previousData).toEqual(previousData);
            expect(result.data).toEqual(currentData);
        });
    });

    describe('IP Address Handling', () => {
        it('should handle IPv4 addresses', () => {
            const entity = createMockAuditLogEntity({
                responsibleIp: '192.168.1.100',
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.responsibleIp).toBe('192.168.1.100');
        });

        it('should handle IPv6 addresses', () => {
            const entity = createMockAuditLogEntity({
                responsibleIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.responsibleIp).toBe('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
        });

        it('should handle localhost addresses', () => {
            const entity = createMockAuditLogEntity({
                responsibleIp: '127.0.0.1',
            });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.responsibleIp).toBe('127.0.0.1');
        });
    });

    describe('Metadata Handling', () => {
        it('should preserve complete metadata structure', () => {
            const metadata = {
                source: 'api',
                version: '2.0',
                requestId: 'req-123',
                userAgent: 'Mozilla/5.0',
                headers: {
                    'content-type': 'application/json',
                },
            };
            const entity = createMockAuditLogEntity({ metadata });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.metadata).toEqual(metadata);
        });

        it('should handle empty metadata object', () => {
            const entity = createMockAuditLogEntity({ metadata: {} });

            const result = AuditLogDtoMapper.ToResponse(entity as any);

            expect(result.metadata).toEqual({});
        });
    });

    describe('New Fields: eventType and success', () => {
        describe('eventType field mapping', () => {
            it('should map eventType field correctly', () => {
                const entity = createMockAuditLogEntity({
                    eventType: 'AUTHORIZATION',
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.eventType).toBe('AUTHORIZATION');
            });

            it('should handle null eventType', () => {
                const entity = createMockAuditLogEntity({
                    eventType: null,
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.eventType).toBeNull();
            });

            it('should handle different eventType values', () => {
                const eventTypes = ['AUTHORIZATION', 'RESOURCE', 'SYSTEM', 'CUSTOM'];

                for (const eventType of eventTypes) {
                    const entity = createMockAuditLogEntity({ eventType });
                    const result = AuditLogDtoMapper.ToResponse(entity as any);
                    expect(result.eventType).toBe(eventType);
                }
            });
        });

        describe('success field mapping', () => {
            it('should map success=true correctly', () => {
                const entity = createMockAuditLogEntity({
                    success: true,
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.success).toBe(true);
            });

            it('should map success=false correctly', () => {
                const entity = createMockAuditLogEntity({
                    success: false,
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.success).toBe(false);
            });

            it('should handle null success', () => {
                const entity = createMockAuditLogEntity({
                    success: null,
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.success).toBeNull();
            });
        });

        describe('combined eventType and success mapping', () => {
            it('should map authorization success audit log', () => {
                const entity = createMockAuditLogEntity({
                    eventType: 'AUTHORIZATION',
                    success: true,
                    action: AuditAction.READ,
                    metadata: { endpoint: '/api/users', method: 'GET' },
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.eventType).toBe('AUTHORIZATION');
                expect(result.success).toBe(true);
                expect(result.action).toBe(AuditAction.READ);
                expect(result.metadata).toEqual({ endpoint: '/api/users', method: 'GET' });
            });

            it('should map authorization failure audit log', () => {
                const entity = createMockAuditLogEntity({
                    eventType: 'AUTHORIZATION',
                    success: false,
                    action: AuditAction.READ,
                    metadata: {
                        endpoint: '/api/admin',
                        method: 'GET',
                        reason: 'Insufficient permissions',
                    },
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.eventType).toBe('AUTHORIZATION');
                expect(result.success).toBe(false);
                expect(result.metadata).toEqual({
                    endpoint: '/api/admin',
                    method: 'GET',
                    reason: 'Insufficient permissions',
                });
            });

            it('should map resource event audit log', () => {
                const entity = createMockAuditLogEntity({
                    eventType: 'RESOURCE',
                    success: true,
                    action: AuditAction.CREATE,
                    resourceType: ResourceType.Consultation,
                    data: { title: 'New Consultation' },
                });

                const result = AuditLogDtoMapper.ToResponse(entity as any);

                expect(result.eventType).toBe('RESOURCE');
                expect(result.success).toBe(true);
                expect(result.action).toBe(AuditAction.CREATE);
                expect(result.resourceType).toBe(ResourceType.Consultation);
            });
        });

        describe('paginated response with new fields', () => {
            it('should map paginated response with eventType and success', () => {
                const entities = [
                    createMockAuditLogEntity({
                        id: 'audit-1',
                        eventType: 'AUTHORIZATION',
                        success: true,
                    }),
                    createMockAuditLogEntity({
                        id: 'audit-2',
                        eventType: 'AUTHORIZATION',
                        success: false,
                    }),
                    createMockAuditLogEntity({
                        id: 'audit-3',
                        eventType: 'RESOURCE',
                        success: true,
                    }),
                ];
                const fetchResponse = new FetchResponse({
                    data: entities as any,
                    count: 3,
                    limit: 10,
                    page: 1,
                });

                const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

                expect(result.data).toHaveLength(3);
                expect(result.data[0].eventType).toBe('AUTHORIZATION');
                expect(result.data[0].success).toBe(true);
                expect(result.data[1].eventType).toBe('AUTHORIZATION');
                expect(result.data[1].success).toBe(false);
                expect(result.data[2].eventType).toBe('RESOURCE');
                expect(result.data[2].success).toBe(true);
            });

            it('should handle mixed null and non-null eventType/success in paginated response', () => {
                const entities = [
                    createMockAuditLogEntity({
                        id: 'audit-1',
                        eventType: 'AUTHORIZATION',
                        success: true,
                    }),
                    createMockAuditLogEntity({
                        id: 'audit-2',
                        eventType: null,
                        success: null,
                    }),
                ];
                const fetchResponse = new FetchResponse({
                    data: entities as any,
                    count: 2,
                    limit: 10,
                    page: 1,
                });

                const result = AuditLogDtoMapper.ToPaginatedResponse(fetchResponse);

                expect(result.data[0].eventType).toBe('AUTHORIZATION');
                expect(result.data[0].success).toBe(true);
                expect(result.data[1].eventType).toBeNull();
                expect(result.data[1].success).toBeNull();
            });
        });
    });
});
