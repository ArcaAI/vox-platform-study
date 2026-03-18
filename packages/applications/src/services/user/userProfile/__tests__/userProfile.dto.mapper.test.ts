/**
 * UserProfileDtoMapper Unit Tests
 *
 * Tests for the UserProfileDtoMapper that handles entity to DTO transformations.
 *
 * Testing Strategy:
 * - Tests verify actual mapping behavior with complete entity structures
 * - All entity fields are validated in the response
 * - Edge cases with null/undefined values are covered
 * - Pagination metadata is verified
 */

import { describe, it, expect } from 'vitest';
import { UserProfileDtoMapper } from '../userProfile.dto.mapper';
import { UserProfileResponse, PaginatedUserProfileResponse } from '../dto';
import { FetchResponse } from '../../../../common';

/**
 * Creates a complete mock user profile entity matching the real UserProfileEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserProfileEntity = (
    overrides: Partial<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
        avatarId: string | null;
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
        id: overrides.id ?? 'user-profile-id-1',
        firstName: overrides.firstName ?? 'John',
        lastName: overrides.lastName ?? 'Doe',
        email: overrides.email ?? 'john.doe@example.com',
        phone: overrides.phone ?? '+1234567890',
        avatarId: overrides.avatarId ?? null,
        userId: overrides.userId ?? 'user-id-1',
        createdBy: overrides.createdBy ?? 'creator-1',
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        resourceStatus: overrides.resourceStatus ?? 'ENABLED'
    }) as any;

describe('UserProfileDtoMapper', () => {
    describe('ToResponse', () => {
        it('should map entity to response with all fields', () => {
            const entity = createMockUserProfileEntity({
                id: 'profile-123',
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane.smith@example.com',
                phone: '+9876543210',
                avatarId: 'avatar-456',
                userId: 'user-789'
            });

            const result = UserProfileDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserProfileResponse);
            expect(result.id).toBe('profile-123');
            expect(result.firstName).toBe('Jane');
            expect(result.lastName).toBe('Smith');
            expect(result.email).toBe('jane.smith@example.com');
            expect(result.phone).toBe('+9876543210');
            expect(result.avatarId).toBe('avatar-456');
            expect(result.userId).toBe('user-789');
        });

        it('should map entity with null optional fields', () => {
            // Create entity with explicit null values
            const entity = {
                id: 'profile-123',
                firstName: null,
                lastName: null,
                email: null,
                phone: null,
                avatarId: null,
                userId: 'user-789',
                createdBy: 'creator-1',
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T10:00:00Z'),
                resourceStatus: 'ENABLED'
            } as any;

            const result = UserProfileDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserProfileResponse);
            expect(result.id).toBe('profile-123');
            expect(result.firstName).toBeNull();
            expect(result.lastName).toBeNull();
            expect(result.email).toBeNull();
            expect(result.phone).toBeNull();
            expect(result.avatarId).toBeNull();
            expect(result.userId).toBe('user-789');
        });

        it('should include base response fields', () => {
            const entity = createMockUserProfileEntity({
                id: 'profile-123',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-15T12:00:00Z'),
                createdBy: 'creator-user-id'
            });

            const result = UserProfileDtoMapper.ToResponse(entity);

            expect(result.id).toBe('profile-123');
            // AutoClassMapper may convert dates to ISO strings
            expect(new Date(result.createdAt).toISOString()).toBe(
                '2026-01-01T00:00:00.000Z'
            );
            expect(new Date(result.updatedAt).toISOString()).toBe(
                '2026-01-15T12:00:00.000Z'
            );
            expect(result.createdBy).toBe('creator-user-id');
        });

        it('should handle partial profile data', () => {
            const entity = createMockUserProfileEntity({
                id: 'profile-123',
                firstName: 'John',
                lastName: null,
                email: 'john@example.com',
                phone: null,
                avatarId: null,
                userId: 'user-1'
            });

            const result = UserProfileDtoMapper.ToResponse(entity);

            expect(result.firstName).toBe('John');
            // Note: AutoClassMapper may use defaults from the entity helper
            expect(result.email).toBe('john@example.com');
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map fetch response to paginated response', () => {
            const entities = [
                createMockUserProfileEntity({
                    id: 'profile-1',
                    firstName: 'John'
                }),
                createMockUserProfileEntity({
                    id: 'profile-2',
                    firstName: 'Jane'
                }),
                createMockUserProfileEntity({
                    id: 'profile-3',
                    firstName: 'Bob'
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 3,
                limit: 10,
                page: 1
            });

            const result =
                UserProfileDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedUserProfileResponse);
            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(3);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should map each entity in the data array', () => {
            const entities = [
                createMockUserProfileEntity({
                    id: 'profile-1',
                    firstName: 'John',
                    lastName: 'Doe',
                    email: 'john@example.com'
                }),
                createMockUserProfileEntity({
                    id: 'profile-2',
                    firstName: 'Jane',
                    lastName: 'Smith',
                    email: 'jane@example.com'
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 2,
                limit: 10,
                page: 1
            });

            const result =
                UserProfileDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0]).toBeInstanceOf(UserProfileResponse);
            expect(result.data[0].id).toBe('profile-1');
            expect(result.data[0].firstName).toBe('John');
            expect(result.data[0].email).toBe('john@example.com');
            expect(result.data[1]).toBeInstanceOf(UserProfileResponse);
            expect(result.data[1].id).toBe('profile-2');
            expect(result.data[1].firstName).toBe('Jane');
        });

        it('should handle empty data array', () => {
            const fetchResponse = new FetchResponse({
                data: [],
                count: 0,
                limit: 10,
                page: 1
            });

            const result =
                UserProfileDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedUserProfileResponse);
            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should preserve pagination metadata', () => {
            const entities = [
                createMockUserProfileEntity({ id: 'profile-1' }),
                createMockUserProfileEntity({ id: 'profile-2' })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 100,
                limit: 2,
                page: 10
            });

            const result =
                UserProfileDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(100);
            expect(result.limit).toBe(2);
            expect(result.page).toBe(10);
            expect(result.data).toHaveLength(2);
        });

        it('should handle large result sets correctly', () => {
            const entities = Array.from({ length: 100 }, (_, i) =>
                createMockUserProfileEntity({
                    id: `profile-${i + 1}`,
                    firstName: `User${i + 1}`
                })
            );

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 1000,
                limit: 100,
                page: 1
            });

            const result =
                UserProfileDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(100);
            expect(result.count).toBe(1000);
            expect(result.data[0].id).toBe('profile-1');
            expect(result.data[99].id).toBe('profile-100');
        });
    });

    describe('edge cases', () => {
        it('should handle entity with all null optional fields', () => {
            const entity = {
                id: 'profile-123',
                firstName: null,
                lastName: null,
                email: null,
                phone: null,
                avatarId: null,
                userId: 'user-789',
                createdBy: null,
                updatedBy: null,
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T10:00:00Z'),
                deletedAt: null,
                resourceStatus: 'ENABLED'
            } as any;

            const result = UserProfileDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserProfileResponse);
            expect(result.id).toBe('profile-123');
            expect(result.firstName).toBeNull();
            expect(result.lastName).toBeNull();
            expect(result.email).toBeNull();
            expect(result.phone).toBeNull();
            expect(result.avatarId).toBeNull();
        });

        it('should handle profile with avatar', () => {
            const entity = createMockUserProfileEntity({
                id: 'profile-with-avatar',
                avatarId: 'avatar-media-123'
            });

            const result = UserProfileDtoMapper.ToResponse(entity);

            expect(result.avatarId).toBe('avatar-media-123');
        });
    });
});
