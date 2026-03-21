/**
 * AuthorizedBaseService Unit Tests
 *
 * Tests for the abstract base service that provides authorization utilities.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuthorizedBaseService } from '../authorized-base.service';
import { PolicyEngine, AppAbility } from '../../authorization';
import { IActiveUserContext } from '../../interfaces';

// Mock CASL ability
const createMockAbility = (permissions: Record<string, boolean>): AppAbility => ({
  can: vi.fn((action: string, subject: string) => {
    const key = `${action}:${subject}`;
    return permissions[key] ?? false;
  }),
  cannot: vi.fn((action: string, subject: string) => {
    const key = `${action}:${subject}`;
    return !(permissions[key] ?? false);
  }),
  relevantRuleFor: vi.fn((action: string, subject: string) => {
    // Return mock rule with fields if specified
    const fieldsKey = `fields:${action}:${subject}`;
    if (permissions[fieldsKey]) {
      return { fields: permissions[fieldsKey] };
    }
    return null;
  }),
  rules: [],
} as unknown as AppAbility);

// Concrete implementation for testing
class TestAuthorizedService extends AuthorizedBaseService {
  constructor(
    cls: ClsService<IActiveUserContext>,
    policyEngine: PolicyEngine,
  ) {
    super(cls, policyEngine);
  }

  // Expose protected methods for testing
  public testGetAbility() {
    return this.getAbility();
  }

  public testGetCurrentUser() {
    return this.getCurrentUser();
  }

  public testGetCurrentTenantId() {
    return this.getCurrentTenantId();
  }

  public testGetAccessibleFilter<T extends string>(action: string, subject: T) {
    return this.getAccessibleFilter(action, subject);
  }

  public testCanAccess(action: string, subject: string) {
    return this.canAccess(action, subject);
  }

  public testCanAccessResource(action: string, subject: string, resource: Record<string, unknown>) {
    return this.canAccessResource(action, subject, resource);
  }

  public testAssertCanAccess(action: string, subject: string) {
    return this.assertCanAccess(action, subject);
  }

  public testAssertCanAccessResource(action: string, subject: string, resource: Record<string, unknown>) {
    return this.assertCanAccessResource(action, subject, resource);
  }

  public testGetPermittedFields(action: string, subject: string) {
    return this.getPermittedFields(action, subject);
  }

  public testFilterFields<T extends Record<string, unknown>>(data: T, action: string, subject: string) {
    return this.filterFields(data, action, subject);
  }

  public testFilterFieldsArray<T extends Record<string, unknown>>(data: T[], action: string, subject: string) {
    return this.filterFieldsArray(data, action, subject);
  }

  public testBuildAuthorizedFilter<T extends Record<string, unknown>>(
    action: string,
    subject: string,
    additionalFilter?: T
  ) {
    return this.buildAuthorizedFilter(action, subject, additionalFilter);
  }

  public testIsSuperAdmin() {
    return this.isSuperAdmin();
  }

  public testIsTenantAdmin() {
    return this.isTenantAdmin();
  }
}

describe('AuthorizedBaseService', () => {
  let service: TestAuthorizedService;
  let mockClsService: any;
  let mockPolicyEngine: any;
  let mockAbility: AppAbility;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAbility = createMockAbility({
      'read:User': true,
      'list:User': true,
      'create:User': false,
      'update:User': true,
      'delete:User': false,
      'manage:all': false,
      'manage:User': false,
      'manage:Role': false,
    });

    mockClsService = {
      get: vi.fn(),
      set: vi.fn(),
    };

    mockPolicyEngine = {
      getAccessibleBy: vi.fn(),
      getPermittedFields: vi.fn(),
      can: vi.fn(),
    };

    service = new TestAuthorizedService(
      mockClsService as unknown as ClsService<IActiveUserContext>,
      mockPolicyEngine as unknown as PolicyEngine
    );
  });

  describe('getAbility', () => {
    it('should return ability from CLS context', () => {
      mockClsService.get.mockReturnValue(mockAbility);

      const ability = service.testGetAbility();

      expect(ability).toBe(mockAbility);
      expect(mockClsService.get).toHaveBeenCalledWith('userAbility');
    });

    it('should throw ForbiddenException when no ability in context', () => {
      mockClsService.get.mockReturnValue(null);

      expect(() => service.testGetAbility()).toThrow(ForbiddenException);
      expect(() => service.testGetAbility()).toThrow('No authorization context available');
    });
  });

  describe('getCurrentUser', () => {
    it('should return user from CLS context', () => {
      const mockUser = { id: 'user-123', tenantId: 'tenant-456' };
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return null;
      });

      const user = service.testGetCurrentUser();

      expect(user).toBe(mockUser);
    });

    it('should throw ForbiddenException when no user in context', () => {
      mockClsService.get.mockReturnValue(null);

      expect(() => service.testGetCurrentUser()).toThrow(ForbiddenException);
      expect(() => service.testGetCurrentUser()).toThrow('No user context available');
    });
  });

  describe('getCurrentTenantId', () => {
    it('should return tenant ID from user context', () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'user-123', tenantId: 'tenant-456' };
        return null;
      });

      const tenantId = service.testGetCurrentTenantId();

      expect(tenantId).toBe('tenant-456');
    });

    it('should return undefined when no user in context', () => {
      mockClsService.get.mockReturnValue(null);

      const tenantId = service.testGetCurrentTenantId();

      expect(tenantId).toBeUndefined();
    });
  });

  describe('getAccessibleFilter', () => {
    it('should return filter from PolicyEngine', () => {
      const expectedFilter = { tenantId: 'tenant-456' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getAccessibleBy.mockReturnValue({
        User: expectedFilter,
      });

      const filter = service.testGetAccessibleFilter('read', 'User');

      expect(filter).toEqual(expectedFilter);
      expect(mockPolicyEngine.getAccessibleBy).toHaveBeenCalledWith(mockAbility, 'read');
    });

    it('should return empty object when no filter for subject', () => {
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getAccessibleBy.mockReturnValue({});

      const filter = service.testGetAccessibleFilter('read', 'User');

      expect(filter).toEqual({});
    });

    it('should return fail-safe filter on error', () => {
      mockClsService.get.mockReturnValue(null); // Will throw

      const filter = service.testGetAccessibleFilter('read', 'User');

      expect(filter).toEqual({ id: { equals: 'FORBIDDEN' } });
    });
  });

  describe('canAccess', () => {
    it('should return true when user has permission', () => {
      mockClsService.get.mockReturnValue(mockAbility);

      const result = service.testCanAccess('read', 'User');

      expect(result).toBe(true);
    });

    it('should return false when user lacks permission', () => {
      mockClsService.get.mockReturnValue(mockAbility);

      const result = service.testCanAccess('create', 'User');

      expect(result).toBe(false);
    });

    it('should return false on error', () => {
      mockClsService.get.mockReturnValue(null);

      const result = service.testCanAccess('read', 'User');

      expect(result).toBe(false);
    });
  });

  describe('canAccessResource', () => {
    it('should check permission against specific resource', () => {
      const resource = { id: 'resource-123', tenantId: 'tenant-456' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.can.mockReturnValue(true);

      const result = service.testCanAccessResource('read', 'User', resource);

      expect(result).toBe(true);
      expect(mockPolicyEngine.can).toHaveBeenCalledWith(mockAbility, 'read', 'User', resource);
    });

    it('should return false when resource check fails', () => {
      const resource = { id: 'resource-123', tenantId: 'other-tenant' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.can.mockReturnValue(false);

      const result = service.testCanAccessResource('read', 'User', resource);

      expect(result).toBe(false);
    });

    it('should return false on error', () => {
      mockClsService.get.mockReturnValue(null);

      const result = service.testCanAccessResource('read', 'User', {});

      expect(result).toBe(false);
    });
  });

  describe('assertCanAccess', () => {
    it('should not throw when user has permission', () => {
      mockClsService.get.mockReturnValue(mockAbility);

      expect(() => service.testAssertCanAccess('read', 'User')).not.toThrow();
    });

    it('should throw ForbiddenException when user lacks permission', () => {
      mockClsService.get.mockReturnValue(mockAbility);

      expect(() => service.testAssertCanAccess('create', 'User')).toThrow(ForbiddenException);
      expect(() => service.testAssertCanAccess('create', 'User')).toThrow(
        "You don't have permission to create User"
      );
    });
  });

  describe('assertCanAccessResource', () => {
    it('should not throw when user can access resource', () => {
      const resource = { id: 'resource-123' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.can.mockReturnValue(true);

      expect(() => service.testAssertCanAccessResource('read', 'User', resource)).not.toThrow();
    });

    it('should throw ForbiddenException when user cannot access resource', () => {
      const resource = { id: 'resource-123' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.can.mockReturnValue(false);

      expect(() => service.testAssertCanAccessResource('read', 'User', resource)).toThrow(
        ForbiddenException
      );
      expect(() => service.testAssertCanAccessResource('read', 'User', resource)).toThrow(
        "You don't have permission to read this User"
      );
    });
  });

  describe('getPermittedFields', () => {
    it('should return permitted fields from PolicyEngine', () => {
      const expectedFields = ['id', 'name', 'email'];
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(expectedFields);

      const fields = service.testGetPermittedFields('read', 'User');

      expect(fields).toEqual(expectedFields);
      expect(mockPolicyEngine.getPermittedFields).toHaveBeenCalledWith(mockAbility, 'read', 'User');
    });

    it('should return undefined when no field restrictions', () => {
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(undefined);

      const fields = service.testGetPermittedFields('read', 'User');

      expect(fields).toBeUndefined();
    });

    it('should return undefined on error', () => {
      mockClsService.get.mockReturnValue(null);

      const fields = service.testGetPermittedFields('read', 'User');

      expect(fields).toBeUndefined();
    });
  });

  describe('filterFields', () => {
    it('should filter object to only permitted fields', () => {
      const data = { id: '123', name: 'John', email: 'john@example.com', password: 'secret' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(['id', 'name', 'email']);

      const filtered = service.testFilterFields(data, 'read', 'User');

      expect(filtered).toEqual({ id: '123', name: 'John', email: 'john@example.com' });
      expect(filtered).not.toHaveProperty('password');
    });

    it('should return all fields when no restrictions', () => {
      const data = { id: '123', name: 'John', password: 'secret' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(undefined);

      const filtered = service.testFilterFields(data, 'read', 'User');

      expect(filtered).toEqual(data);
    });

    it('should return all fields when empty fields array', () => {
      const data = { id: '123', name: 'John' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue([]);

      const filtered = service.testFilterFields(data, 'read', 'User');

      expect(filtered).toEqual(data);
    });

    it('should handle missing fields gracefully', () => {
      const data = { id: '123', name: 'John' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(['id', 'name', 'nonexistent']);

      const filtered = service.testFilterFields(data, 'read', 'User');

      expect(filtered).toEqual({ id: '123', name: 'John' });
    });
  });

  describe('filterFieldsArray', () => {
    it('should filter array of objects', () => {
      const data = [
        { id: '1', name: 'John', password: 'secret1' },
        { id: '2', name: 'Jane', password: 'secret2' },
      ];
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(['id', 'name']);

      const filtered = service.testFilterFieldsArray(data, 'read', 'User');

      expect(filtered).toEqual([
        { id: '1', name: 'John' },
        { id: '2', name: 'Jane' },
      ]);
    });

    it('should handle empty array', () => {
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getPermittedFields.mockReturnValue(['id', 'name']);

      const filtered = service.testFilterFieldsArray([], 'read', 'User');

      expect(filtered).toEqual([]);
    });
  });

  describe('buildAuthorizedFilter', () => {
    it('should combine accessible filter with additional filter', () => {
      const accessibleFilter = { tenantId: 'tenant-456' };
      const additionalFilter = { resourceStatus: 'ENABLED' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getAccessibleBy.mockReturnValue({ User: accessibleFilter });

      const result = service.testBuildAuthorizedFilter('read', 'User', additionalFilter);

      expect(result).toEqual({
        AND: [accessibleFilter, additionalFilter],
      });
    });

    it('should work without additional filter', () => {
      const accessibleFilter = { tenantId: 'tenant-456' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getAccessibleBy.mockReturnValue({ User: accessibleFilter });

      const result = service.testBuildAuthorizedFilter('read', 'User');

      expect(result).toEqual({
        AND: [accessibleFilter],
      });
    });

    it('should skip empty additional filter', () => {
      const accessibleFilter = { tenantId: 'tenant-456' };
      mockClsService.get.mockReturnValue(mockAbility);
      mockPolicyEngine.getAccessibleBy.mockReturnValue({ User: accessibleFilter });

      const result = service.testBuildAuthorizedFilter('read', 'User', {});

      expect(result).toEqual({
        AND: [accessibleFilter],
      });
    });
  });

  describe('isSuperAdmin', () => {
    it('should return true when user can manage all', () => {
      const superAdminAbility = createMockAbility({ 'manage:all': true });
      mockClsService.get.mockReturnValue(superAdminAbility);

      const result = service.testIsSuperAdmin();

      expect(result).toBe(true);
    });

    it('should return false when user cannot manage all', () => {
      mockClsService.get.mockReturnValue(mockAbility);

      const result = service.testIsSuperAdmin();

      expect(result).toBe(false);
    });

    it('should return false on error', () => {
      mockClsService.get.mockReturnValue(null);

      const result = service.testIsSuperAdmin();

      expect(result).toBe(false);
    });
  });

  describe('isTenantAdmin', () => {
    it('should return true when user can manage User and Role', () => {
      const tenantAdminAbility = createMockAbility({
        'manage:User': true,
        'manage:Role': true,
      });
      mockClsService.get.mockReturnValue(tenantAdminAbility);

      const result = service.testIsTenantAdmin();

      expect(result).toBe(true);
    });

    it('should return false when user cannot manage both', () => {
      const partialAbility = createMockAbility({
        'manage:User': true,
        'manage:Role': false,
      });
      mockClsService.get.mockReturnValue(partialAbility);

      const result = service.testIsTenantAdmin();

      expect(result).toBe(false);
    });

    it('should return false on error', () => {
      mockClsService.get.mockReturnValue(null);

      const result = service.testIsTenantAdmin();

      expect(result).toBe(false);
    });
  });
});
