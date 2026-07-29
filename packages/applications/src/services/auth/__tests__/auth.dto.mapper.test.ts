/**
 * AuthDtoMapper Unit Tests
 *
 * Tests for the AuthDtoMapper that handles DTO transformations.
 *
 * Testing Strategy:
 * - We mock AutoClassMapper to simulate the actual mapping behavior
 * - Tests verify the mapper produces correct output structure
 * - Complete mock entities prevent Anti-Pattern #4 (Incomplete Mocks)
 * - Tests verify both successful mappings and edge cases
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthDtoMapper } from '../auth.dto.mapper';
import { OAuthUserResponse, CheckAuthResponse, UserSession } from '../dto';

// Mock AutoClassMapper to simulate real mapping behavior
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    AutoClassMapper: vi.fn((source, TargetClass, customMappings = {}) => {
      // Simulate AutoClassMapper behavior for OAuthUserResponse
      if (TargetClass === OAuthUserResponse) {
        return new OAuthUserResponse({
          id: source.id,
          firstName: source.UserProfile?.firstName ?? null,
          lastName: source.UserProfile?.lastName ?? null,
          email: source.UserProfile?.email ?? '',
          phone: source.UserProfile?.phone ?? null,
          roles: source.UserRoleAssignments?.map((r: any) => r.Role?.name).filter(Boolean) ?? [],
          token: null,
          createdAt: source.createdAt ?? new Date(),
          updatedAt: source.updatedAt ?? new Date(),
        });
      }
      // Simulate AutoClassMapper behavior for CheckAuthResponse
      if (TargetClass === CheckAuthResponse) {
        return new CheckAuthResponse({
          id: source.id,
          firstName: source.firstName ?? '',
          lastName: source.lastName ?? '',
          emailAddress: source.email ?? '',
          phoneNumber: source.phone ?? null,
          token: source.token ?? null,
        });
      }
      return source;
    }),
  };
});

// Helper to create mock user entity
const createMockUserEntity = (
  overrides: Partial<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    UserProfile: {
      email: string;
      firstName: string;
      lastName: string;
      phone?: string;
    } | null;
    UserRoleAssignments: Array<{ Role: { name: string } }>;
  }> = {},
) => ({
  id: overrides.id ?? 'user-id-1',
  createdAt: overrides.createdAt ?? new Date('2026-01-30T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-30T10:00:00Z'),
  UserProfile: overrides.UserProfile ?? {
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    phone: '+1234567890',
  },
  UserRoleAssignments: overrides.UserRoleAssignments ?? [{ Role: { name: 'user' } }],
});

// Helper to create mock user session
const createMockUserSession = (overrides: Partial<UserSession> = {}): UserSession => ({
  id: 'id' in overrides ? overrides.id! : 'session-id-1',
  firstName: 'firstName' in overrides ? overrides.firstName : 'Test',
  lastName: 'lastName' in overrides ? overrides.lastName : 'User',
  email: 'email' in overrides ? overrides.email! : 'test@example.com',
  phone: 'phone' in overrides ? overrides.phone : '+1234567890',
  tenantId: 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
  tenantCode: 'tenantCode' in overrides ? overrides.tenantCode : 'TENANT1',
  token: 'token' in overrides ? overrides.token : 'jwt-token',
  roles: 'roles' in overrides ? overrides.roles : ['user'],
  permissions: 'permissions' in overrides ? overrides.permissions : ['read:users'],
});

describe('AuthDtoMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ToResponse', () => {
    it('should map UserEntity to OAuthUserResponse', () => {
      const entity = createMockUserEntity();

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result).toBeInstanceOf(OAuthUserResponse);
      expect(result.id).toBe('user-id-1');
      expect(result.email).toBe('test@example.com');
      expect(result.firstName).toBe('Test');
      expect(result.lastName).toBe('User');
    });

    it('should map roles from UserRoleAssignments', () => {
      const entity = createMockUserEntity({
        UserRoleAssignments: [{ Role: { name: 'admin' } }, { Role: { name: 'user' } }, { Role: { name: 'moderator' } }],
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.roles).toContain('admin');
      expect(result.roles).toContain('user');
      expect(result.roles).toContain('moderator');
      expect(result.roles).toHaveLength(3);
    });

    it('should handle null UserProfile', () => {
      const entity = {
        ...createMockUserEntity(),
        UserProfile: null,
      };

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.firstName).toBeNull();
      expect(result.lastName).toBeNull();
      expect(result.email).toBe('');
    });

    it('should handle empty roles', () => {
      const entity = createMockUserEntity({
        UserRoleAssignments: [],
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.roles).toEqual([]);
    });

    it('should handle undefined UserRoleAssignments', () => {
      const entity = {
        id: 'user-id-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        UserProfile: {
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
        },
        UserRoleAssignments: undefined,
      };

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.roles).toEqual([]);
    });

    it('should set token to null', () => {
      const entity = createMockUserEntity();

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.token).toBeNull();
    });

    it('should handle phone number from UserProfile', () => {
      const entity = createMockUserEntity({
        UserProfile: {
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          phone: '+1987654321',
        },
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.phone).toBe('+1987654321');
    });

    it('should handle missing phone in UserProfile', () => {
      const entity = createMockUserEntity({
        UserProfile: {
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
        },
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.phone).toBeNull();
    });
  });

  describe('ToCheckAuthResponse', () => {
    it('should map UserSession to CheckAuthResponse', () => {
      const session = createMockUserSession();

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result).toBeInstanceOf(CheckAuthResponse);
      expect(result.id).toBe('session-id-1');
      expect(result.firstName).toBe('Test');
      expect(result.lastName).toBe('User');
      expect(result.emailAddress).toBe('test@example.com');
    });

    it('should map phone number', () => {
      const session = createMockUserSession({
        phone: '+1555123456',
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.phoneNumber).toBe('+1555123456');
    });

    it('should map token', () => {
      const session = createMockUserSession({
        token: 'my-jwt-token',
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.token).toBe('my-jwt-token');
    });

    it('should handle null phone', () => {
      const session = createMockUserSession({
        phone: null,
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.phoneNumber).toBeNull();
    });

    it('should handle null token', () => {
      const session = createMockUserSession({
        token: null,
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.token).toBeNull();
    });

    it('should handle undefined optional fields', () => {
      const session: UserSession = {
        id: 'session-1',
        email: 'test@example.com',
        firstName: undefined,
        lastName: undefined,
        phone: undefined,
        token: undefined,
        tenantId: undefined,
        tenantCode: undefined,
        roles: undefined,
        permissions: undefined,
      };

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.id).toBe('session-1');
      expect(result.firstName).toBe('');
      expect(result.lastName).toBe('');
    });

    it('should handle empty string values', () => {
      const session = createMockUserSession({
        firstName: '',
        lastName: '',
        email: '',
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.firstName).toBe('');
      expect(result.lastName).toBe('');
      expect(result.emailAddress).toBe('');
    });
  });

  describe('Edge Cases', () => {
    it('should handle entity with special characters in names', () => {
      const entity = createMockUserEntity({
        UserProfile: {
          email: 'test@example.com',
          firstName: "O'Brien",
          lastName: 'Van der Berg',
        },
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.firstName).toBe("O'Brien");
      expect(result.lastName).toBe('Van der Berg');
    });

    it('should handle entity with unicode names', () => {
      const entity = createMockUserEntity({
        UserProfile: {
          email: 'test@example.com',
          firstName: '田中',
          lastName: '太郎',
        },
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.firstName).toBe('田中');
      expect(result.lastName).toBe('太郎');
    });

    it('should handle session with unicode values', () => {
      const session = createMockUserSession({
        firstName: 'Müller',
        lastName: 'Schröder',
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result.firstName).toBe('Müller');
      expect(result.lastName).toBe('Schröder');
    });

    it('should handle very long role lists', () => {
      const roles = Array.from({ length: 100 }, (_, i) => ({ Role: { name: `role-${i}` } }));

      const entity = createMockUserEntity({
        UserRoleAssignments: roles,
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.roles).toHaveLength(100);
    });
  });

  describe('Response Type Verification', () => {
    it('should return OAuthUserResponse instance with correct prototype', () => {
      const entity = createMockUserEntity();

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result).toBeInstanceOf(OAuthUserResponse);
      expect(Object.getPrototypeOf(result).constructor.name).toBe('OAuthUserResponse');
    });

    it('should return CheckAuthResponse instance with correct prototype', () => {
      const session = createMockUserSession();

      const result = AuthDtoMapper.ToCheckAuthResponse(session);

      expect(result).toBeInstanceOf(CheckAuthResponse);
      expect(Object.getPrototypeOf(result).constructor.name).toBe('CheckAuthResponse');
    });

    it('should produce serializable JSON output for OAuthUserResponse', () => {
      const entity = createMockUserEntity({
        id: 'user-123',
        UserProfile: {
          email: 'json@example.com',
          firstName: 'JSON',
          lastName: 'Test',
        },
      });

      const result = AuthDtoMapper.ToResponse(entity as any);
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe('user-123');
      expect(parsed.email).toBe('json@example.com');
      expect(parsed.firstName).toBe('JSON');
    });

    it('should produce serializable JSON output for CheckAuthResponse', () => {
      const session = createMockUserSession({
        id: 'session-123',
        email: 'session@example.com',
      });

      const result = AuthDtoMapper.ToCheckAuthResponse(session);
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe('session-123');
      expect(parsed.emailAddress).toBe('session@example.com');
    });
  });

  describe('Data Integrity', () => {
    it('should not mutate the source user entity', () => {
      const entity = createMockUserEntity({
        UserProfile: {
          email: 'original@example.com',
          firstName: 'Original',
          lastName: 'Name',
        },
      });
      const originalEmail = entity.UserProfile!.email;

      AuthDtoMapper.ToResponse(entity as any);

      expect(entity.UserProfile!.email).toBe(originalEmail);
    });

    it('should not mutate the source user session', () => {
      const session = createMockUserSession({
        email: 'original@example.com',
        firstName: 'Original',
      });
      const originalEmail = session.email;

      AuthDtoMapper.ToCheckAuthResponse(session);

      expect(session.email).toBe(originalEmail);
    });

    it('should preserve date precision in OAuthUserResponse', () => {
      const preciseDate = new Date('2026-01-30T10:30:45.123Z');
      const entity = createMockUserEntity({
        createdAt: preciseDate,
        updatedAt: preciseDate,
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      // Verify dates are preserved (may be Date or ISO string depending on serialization)
      expect(new Date(result.createdAt).getTime()).toBe(preciseDate.getTime());
      expect(new Date(result.updatedAt).getTime()).toBe(preciseDate.getTime());
    });
  });

  describe('Role and Group Mapping', () => {
    it('should filter out null or undefined role names', () => {
      const entity = createMockUserEntity({
        UserRoleAssignments: [
          { Role: { name: 'admin' } },
          { Role: { name: null as any } },
          { Role: { name: 'user' } },
          { Role: { name: undefined as any } },
        ],
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.roles).toEqual(['admin', 'user']);
      expect(result.roles).toHaveLength(2);
    });

    it('should handle roles with special characters', () => {
      const entity = createMockUserEntity({
        UserRoleAssignments: [{ Role: { name: 'super-admin' } }, { Role: { name: 'read:users' } }, { Role: { name: 'write:all' } }],
      });

      const result = AuthDtoMapper.ToResponse(entity as any);

      expect(result.roles).toContain('super-admin');
      expect(result.roles).toContain('read:users');
      expect(result.roles).toContain('write:all');
    });
  });
});
