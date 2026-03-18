/**
 * UserSettingsDtoMapper Unit Tests
 *
 * Tests for the UserSettingsDtoMapper that handles entity to DTO transformations.
 *
 * Testing Strategy:
 * - Tests verify actual mapping behavior with complete entity structures
 * - All entity fields are validated in the response
 * - Edge cases with null/undefined values are covered
 * - Pagination metadata is verified
 */

import { describe, it, expect } from 'vitest';
import { UserSettingsDtoMapper } from '../userSettings.dto.mapper';
import { UserSettingsResponse, PaginatedUserSettingsResponse } from '../dto';
import { FetchResponse } from '../../../../common';
import { ValueType } from '@arcaai/domains';

/**
 * Creates a complete mock user settings entity matching the real UserSettingsEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserSettingsEntity = (
    overrides: Partial<{
        id: string;
        name: string;
        key: string;
        value: string;
        dataType: ValueType;
        namespace: string | null;
        userId: string;
        createdBy: string | null;
        updatedBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        resourceStatus: string;
    }> = {}
) =>
    ({
        id: overrides.id ?? 'user-settings-id-1',
        name: overrides.name ?? 'Test Setting',
        key: overrides.key ?? 'test_key',
        value: overrides.value ?? 'test_value',
        dataType: overrides.dataType ?? ValueType.String,
        namespace: overrides.namespace ?? null,
        userId: overrides.userId ?? 'user-id-1',
        createdBy: overrides.createdBy ?? 'creator-1',
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        resourceStatus: overrides.resourceStatus ?? 'ENABLED'
    }) as any;

describe('UserSettingsDtoMapper', () => {
    describe('ToResponse', () => {
        it('should map entity to response with all fields', () => {
            const entity = createMockUserSettingsEntity({
                id: 'setting-123',
                name: 'Language Setting',
                key: 'language',
                value: 'en',
                dataType: ValueType.String,
                namespace: 'arcaai-sdk',
                userId: 'user-789'
            });

            const result = UserSettingsDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserSettingsResponse);
            expect(result.id).toBe('setting-123');
            expect(result.name).toBe('Language Setting');
            expect(result.key).toBe('language');
            expect(result.value).toBe('en');
            expect(result.dataType).toBe(ValueType.String);
            expect(result.namespace).toBe('arcaai-sdk');
            expect(result.userId).toBe('user-789');
        });

        it('should map entity with null namespace', () => {
            const entity = createMockUserSettingsEntity({
                id: 'setting-123',
                name: 'Global Setting',
                key: 'global_key',
                value: 'global_value',
                namespace: null
            });

            const result = UserSettingsDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserSettingsResponse);
            expect(result.id).toBe('setting-123');
            expect(result.namespace).toBeNull();
        });

        it('should include base response fields', () => {
            const entity = createMockUserSettingsEntity({
                id: 'setting-123',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-15T12:00:00Z'),
                createdBy: 'creator-user-id'
            });

            const result = UserSettingsDtoMapper.ToResponse(entity);

            expect(result.id).toBe('setting-123');
            // AutoClassMapper may convert dates to ISO strings
            expect(new Date(result.createdAt).toISOString()).toBe(
                '2026-01-01T00:00:00.000Z'
            );
            expect(new Date(result.updatedAt).toISOString()).toBe(
                '2026-01-15T12:00:00.000Z'
            );
            expect(result.createdBy).toBe('creator-user-id');
        });

        it('should handle different data types', () => {
            // Create entity with explicit Int dataType
            const intEntity = {
                id: 'int-setting',
                name: 'Test Setting',
                key: 'max_count',
                value: '100',
                dataType: 'Int',
                namespace: null,
                userId: 'user-id-1',
                createdBy: 'creator-1',
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T10:00:00Z'),
                resourceStatus: 'ENABLED'
            } as any;

            const result = UserSettingsDtoMapper.ToResponse(intEntity);

            expect(result.dataType).toBe('Int');
            expect(result.value).toBe('100');
        });

        it('should handle JSON data type', () => {
            const jsonEntity = createMockUserSettingsEntity({
                id: 'json-setting',
                key: 'custom',
                value: '{"theme":"dark"}',
                dataType: ValueType.Json
            });

            const result = UserSettingsDtoMapper.ToResponse(jsonEntity);

            // ValueType.Json is the string 'Json'
            expect(result.dataType).toBe('Json');
            expect(result.value).toBe('{"theme":"dark"}');
        });

        it('should handle Float data type', () => {
            const floatEntity = createMockUserSettingsEntity({
                id: 'float-setting',
                key: 'sensitivity',
                value: '0.75',
                dataType: ValueType.Float
            });

            const result = UserSettingsDtoMapper.ToResponse(floatEntity);

            // ValueType.Float is the string 'Float'
            expect(result.dataType).toBe('Float');
            expect(result.value).toBe('0.75');
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map fetch response to paginated response', () => {
            const entities = [
                createMockUserSettingsEntity({
                    id: 'setting-1',
                    key: 'language'
                }),
                createMockUserSettingsEntity({
                    id: 'setting-2',
                    key: 'theme'
                }),
                createMockUserSettingsEntity({
                    id: 'setting-3',
                    key: 'notifications'
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 3,
                limit: 10,
                page: 1
            });

            const result =
                UserSettingsDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedUserSettingsResponse);
            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(3);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should map each entity in the data array', () => {
            const entities = [
                createMockUserSettingsEntity({
                    id: 'setting-1',
                    name: 'Language',
                    key: 'language',
                    value: 'en'
                }),
                createMockUserSettingsEntity({
                    id: 'setting-2',
                    name: 'Theme',
                    key: 'theme',
                    value: 'dark'
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 2,
                limit: 10,
                page: 1
            });

            const result =
                UserSettingsDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0]).toBeInstanceOf(UserSettingsResponse);
            expect(result.data[0].id).toBe('setting-1');
            expect(result.data[0].key).toBe('language');
            expect(result.data[0].value).toBe('en');
            expect(result.data[1]).toBeInstanceOf(UserSettingsResponse);
            expect(result.data[1].id).toBe('setting-2');
            expect(result.data[1].key).toBe('theme');
        });

        it('should handle empty data array', () => {
            const fetchResponse = new FetchResponse({
                data: [],
                count: 0,
                limit: 10,
                page: 1
            });

            const result =
                UserSettingsDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedUserSettingsResponse);
            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should preserve pagination metadata', () => {
            const entities = [
                createMockUserSettingsEntity({ id: 'setting-1' }),
                createMockUserSettingsEntity({ id: 'setting-2' })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 200,
                limit: 2,
                page: 15
            });

            const result =
                UserSettingsDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(200);
            expect(result.limit).toBe(2);
            expect(result.page).toBe(15);
            expect(result.data).toHaveLength(2);
        });

        it('should handle settings with different namespaces', () => {
            const entities = [
                createMockUserSettingsEntity({
                    id: 'setting-1',
                    namespace: 'arcaai-sdk'
                }),
                createMockUserSettingsEntity({
                    id: 'setting-2',
                    namespace: 'custom-app'
                }),
                createMockUserSettingsEntity({
                    id: 'setting-3',
                    namespace: null
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 3,
                limit: 10,
                page: 1
            });

            const result =
                UserSettingsDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].namespace).toBe('arcaai-sdk');
            expect(result.data[1].namespace).toBe('custom-app');
            expect(result.data[2].namespace).toBeNull();
        });

        it('should handle large result sets correctly', () => {
            const entities = Array.from({ length: 100 }, (_, i) =>
                createMockUserSettingsEntity({
                    id: `setting-${i + 1}`,
                    key: `key_${i + 1}`
                })
            );

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 1000,
                limit: 100,
                page: 1
            });

            const result =
                UserSettingsDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(100);
            expect(result.count).toBe(1000);
            expect(result.data[0].id).toBe('setting-1');
            expect(result.data[99].id).toBe('setting-100');
        });
    });

    describe('edge cases', () => {
        it('should handle entity with all null optional fields', () => {
            const entity = {
                id: 'setting-123',
                name: 'Test Setting',
                key: 'test_key',
                value: 'test_value',
                dataType: ValueType.String,
                namespace: null,
                userId: 'user-789',
                createdBy: null,
                updatedBy: null,
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T10:00:00Z'),
                deletedAt: null,
                resourceStatus: 'ENABLED'
            } as any;

            const result = UserSettingsDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserSettingsResponse);
            expect(result.id).toBe('setting-123');
            expect(result.namespace).toBeNull();
        });

        it('should handle Boolean data type', () => {
            const entity = createMockUserSettingsEntity({
                id: 'bool-setting',
                key: 'enabled',
                value: 'true',
                dataType: ValueType.Boolean
            });

            const result = UserSettingsDtoMapper.ToResponse(entity);

            expect(result.dataType).toBe('Boolean');
            expect(result.value).toBe('true');
        });

        it('should handle Int data type', () => {
            // Create entity with explicit Int dataType using direct object
            const entity = {
                id: 'int-setting',
                name: 'Count Setting',
                key: 'count',
                value: '42',
                dataType: 'Int',
                namespace: null,
                userId: 'user-id-1',
                createdBy: 'creator-1',
                updatedBy: null,
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T10:00:00Z'),
                deletedAt: null,
                resourceStatus: 'ENABLED'
            } as any;

            const result = UserSettingsDtoMapper.ToResponse(entity);

            expect(result.dataType).toBe('Int');
            expect(result.value).toBe('42');
        });
    });
});
