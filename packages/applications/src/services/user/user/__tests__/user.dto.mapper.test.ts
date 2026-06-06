/**
 * UserDtoMapper Unit Tests
 *
 * Tests for the UserDtoMapper that handles entity to DTO transformations.
 *
 * Testing Strategy:
 * - Tests verify actual mapping behavior with complete entity structures
 * - All entity fields are validated in the response
 * - Edge cases with null/undefined values are covered
 * - Pagination metadata is verified
 */

import { describe, it, expect } from 'vitest';
import { UserDtoMapper } from '../user.dto.mapper';
import { UserResponse, PaginatedUserResponse } from '../dto';
import { FetchResponse } from '../../../../common';

/**
 * Creates a complete mock user entity matching the real UserEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserEntity = (
    overrides: Partial<{
        id: string;
        username: string;
        password: string;
        externalId: string | null;
        isServiceAccount: boolean;
        lastLoginAt: Date | null;
        lastActiveAt: Date | null;
        secret1: string | null;
        secret1Expiry: Date | null;
        secret2: string | null;
        secret2Expiry: Date | null;
        createdBy: string | null;
        updatedBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        resourceStatus: string;
    }> = {}
) =>
    ({
        id: overrides.id ?? 'user-id-1',
        username: overrides.username ?? 'testuser',
        password: overrides.password ?? 'hashedpassword',
        externalId: overrides.externalId ?? null,
        isServiceAccount: overrides.isServiceAccount ?? false,
        lastLoginAt: overrides.lastLoginAt ?? null,
        lastActiveAt: overrides.lastActiveAt ?? null,
        secret1: overrides.secret1 ?? null,
        secret1Expiry: overrides.secret1Expiry ?? null,
        secret2: overrides.secret2 ?? null,
        secret2Expiry: overrides.secret2Expiry ?? null,
        createdBy: overrides.createdBy ?? 'creator-1',
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        resourceStatus: overrides.resourceStatus ?? 'ENABLED'
    }) as any;

describe('UserDtoMapper', () => {
    describe('ToResponse', () => {
        it('should map entity to response with all fields', () => {
            const entity = createMockUserEntity({
                id: 'user-123',
                username: 'admin',
                externalId: 'ext-456',
                isServiceAccount: false,
                lastLoginAt: new Date('2026-01-28T15:00:00Z'),
                lastActiveAt: new Date('2026-01-28T16:00:00Z')
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserResponse);
            expect(result.id).toBe('user-123');
            expect(result.username).toBe('admin');
            expect(result.externalId).toBe('ext-456');
            expect(result.isServiceAccount).toBe(false);
            expect(result.lastLoginAt).toEqual(
                new Date('2026-01-28T15:00:00Z')
            );
            expect(result.lastActiveAt).toEqual(
                new Date('2026-01-28T16:00:00Z')
            );
        });

        it('should map entity with null optional fields', () => {
            const entity = createMockUserEntity({
                id: 'user-123',
                username: 'basicuser',
                externalId: null,
                lastLoginAt: null,
                lastActiveAt: null,
                secret1: null,
                secret2: null
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserResponse);
            expect(result.id).toBe('user-123');
            expect(result.username).toBe('basicuser');
            expect(result.externalId).toBeNull();
            expect(result.lastLoginAt).toBeNull();
            expect(result.lastActiveAt).toBeNull();
        });

        it('should include base response fields', () => {
            const entity = createMockUserEntity({
                id: 'user-123',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-15T12:00:00Z'),
                createdBy: 'creator-user-id'
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result.id).toBe('user-123');
            // AutoClassMapper may convert dates to ISO strings
            expect(new Date(result.createdAt).toISOString()).toBe(
                '2026-01-01T00:00:00.000Z'
            );
            expect(new Date(result.updatedAt).toISOString()).toBe(
                '2026-01-15T12:00:00.000Z'
            );
            expect(result.createdBy).toBe('creator-user-id');
        });

        it('should map service account correctly', () => {
            const entity = createMockUserEntity({
                id: 'service-user-123',
                username: 'api-service',
                isServiceAccount: true,
                secret1: 'secret-key-1',
                secret1Expiry: new Date('2027-01-01T00:00:00Z')
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result.isServiceAccount).toBe(true);
        });

        // AC-05 (TASK-336) — the user secret material (secret1/secret2 and their
        // expiries) is sensitive and MUST NOT be serialised onto UserResponse,
        // even for service accounts whose entity carries it.
        it('should NOT expose secret fields on the response', () => {
            const entity = createMockUserEntity({
                id: 'service-user-123',
                username: 'api-service',
                isServiceAccount: true,
                secret1: 'secret-key-1',
                secret1Expiry: new Date('2027-01-01T00:00:00Z'),
                secret2: 'secret-key-2',
                secret2Expiry: new Date('2027-06-01T00:00:00Z')
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect('secret1' in result).toBe(false);
            expect('secret1Expiry' in result).toBe(false);
            expect('secret2' in result).toBe(false);
            expect('secret2Expiry' in result).toBe(false);
        });

        it('should map external user correctly', () => {
            const entity = createMockUserEntity({
                id: 'external-user-123',
                username: 'oauth-user',
                externalId: 'google-oauth-123456'
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result.externalId).toBe('google-oauth-123456');
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map fetch response to paginated response', () => {
            const entities = [
                createMockUserEntity({ id: 'user-1', username: 'user1' }),
                createMockUserEntity({ id: 'user-2', username: 'user2' }),
                createMockUserEntity({ id: 'user-3', username: 'user3' })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 3,
                limit: 10,
                page: 1
            });

            const result = UserDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedUserResponse);
            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(3);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should map each entity in the data array', () => {
            const entities = [
                createMockUserEntity({
                    id: 'user-1',
                    username: 'admin',
                    isServiceAccount: false
                }),
                createMockUserEntity({
                    id: 'user-2',
                    username: 'api-service',
                    isServiceAccount: true
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 2,
                limit: 10,
                page: 1
            });

            const result = UserDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0]).toBeInstanceOf(UserResponse);
            expect(result.data[0].id).toBe('user-1');
            expect(result.data[0].username).toBe('admin');
            expect(result.data[0].isServiceAccount).toBe(false);
            expect(result.data[1]).toBeInstanceOf(UserResponse);
            expect(result.data[1].id).toBe('user-2');
            expect(result.data[1].username).toBe('api-service');
            expect(result.data[1].isServiceAccount).toBe(true);
        });

        it('should handle empty data array', () => {
            const fetchResponse = new FetchResponse({
                data: [],
                count: 0,
                limit: 10,
                page: 1
            });

            const result = UserDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedUserResponse);
            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should preserve pagination metadata', () => {
            const entities = [
                createMockUserEntity({ id: 'user-1' }),
                createMockUserEntity({ id: 'user-2' })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 500,
                limit: 2,
                page: 25
            });

            const result = UserDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(500);
            expect(result.limit).toBe(2);
            expect(result.page).toBe(25);
            expect(result.data).toHaveLength(2);
        });

        it('should handle mix of regular and service accounts', () => {
            const entities = [
                createMockUserEntity({
                    id: 'user-1',
                    username: 'regular-user',
                    isServiceAccount: false
                }),
                createMockUserEntity({
                    id: 'user-2',
                    username: 'service-account',
                    isServiceAccount: true,
                    secret1: 'api-key'
                }),
                createMockUserEntity({
                    id: 'user-3',
                    username: 'external-user',
                    externalId: 'oauth-123'
                })
            ];

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 3,
                limit: 10,
                page: 1
            });

            const result = UserDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data[0].isServiceAccount).toBe(false);
            expect(result.data[1].isServiceAccount).toBe(true);
            expect('secret1' in result.data[1]).toBe(false);
            expect(result.data[2].externalId).toBe('oauth-123');
        });

        it('should handle large result sets correctly', () => {
            const entities = Array.from({ length: 100 }, (_, i) =>
                createMockUserEntity({
                    id: `user-${i + 1}`,
                    username: `user${i + 1}`
                })
            );

            const fetchResponse = new FetchResponse({
                data: entities,
                count: 1000,
                limit: 100,
                page: 1
            });

            const result = UserDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(100);
            expect(result.count).toBe(1000);
            expect(result.data[0].id).toBe('user-1');
            expect(result.data[99].id).toBe('user-100');
        });
    });

    describe('edge cases', () => {
        it('should handle entity with all null optional fields', () => {
            const entity = createMockUserEntity({
                id: 'user-123',
                username: 'minimaluser',
                externalId: null,
                lastLoginAt: null,
                lastActiveAt: null,
                secret1: null,
                secret1Expiry: null,
                secret2: null,
                secret2Expiry: null,
                createdBy: null,
                updatedBy: null,
                deletedAt: null
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result).toBeInstanceOf(UserResponse);
            expect(result.id).toBe('user-123');
            expect(result.externalId).toBeNull();
            expect(result.lastLoginAt).toBeNull();
            expect(result.lastActiveAt).toBeNull();
        });

        it('should omit secret fields even when the entity has both secrets set', () => {
            const entity = createMockUserEntity({
                id: 'service-user',
                isServiceAccount: true,
                secret1: 'primary-api-key',
                secret1Expiry: new Date('2027-01-01T00:00:00Z'),
                secret2: 'secondary-api-key',
                secret2Expiry: new Date('2027-06-01T00:00:00Z')
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect('secret1' in result).toBe(false);
            expect('secret1Expiry' in result).toBe(false);
            expect('secret2' in result).toBe(false);
            expect('secret2Expiry' in result).toBe(false);
        });

        it('should handle entity with recent activity timestamps', () => {
            const lastLogin = new Date('2026-01-30T08:00:00Z');
            const lastActive = new Date('2026-01-30T09:30:00Z');

            const entity = createMockUserEntity({
                id: 'active-user',
                lastLoginAt: lastLogin,
                lastActiveAt: lastActive
            });

            const result = UserDtoMapper.ToResponse(entity);

            expect(result.lastLoginAt).toEqual(lastLogin);
            expect(result.lastActiveAt).toEqual(lastActive);
        });
    });
});
