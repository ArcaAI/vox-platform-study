/**
 * GlobalSettingDtoMapper Unit Tests
 *
 * Tests for the GlobalSettingDtoMapper that handles DTO transformations.
 *
 * Testing Strategy:
 * - We mock AutoClassMapper to simulate the actual mapping behavior
 * - Tests verify the mapper produces correct output structure
 * - Complete mock entities prevent Anti-Pattern #4 (Incomplete Mocks)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GlobalSettingDtoMapper } from '../globalSetting.dto.mapper';
import { GlobalSettingResponse, PaginatedGlobalSettingResponse } from '../dto';
import { FetchResponse } from '../../../common';
import { ValueType } from '@arcaai/domains';

// Define ResourceStatus locally to avoid mock issues
const ResourceStatus = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
} as const;

// Mock AutoClassMapper to simulate real mapping behavior
// This is necessary because AutoClassMapper uses reflection which doesn't work in tests
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        AutoClassMapper: vi.fn((source, TargetClass) => {
            // Simulate AutoClassMapper behavior for GlobalSettingResponse
            return new GlobalSettingResponse({
                id: source.id,
                name: source.name,
                description: source.description,
                key: source.key,
                value: source.value,
                dataType: source.dataType,
                namespace: source.namespace,
                createdAt: source.createdAt ?? new Date(),
                updatedAt: source.updatedAt ?? new Date(),
            });
        }),
    };
});

/**
 * Creates a complete mock GlobalSettingEntity matching the real entity structure.
 * Includes all fields to prevent incomplete mock anti-pattern.
 * Uses 'in' operator to properly handle explicit null values in overrides.
 */
const createMockGlobalSettingEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    key: string;
    value: string;
    dataType: ValueType;
    namespace: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    resourceStatus: typeof ResourceStatus[keyof typeof ResourceStatus];
    deletedAt: Date | null;
    deletedBy: string | null;
}> = {}) => ({
    id: 'id' in overrides ? overrides.id! : 'setting-id-1',
    tenantId: 'tenantId' in overrides ? overrides.tenantId! : 'tenant-1',
    name: 'name' in overrides ? overrides.name! : 'Test Setting',
    description: 'description' in overrides ? overrides.description : 'A test setting description',
    key: 'key' in overrides ? overrides.key! : 'test.setting.key',
    value: 'value' in overrides ? overrides.value! : 'test-value',
    dataType: 'dataType' in overrides ? overrides.dataType! : ValueType.String,
    namespace: 'namespace' in overrides ? overrides.namespace : 'test',
    createdBy: 'createdBy' in overrides ? overrides.createdBy : 'user-123',
    createdAt: 'createdAt' in overrides ? overrides.createdAt! : new Date('2026-01-30T10:00:00Z'),
    updatedAt: 'updatedAt' in overrides ? overrides.updatedAt! : new Date('2026-01-30T10:00:00Z'),
    resourceStatus: 'resourceStatus' in overrides ? overrides.resourceStatus! : ResourceStatus.ENABLED,
    deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : null,
    deletedBy: 'deletedBy' in overrides ? overrides.deletedBy : null,
});

describe('GlobalSettingDtoMapper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('ToResponse', () => {
        it('should map GlobalSettingEntity to GlobalSettingResponse', () => {
            const entity = createMockGlobalSettingEntity();

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result).toBeInstanceOf(GlobalSettingResponse);
            expect(result.id).toBe('setting-id-1');
            expect(result.name).toBe('Test Setting');
            expect(result.key).toBe('test.setting.key');
            expect(result.value).toBe('test-value');
            expect(result.dataType).toBe(ValueType.String);
        });

        it('should map description field', () => {
            const entity = createMockGlobalSettingEntity({
                description: 'Custom description for the setting',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.description).toBe('Custom description for the setting');
        });

        it('should map namespace field', () => {
            const entity = createMockGlobalSettingEntity({
                namespace: 'custom.namespace',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.namespace).toBe('custom.namespace');
        });

        it('should handle null description', () => {
            const entity = createMockGlobalSettingEntity({
                description: null,
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.description).toBeNull();
        });

        it('should handle null namespace', () => {
            const entity = createMockGlobalSettingEntity({
                namespace: null,
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.namespace).toBeNull();
        });

        it('should handle different data types', () => {
            const dataTypes = [ValueType.String, ValueType.Integer, ValueType.Boolean];

            for (const dataType of dataTypes) {
                const entity = createMockGlobalSettingEntity({ dataType });
                const result = GlobalSettingDtoMapper.ToResponse(entity as any);
                expect(result.dataType).toBe(dataType);
            }
        });

        it('should handle String value type', () => {
            const entity = createMockGlobalSettingEntity({
                dataType: ValueType.String,
                value: 'string-value',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.dataType).toBe(ValueType.String);
            expect(result.value).toBe('string-value');
        });

        it('should handle Integer value type', () => {
            const entity = createMockGlobalSettingEntity({
                dataType: ValueType.Integer,
                value: '42',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.dataType).toBe(ValueType.Integer);
            expect(result.value).toBe('42');
        });

        it('should handle Boolean value type', () => {
            const entity = createMockGlobalSettingEntity({
                dataType: ValueType.Boolean,
                value: 'true',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.dataType).toBe(ValueType.Boolean);
            expect(result.value).toBe('true');
        });

        it('should handle JSON value as string', () => {
            const entity = createMockGlobalSettingEntity({
                value: JSON.stringify({ key: 'value', nested: { data: true } }),
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.value).toBe('{"key":"value","nested":{"data":true}}');
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map FetchResponse to PaginatedGlobalSettingResponse', () => {
            const entities = [
                createMockGlobalSettingEntity({ id: 'setting-1' }),
                createMockGlobalSettingEntity({ id: 'setting-2' }),
            ];
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 2,
                limit: 10,
                page: 1,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedGlobalSettingResponse);
            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should map each entity to response', () => {
            const entities = [
                createMockGlobalSettingEntity({ id: 'setting-1', name: 'Setting One' }),
                createMockGlobalSettingEntity({ id: 'setting-2', name: 'Setting Two' }),
                createMockGlobalSettingEntity({ id: 'setting-3', name: 'Setting Three' }),
            ];
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].id).toBe('setting-1');
            expect(result.data[0].name).toBe('Setting One');
            expect(result.data[1].id).toBe('setting-2');
            expect(result.data[1].name).toBe('Setting Two');
            expect(result.data[2].id).toBe('setting-3');
            expect(result.data[2].name).toBe('Setting Three');
        });

        it('should handle empty data array', () => {
            const fetchResponse = new FetchResponse({
                data: [],
                count: 0,
                limit: 10,
                page: 1,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should preserve pagination metadata', () => {
            const fetchResponse = new FetchResponse({
                data: [createMockGlobalSettingEntity()] as any,
                count: 100,
                limit: 20,
                page: 5,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(100);
            expect(result.limit).toBe(20);
            expect(result.page).toBe(5);
        });

        it('should handle large data sets', () => {
            const entities = Array.from({ length: 100 }, (_, i) =>
                createMockGlobalSettingEntity({ id: `setting-${i}`, key: `setting.key.${i}` })
            );
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 1000,
                limit: 100,
                page: 1,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(100);
            expect(result.count).toBe(1000);
        });

        it('should handle different pages', () => {
            const entities = [createMockGlobalSettingEntity({ id: 'setting-1' })];
            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 50,
                limit: 10,
                page: 3,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.page).toBe(3);
            expect(result.limit).toBe(10);
            expect(result.count).toBe(50);
        });
    });

    describe('Edge Cases', () => {
        it('should handle entity with special characters in name', () => {
            const entity = createMockGlobalSettingEntity({
                name: "Setting with special chars: <>&\"'",
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.name).toBe("Setting with special chars: <>&\"'");
        });

        it('should handle entity with unicode characters', () => {
            const entity = createMockGlobalSettingEntity({
                name: '設定 설정 إعداد',
                description: 'Unicode description: 日本語 한국어',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.name).toBe('設定 설정 إعداد');
            expect(result.description).toBe('Unicode description: 日本語 한국어');
        });

        it('should handle entity with very long value', () => {
            const longValue = 'a'.repeat(10000);
            const entity = createMockGlobalSettingEntity({
                value: longValue,
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.value).toBe(longValue);
            expect(result.value.length).toBe(10000);
        });

        it('should handle entity with empty string values', () => {
            const entity = createMockGlobalSettingEntity({
                name: '',
                description: '',
                key: '',
                value: '',
                namespace: '',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.name).toBe('');
            expect(result.description).toBe('');
            expect(result.key).toBe('');
            expect(result.value).toBe('');
            expect(result.namespace).toBe('');
        });

        it('should handle entity with dot-notation key', () => {
            const entity = createMockGlobalSettingEntity({
                key: 'app.feature.module.setting.name',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.key).toBe('app.feature.module.setting.name');
        });

        it('should handle entity with namespace containing dots', () => {
            const entity = createMockGlobalSettingEntity({
                namespace: 'com.example.app.settings',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result.namespace).toBe('com.example.app.settings');
        });
    });

    describe('Response Type Verification', () => {
        it('should return GlobalSettingResponse instance with correct prototype', () => {
            const entity = createMockGlobalSettingEntity();

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(result).toBeInstanceOf(GlobalSettingResponse);
            expect(Object.getPrototypeOf(result).constructor.name).toBe('GlobalSettingResponse');
        });

        it('should return PaginatedGlobalSettingResponse instance with correct prototype', () => {
            const fetchResponse = new FetchResponse({
                data: [createMockGlobalSettingEntity()] as any,
                count: 1,
                limit: 10,
                page: 1,
            });

            const result = GlobalSettingDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedGlobalSettingResponse);
            expect(Object.getPrototypeOf(result).constructor.name).toBe('PaginatedGlobalSettingResponse');
        });

        it('should produce serializable JSON output', () => {
            const entity = createMockGlobalSettingEntity({
                id: 'test-id',
                name: 'Test',
                value: 'test-value',
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);
            const json = JSON.stringify(result);
            const parsed = JSON.parse(json);

            expect(parsed.id).toBe('test-id');
            expect(parsed.name).toBe('Test');
            expect(parsed.value).toBe('test-value');
        });
    });

    describe('Data Integrity', () => {
        it('should not mutate the source entity', () => {
            const entity = createMockGlobalSettingEntity({
                name: 'Original Name',
                value: 'Original Value',
            });
            const originalName = entity.name;
            const originalValue = entity.value;

            GlobalSettingDtoMapper.ToResponse(entity as any);

            expect(entity.name).toBe(originalName);
            expect(entity.value).toBe(originalValue);
        });

        it('should preserve date precision in mapping', () => {
            const preciseDate = new Date('2026-01-30T10:30:45.123Z');
            const entity = createMockGlobalSettingEntity({
                createdAt: preciseDate,
                updatedAt: preciseDate,
            });

            const result = GlobalSettingDtoMapper.ToResponse(entity as any);

            // Verify dates are preserved (may be Date or ISO string depending on serialization)
            expect(new Date(result.createdAt).getTime()).toBe(preciseDate.getTime());
            expect(new Date(result.updatedAt).getTime()).toBe(preciseDate.getTime());
        });
    });
});
