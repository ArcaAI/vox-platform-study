/**
 * UserMediaDtoMapper Unit Tests
 *
 * Tests for the UserMediaDtoMapper that transforms user media entities to response DTOs.
 *
 * Testing Strategy:
 * - Use complete mock entities matching real entity structure
 * - Test all field mappings including timestamps
 * - Test edge cases and boundary conditions
 * - Verify mapper handles null values correctly
 */

import { describe, it, expect } from 'vitest';
import { UserMediaDtoMapper } from '../userMedia.dto.mapper';
import { FetchResponse } from '../../../../common';

/**
 * Helper to create mock user media entity with complete structure.
 * Uses default values that can be overridden for specific test cases.
 * Note: Uses 'in' operator to properly handle null values as explicit overrides.
 */
const createMockUserMediaEntity = (
    overrides: Partial<{
        id: string;
        userId: string;
        mediaId: string;
        sharedAt: Date | null;
        createdBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }> = {}
) => ({
    id: 'id' in overrides ? overrides.id : 'user-media-id-1',
    userId: 'userId' in overrides ? overrides.userId : 'user-123',
    mediaId: 'mediaId' in overrides ? overrides.mediaId : 'media-456',
    sharedAt: 'sharedAt' in overrides ? overrides.sharedAt : new Date('2026-01-29T12:00:00Z'),
    createdBy: 'createdBy' in overrides ? overrides.createdBy : 'creator-123',
    createdAt: 'createdAt' in overrides ? overrides.createdAt : new Date('2026-01-29T10:00:00Z'),
    updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : new Date('2026-01-29T10:30:00Z'),
    deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : null,
});

describe('UserMediaDtoMapper', () => {
    describe('ToResponse', () => {
        it('should map basic user media entity to response', () => {
            const entity = createMockUserMediaEntity();

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.id).toBe('user-media-id-1');
            expect(result.userId).toBe('user-123');
            expect(result.mediaId).toBe('media-456');
        });

        it('should map userId correctly', () => {
            const entity = createMockUserMediaEntity({ userId: 'custom-user-789' });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.userId).toBe('custom-user-789');
        });

        it('should map mediaId correctly', () => {
            const entity = createMockUserMediaEntity({ mediaId: 'custom-media-abc' });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.mediaId).toBe('custom-media-abc');
        });

        it('should map sharedAt when present', () => {
            const sharedDate = new Date('2026-02-15T14:30:00Z');
            const entity = createMockUserMediaEntity({ sharedAt: sharedDate });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.sharedAt).toEqual(sharedDate);
        });

        it('should handle null sharedAt', () => {
            const entity = createMockUserMediaEntity({ sharedAt: null });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            // AutoClassMapper preserves null values
            expect(result.sharedAt).toBeNull();
        });

        it('should handle entity with all fields populated', () => {
            const sharedDate = new Date('2026-03-01T09:00:00Z');
            const entity = createMockUserMediaEntity({
                id: 'um-123',
                userId: 'user-abc',
                mediaId: 'media-xyz',
                sharedAt: sharedDate,
            });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.id).toBe('um-123');
            expect(result.userId).toBe('user-abc');
            expect(result.mediaId).toBe('media-xyz');
            expect(result.sharedAt).toEqual(sharedDate);
        });

        it('should handle different user IDs', () => {
            const userIds = ['user-1', 'user-2', 'admin-user', 'service-account'];

            userIds.forEach((userId) => {
                const entity = createMockUserMediaEntity({ userId });
                const result = UserMediaDtoMapper.ToResponse(entity as any);
                expect(result.userId).toBe(userId);
            });
        });

        it('should handle different media IDs', () => {
            const mediaIds = ['media-1', 'media-2', 'doc-123', 'img-456'];

            mediaIds.forEach((mediaId) => {
                const entity = createMockUserMediaEntity({ mediaId });
                const result = UserMediaDtoMapper.ToResponse(entity as any);
                expect(result.mediaId).toBe(mediaId);
            });
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map paginated user media correctly', () => {
            const entities = [
                createMockUserMediaEntity({ id: 'um-1', userId: 'user-1' }),
                createMockUserMediaEntity({ id: 'um-2', userId: 'user-2' }),
                createMockUserMediaEntity({ id: 'um-3', userId: 'user-3' }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(3);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(result.data[0].id).toBe('um-1');
            expect(result.data[1].id).toBe('um-2');
            expect(result.data[2].id).toBe('um-3');
        });

        it('should handle empty data array', () => {
            const fetchResponse = new FetchResponse({
                data: [] as any[],
                count: 0,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should preserve pagination metadata', () => {
            const entities = [createMockUserMediaEntity({ id: 'um-1' })];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 100,
                limit: 25,
                page: 4,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(100);
            expect(result.limit).toBe(25);
            expect(result.page).toBe(4);
        });

        it('should map each entity in the data array', () => {
            const entities = [
                createMockUserMediaEntity({
                    id: 'um-1',
                    userId: 'user-a',
                    mediaId: 'media-1',
                }),
                createMockUserMediaEntity({
                    id: 'um-2',
                    userId: 'user-b',
                    mediaId: 'media-2',
                }),
                createMockUserMediaEntity({
                    id: 'um-3',
                    userId: 'user-c',
                    mediaId: 'media-3',
                }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].userId).toBe('user-a');
            expect(result.data[0].mediaId).toBe('media-1');
            expect(result.data[1].userId).toBe('user-b');
            expect(result.data[1].mediaId).toBe('media-2');
            expect(result.data[2].userId).toBe('user-c');
            expect(result.data[2].mediaId).toBe('media-3');
        });

        it('should handle large page numbers', () => {
            const entities = [createMockUserMediaEntity({ id: 'um-1' })];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 1000,
                limit: 10,
                page: 100,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.page).toBe(100);
            expect(result.count).toBe(1000);
        });

        it('should handle mixed sharedAt values in paginated results', () => {
            const entities = [
                createMockUserMediaEntity({
                    id: 'um-1',
                    sharedAt: new Date('2026-01-01T10:00:00Z'),
                }),
                createMockUserMediaEntity({ id: 'um-2', sharedAt: null }),
                createMockUserMediaEntity({
                    id: 'um-3',
                    sharedAt: new Date('2026-03-15T15:30:00Z'),
                }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].sharedAt).toEqual(new Date('2026-01-01T10:00:00Z'));
            // AutoClassMapper preserves null values
            expect(result.data[1].sharedAt).toBeNull();
            expect(result.data[2].sharedAt).toEqual(new Date('2026-03-15T15:30:00Z'));
        });
    });

    describe('ToResponse - timestamp handling', () => {
        it('should map createdAt correctly', () => {
            const createdAt = new Date('2026-01-15T08:30:00Z');
            const entity = createMockUserMediaEntity({ createdAt });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            // Result may be Date or string depending on mapper implementation
            expect(new Date(result.createdAt).toISOString()).toBe(createdAt.toISOString());
        });

        it('should map updatedAt correctly', () => {
            const updatedAt = new Date('2026-01-20T14:45:00Z');
            const entity = createMockUserMediaEntity({ updatedAt });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(new Date(result.updatedAt).toISOString()).toBe(updatedAt.toISOString());
        });

        it('should handle different timezone dates', () => {
            const utcDate = new Date('2026-06-15T12:00:00Z');
            const entity = createMockUserMediaEntity({
                createdAt: utcDate,
                updatedAt: utcDate,
                sharedAt: utcDate,
            });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(new Date(result.createdAt).toISOString()).toBe('2026-06-15T12:00:00.000Z');
            expect(new Date(result.sharedAt!).toISOString()).toBe('2026-06-15T12:00:00.000Z');
        });

        it('should handle dates at epoch boundaries', () => {
            const epochStart = new Date(0);
            const entity = createMockUserMediaEntity({
                createdAt: epochStart,
                sharedAt: epochStart,
            });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(new Date(result.createdAt).toISOString()).toBe(epochStart.toISOString());
            expect(new Date(result.sharedAt!).toISOString()).toBe(epochStart.toISOString());
        });
    });

    describe('ToResponse - edge cases', () => {
        it('should handle null createdBy', () => {
            const entity = createMockUserMediaEntity({ createdBy: null });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.createdBy).toBeNull();
        });

        it('should handle createdBy with value', () => {
            const entity = createMockUserMediaEntity({ createdBy: 'system-user-123' });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.createdBy).toBe('system-user-123');
        });

        it('should handle UUID format IDs', () => {
            const entity = createMockUserMediaEntity({
                id: '01912345-6789-7abc-def0-123456789abc',
                userId: '01987654-3210-7fed-cba9-876543210fed',
                mediaId: '01abcdef-0123-7456-789a-bcdef0123456',
            });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.id).toBe('01912345-6789-7abc-def0-123456789abc');
            expect(result.userId).toBe('01987654-3210-7fed-cba9-876543210fed');
            expect(result.mediaId).toBe('01abcdef-0123-7456-789a-bcdef0123456');
        });

        it('should handle future sharedAt date', () => {
            const futureDate = new Date('2030-12-31T23:59:59Z');
            const entity = createMockUserMediaEntity({ sharedAt: futureDate });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.sharedAt).toEqual(futureDate);
        });

        it('should handle very old sharedAt date', () => {
            const oldDate = new Date('2000-01-01T00:00:00Z');
            const entity = createMockUserMediaEntity({ sharedAt: oldDate });

            const result = UserMediaDtoMapper.ToResponse(entity as any);

            expect(result.sharedAt).toEqual(oldDate);
        });
    });

    describe('ToPaginatedResponse - edge cases', () => {
        it('should handle single item in data array', () => {
            const entities = [createMockUserMediaEntity({ id: 'single-um' })];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 1,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(1);
            expect(result.data[0].id).toBe('single-um');
        });

        it('should preserve order of entities in paginated response', () => {
            const entities = [
                createMockUserMediaEntity({ id: 'first' }),
                createMockUserMediaEntity({ id: 'second' }),
                createMockUserMediaEntity({ id: 'third' }),
                createMockUserMediaEntity({ id: 'fourth' }),
                createMockUserMediaEntity({ id: 'fifth' }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 5,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data.map((d) => d.id)).toEqual([
                'first',
                'second',
                'third',
                'fourth',
                'fifth',
            ]);
        });

        it('should handle mixed user and media IDs in paginated results', () => {
            const entities = [
                createMockUserMediaEntity({
                    id: 'um-1',
                    userId: 'user-a',
                    mediaId: 'media-x',
                }),
                createMockUserMediaEntity({
                    id: 'um-2',
                    userId: 'user-b',
                    mediaId: 'media-y',
                }),
                createMockUserMediaEntity({
                    id: 'um-3',
                    userId: 'user-a',
                    mediaId: 'media-z',
                }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].userId).toBe('user-a');
            expect(result.data[0].mediaId).toBe('media-x');
            expect(result.data[1].userId).toBe('user-b');
            expect(result.data[1].mediaId).toBe('media-y');
            expect(result.data[2].userId).toBe('user-a');
            expect(result.data[2].mediaId).toBe('media-z');
        });

        it('should handle mixed null and non-null createdBy in paginated results', () => {
            const entities = [
                createMockUserMediaEntity({ id: 'um-1', createdBy: 'creator-1' }),
                createMockUserMediaEntity({ id: 'um-2', createdBy: null }),
                createMockUserMediaEntity({ id: 'um-3', createdBy: 'creator-2' }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any[],
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = UserMediaDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].createdBy).toBe('creator-1');
            expect(result.data[1].createdBy).toBeNull();
            expect(result.data[2].createdBy).toBe('creator-2');
        });
    });
});
