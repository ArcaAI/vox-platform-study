/**
 * AuthService Unit Tests
 *
 * Tests for the AuthService that handles authentication operations.
 *
 * Testing Strategy:
 * - Tests verify actual authentication behavior and output data
 * - Mock entities include complete user structure with all relations
 * - Event emission is verified with complete payload structure
 * - Error handling tests verify proper exception propagation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from '../auth.service';
import { EventTypes } from '@arcaai/domains';

// Define ResourceStatus locally to avoid mock issues
const ResourceStatus = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
} as const;

// Mock UserService (dependency boundary)
const mockUserService = {
    fetchByExternalId: vi.fn(),
    createExternalUser: vi.fn(),
    fetchById: vi.fn(),
};

// Mock EventEmitter (dependency boundary)
const mockEventEmitter = {
    emit: vi.fn(),
};

/**
 * Creates a complete mock UserEntity matching the real entity structure.
 * Includes all relations to prevent incomplete mock anti-pattern.
 */
const createMockUserEntity = (overrides: Partial<{
    id: string;
    externalId: string;
    username: string;
    isDeleted: boolean;
    lastLoginAt: Date;
    createdAt: Date;
    updatedAt: Date;
    resourceStatus: typeof ResourceStatus[keyof typeof ResourceStatus];
    tenantId: string;
    departmentId: string | null;
    UserProfile: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        phone?: string;
    } | null;
    UserRoleAssignments: Array<{ Role: { id: string; name: string } }>;
}> = {}) => {
    // Use 'in' operator to properly handle explicit null values
    const entity = {
        id: 'id' in overrides ? overrides.id! : 'user-id-1',
        externalId: 'externalId' in overrides ? overrides.externalId! : 'external-123',
        username: 'username' in overrides ? overrides.username! : 'testuser',
        isDeleted: 'isDeleted' in overrides ? overrides.isDeleted! : false,
        lastLoginAt: 'lastLoginAt' in overrides ? overrides.lastLoginAt! : new Date('2026-01-30T10:00:00Z'),
        createdAt: 'createdAt' in overrides ? overrides.createdAt! : new Date('2026-01-01T00:00:00Z'),
        updatedAt: 'updatedAt' in overrides ? overrides.updatedAt! : new Date('2026-01-30T10:00:00Z'),
        resourceStatus: 'resourceStatus' in overrides ? overrides.resourceStatus! : ResourceStatus.ENABLED,
        tenantId: 'tenantId' in overrides ? overrides.tenantId! : 'tenant-1',
        departmentId: 'departmentId' in overrides ? overrides.departmentId : null,
        UserProfile: 'UserProfile' in overrides ? overrides.UserProfile : {
            id: 'profile-1',
            email: 'test@example.com',
            firstName: 'Test',
            lastName: 'User',
            phone: null,
        },
        UserRoleAssignments: 'UserRoleAssignments' in overrides ? overrides.UserRoleAssignments! : [
            { Role: { id: 'role-1', name: 'user' } },
        ],
        toObject: vi.fn(),
    };

    entity.toObject.mockReturnValue({
        id: entity.id,
        externalId: entity.externalId,
        username: entity.username,
        isDeleted: entity.isDeleted,
        lastLoginAt: entity.lastLoginAt,
        resourceStatus: entity.resourceStatus,
    });

    return entity;
};

// Mock AutoClassMapper
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        AutoClassMapper: vi.fn((entity, ResponseClass, customMappings = {}) => {
            // Simple mapping for tests
            return {
                id: entity.id,
                firstName: entity.UserProfile?.firstName ?? null,
                lastName: entity.UserProfile?.lastName ?? null,
                email: entity.UserProfile?.email ?? '',
                phone: null,
                roles: entity.UserRoleAssignments?.map((r: any) => r.Role.name) ?? [],
                token: null,
            };
        }),
    };
});

describe('AuthService', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create service instance with mocks
        service = new AuthService(
            mockUserService as any,
            mockEventEmitter as any,
        );
    });

    describe('getOrCreateOidcUser', () => {
        const createOAuthUserRequest = {
            externalId: 'external-123',
            email: 'test@example.com',
            firstName: 'Test',
            lastName: 'User',
            provider: 'oidc',
        };

        it('should return existing user when found by external ID', async () => {
            const existingUser = createMockUserEntity({ externalId: 'external-123' });
            mockUserService.fetchByExternalId.mockResolvedValue(existingUser);

            const result = await service.getOrCreateOidcUser(createOAuthUserRequest);

            expect(result).toBeDefined();
            expect(result.email).toBe('test@example.com');
            expect(mockUserService.fetchByExternalId).toHaveBeenCalledWith('external-123');
            expect(mockUserService.createExternalUser).not.toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: existingUser.id,
                    method: 'oidc',
                })
            );
        });

        it('should create new user when not found by external ID', async () => {
            const newUser = createMockUserEntity({ id: 'new-user-id' });
            mockUserService.fetchByExternalId.mockRejectedValue(new Error('Not found'));
            mockUserService.createExternalUser.mockResolvedValue(newUser);

            const result = await service.getOrCreateOidcUser(createOAuthUserRequest);

            expect(result).toBeDefined();
            expect(mockUserService.createExternalUser).toHaveBeenCalledWith(createOAuthUserRequest);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: 'new-user-id',
                    method: 'oidc',
                })
            );
        });

        it('should create new user when fetchByExternalId returns null', async () => {
            const newUser = createMockUserEntity({ id: 'new-user-id' });
            mockUserService.fetchByExternalId.mockResolvedValue(null);
            mockUserService.createExternalUser.mockResolvedValue(newUser);

            const result = await service.getOrCreateOidcUser(createOAuthUserRequest);

            expect(result).toBeDefined();
            expect(mockUserService.createExternalUser).toHaveBeenCalledWith(createOAuthUserRequest);
        });

        it('should throw InternalServerErrorException when user creation fails', async () => {
            mockUserService.fetchByExternalId.mockResolvedValue(null);
            mockUserService.createExternalUser.mockResolvedValue(null);

            await expect(service.getOrCreateOidcUser(createOAuthUserRequest))
                .rejects.toThrow('Failed to create user');
        });

        it('should emit UserAuthenticated event with userId after successful authentication', async () => {
            const user = createMockUserEntity();
            mockUserService.fetchByExternalId.mockResolvedValue(user);

            await service.getOrCreateOidcUser(createOAuthUserRequest);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: user.id,
                    method: 'oidc',
                })
            );
        });

        it('should map user entity to OAuthUserResponse', async () => {
            const user = createMockUserEntity({
                UserProfile: {
                    email: 'mapped@example.com',
                    firstName: 'Mapped',
                    lastName: 'User',
                },
                UserRoleAssignments: [
                    { Role: { name: 'admin' } },
                    { Role: { name: 'user' } },
                ],
            });
            mockUserService.fetchByExternalId.mockResolvedValue(user);

            const result = await service.getOrCreateOidcUser(createOAuthUserRequest);

            expect(result.email).toBe('mapped@example.com');
            expect(result.firstName).toBe('Mapped');
            expect(result.lastName).toBe('User');
            expect(result.roles).toContain('admin');
            expect(result.roles).toContain('user');
        });
    });

    describe('isTokenRevoked', () => {
        it('should return false for any token (current implementation)', async () => {
            const result = await service.isTokenRevoked('token-id-123');

            expect(result).toBe(false);
        });

        it('should return false for empty token ID', async () => {
            const result = await service.isTokenRevoked('');

            expect(result).toBe(false);
        });

        it('should return false for various token formats', async () => {
            const tokenIds = [
                'uuid-format-token',
                'jwt-id-claim',
                '12345',
                'token_with_underscores',
            ];

            for (const tokenId of tokenIds) {
                const result = await service.isTokenRevoked(tokenId);
                expect(result).toBe(false);
            }
        });
    });

    describe('validateUser', () => {
        it('should return user validation response for valid user', async () => {
            const user = createMockUserEntity({
                id: 'user-123',
                isDeleted: false,
                lastLoginAt: new Date('2026-01-30T10:00:00Z'),
                UserProfile: {
                    email: 'valid@example.com',
                    firstName: 'Valid',
                    lastName: 'User',
                },
            });
            mockUserService.fetchById.mockResolvedValue(user);

            const result = await service.validateUser('user-123');

            expect(result).toEqual({
                id: 'user-123',
                email: 'valid@example.com',
                isActive: true,
                departmentId: undefined,
                lastLoginAt: new Date('2026-01-30T10:00:00Z'),
            });
        });

        it('should return null when user not found', async () => {
            mockUserService.fetchById.mockResolvedValue(null);

            const result = await service.validateUser('non-existent-user');

            expect(result).toBeNull();
        });

        it('should return null when fetchById throws error', async () => {
            mockUserService.fetchById.mockRejectedValue(new Error('Database error'));

            const result = await service.validateUser('user-123');

            expect(result).toBeNull();
        });

        it('should return isActive false for deleted user', async () => {
            const deletedUser = createMockUserEntity({
                id: 'deleted-user',
                isDeleted: true,
            });
            mockUserService.fetchById.mockResolvedValue(deletedUser);

            const result = await service.validateUser('deleted-user');

            expect(result).toEqual(expect.objectContaining({
                isActive: false,
            }));
        });

        it('should return empty email when UserProfile email is missing', async () => {
            const userWithoutEmail = createMockUserEntity({
                id: 'user-no-email',
                UserProfile: {
                    email: '',
                    firstName: 'Test',
                    lastName: 'User',
                },
            });
            mockUserService.fetchById.mockResolvedValue(userWithoutEmail);

            const result = await service.validateUser('user-no-email');

            expect(result).toEqual(expect.objectContaining({
                email: '',
            }));
        });

        it('should return undefined lastLoginAt when not set', async () => {
            const userWithoutLastLogin = {
                ...createMockUserEntity({ id: 'user-123' }),
                lastLoginAt: undefined,
            };
            mockUserService.fetchById.mockResolvedValue(userWithoutLastLogin);

            const result = await service.validateUser('user-123');

            expect(result?.lastLoginAt).toBeUndefined();
        });
    });

    describe('trackAuthentication', () => {
        const trackingData = {
            ip: '192.168.1.1',
            userAgent: 'Mozilla/5.0',
            endpoint: '/api/auth/login',
            method: 'POST',
        };

        it('should emit UserAuthenticated event with tracking data', async () => {
            await service.trackAuthentication('user-123', trackingData);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: 'user-123',
                    ip: '192.168.1.1',
                    userAgent: 'Mozilla/5.0',
                    endpoint: '/api/auth/login',
                    method: 'POST',
                    timestamp: expect.any(Date),
                })
            );
        });

        it('should include timestamp in event data', async () => {
            const beforeTime = new Date();

            await service.trackAuthentication('user-123', trackingData);

            const emitCall = mockEventEmitter.emit.mock.calls[0];
            const eventData = emitCall[1];
            expect(eventData.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
        });

        it('should handle empty tracking data fields', async () => {
            const emptyTrackingData = {
                ip: '',
                userAgent: '',
                endpoint: '',
                method: '',
            };

            await service.trackAuthentication('user-123', emptyTrackingData);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: 'user-123',
                    ip: '',
                    userAgent: '',
                })
            );
        });

        it('should throw when event emitter fails (synchronous emit)', async () => {
            mockEventEmitter.emit.mockImplementation(() => {
                throw new Error('Event emitter error');
            });

            // The emit is synchronous, so it will throw
            await expect(service.trackAuthentication('user-123', trackingData))
                .rejects.toThrow('Event emitter error');
        });
    });

    describe('Error Handling', () => {
        it('should handle fetchByExternalId errors gracefully in getOrCreateOidcUser', async () => {
            // Reset mocks for this test
            vi.clearAllMocks();
            mockEventEmitter.emit.mockReturnValue(true);

            const newUser = createMockUserEntity();
            mockUserService.fetchByExternalId.mockRejectedValue(new Error('Network error'));
            mockUserService.createExternalUser.mockResolvedValue(newUser);

            const result = await service.getOrCreateOidcUser({
                externalId: 'ext-123',
                email: 'test@example.com',
            } as any);

            // Should create new user when fetch fails
            expect(result).toBeDefined();
            expect(mockUserService.createExternalUser).toHaveBeenCalled();
        });

        it('should propagate errors when both fetch and create fail', async () => {
            mockUserService.fetchByExternalId.mockRejectedValue(new Error('Fetch failed'));
            mockUserService.createExternalUser.mockResolvedValue(null);

            await expect(
                service.getOrCreateOidcUser({
                    externalId: 'ext-123',
                    email: 'test@example.com',
                } as any)
            ).rejects.toThrow('Failed to create user');
        });
    });

    describe('Authentication Flow', () => {
        it('should prefer existing user over creating new one', async () => {
            const existingUser = createMockUserEntity({
                id: 'existing-user',
                externalId: 'ext-123',
            });
            mockUserService.fetchByExternalId.mockResolvedValue(existingUser);

            await service.getOrCreateOidcUser({
                externalId: 'ext-123',
                email: 'test@example.com',
            } as any);

            // Should NOT call createExternalUser when user exists
            expect(mockUserService.createExternalUser).not.toHaveBeenCalled();
        });

        it('should emit authentication event with userId for audit trail', async () => {
            const user = createMockUserEntity({
                id: 'user-123',
                UserProfile: {
                    id: 'profile-1',
                    email: 'auth@example.com',
                    firstName: 'Auth',
                    lastName: 'User',
                },
            });
            mockUserService.fetchByExternalId.mockResolvedValue(user);

            await service.getOrCreateOidcUser({
                externalId: 'ext-123',
                email: 'auth@example.com',
            } as any);

            // Verify event contains explicit userId for reliable audit log creation
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: 'user-123',
                    method: 'oidc',
                })
            );
        });
    });

    describe('User Validation', () => {
        it('should return complete validation response for active user', async () => {
            const lastLogin = new Date('2026-01-30T10:00:00Z');
            const user = createMockUserEntity({
                id: 'user-123',
                isDeleted: false,
                lastLoginAt: lastLogin,
                departmentId: 'dept-1',
                UserProfile: {
                    id: 'profile-1',
                    email: 'valid@example.com',
                    firstName: 'Valid',
                    lastName: 'User',
                },
            });
            mockUserService.fetchById.mockResolvedValue(user);

            const result = await service.validateUser('user-123');

            expect(result).toEqual({
                id: 'user-123',
                email: 'valid@example.com',
                isActive: true,
                departmentId: undefined, // Based on current implementation
                lastLoginAt: lastLogin,
            });
        });

        it('should return isActive false for soft-deleted user', async () => {
            const user = createMockUserEntity({
                id: 'deleted-user',
                isDeleted: true,
            });
            mockUserService.fetchById.mockResolvedValue(user);

            const result = await service.validateUser('deleted-user');

            expect(result?.isActive).toBe(false);
        });

        it('should handle user without profile gracefully', async () => {
            const user = createMockUserEntity({
                id: 'no-profile-user',
                UserProfile: null,
            });
            mockUserService.fetchById.mockResolvedValue(user);

            const result = await service.validateUser('no-profile-user');

            expect(result?.email).toBe('');
        });
    });

    describe('Token Revocation', () => {
        it('should return false for valid tokens (current implementation)', async () => {
            // Current implementation always returns false
            // This test documents the expected behavior
            const result = await service.isTokenRevoked('valid-token-id');
            expect(result).toBe(false);
        });

        it('should handle various token ID formats', async () => {
            const tokenFormats = [
                'uuid-v4-format-token-id',
                'jwt-jti-claim-value',
                '12345678',
                'token_with_special-chars.123',
            ];

            for (const tokenId of tokenFormats) {
                const result = await service.isTokenRevoked(tokenId);
                expect(result).toBe(false);
            }
        });
    });

    describe('Authentication Tracking', () => {
        it('should emit tracking event with all metadata', async () => {
            const trackingData = {
                ip: '192.168.1.100',
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                endpoint: '/api/v1/auth/login',
                method: 'POST',
            };

            await service.trackAuthentication('user-123', trackingData);

            const emitCall = mockEventEmitter.emit.mock.calls[0];
            expect(emitCall[0]).toBe(EventTypes.UserAuthenticated);
            expect(emitCall[1]).toMatchObject({
                userId: 'user-123',
                ip: '192.168.1.100',
                userAgent: expect.stringContaining('Mozilla'),
                endpoint: '/api/v1/auth/login',
                method: 'POST',
                timestamp: expect.any(Date),
            });
        });

        it('should include accurate timestamp in tracking event', async () => {
            const beforeTime = Date.now();

            await service.trackAuthentication('user-123', {
                ip: '127.0.0.1',
                userAgent: 'test',
                endpoint: '/test',
                method: 'GET',
            });

            const afterTime = Date.now();
            const emitCall = mockEventEmitter.emit.mock.calls[0];
            const eventTimestamp = emitCall[1].timestamp.getTime();

            expect(eventTimestamp).toBeGreaterThanOrEqual(beforeTime);
            expect(eventTimestamp).toBeLessThanOrEqual(afterTime);
        });
    });
});
