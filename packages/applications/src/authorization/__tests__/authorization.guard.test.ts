/**
 * AuthorizationGuard Unit Tests
 *
 * Tests for the NestJS guard that enforces policy-based access control.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationGuard, REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY, RequiredPermission } from '../authorization.guard';
import { PolicyEngine, AppAbility } from '../policy.engine';

// Mock CASL ability
const createMockAbility = (permissions: Record<string, boolean>): AppAbility =>
  ({
    can: vi.fn((action: string, subject: string) => {
      const key = `${action}:${subject}`;
      return permissions[key] ?? false;
    }),
    cannot: vi.fn((action: string, subject: string) => {
      const key = `${action}:${subject}`;
      return !(permissions[key] ?? false);
    }),
    relevantRuleFor: vi.fn(),
  }) as unknown as AppAbility;

// Mock ExecutionContext
const createMockContext = (
  options: {
    user?: { id: string; tenantId?: string };
    params?: Record<string, string>;
  } = {},
): ExecutionContext => {
  const request = {
    params: options.params || {},
    ability: null,
  };

  return {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: vi.fn(() => ({
      getRequest: vi.fn(() => request),
    })),
  } as unknown as ExecutionContext;
};

describe('AuthorizationGuard', () => {
  let guard: AuthorizationGuard;
  let reflector: Reflector;
  let policyEngine: PolicyEngine;
  let clsService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    reflector = {
      getAllAndOverride: vi.fn(),
    } as unknown as Reflector;

    policyEngine = {
      buildAbility: vi.fn(),
    } as unknown as PolicyEngine;

    clsService = {
      get: vi.fn(),
      set: vi.fn(),
    };

    guard = new AuthorizationGuard(reflector, policyEngine, clsService);
  });

  describe('canActivate', () => {
    it('should allow access when SKIP_AUTH is true (public routes)', async () => {
      const context = createMockContext();

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return true;
        return undefined;
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(policyEngine.buildAbility).not.toHaveBeenCalled();
    });

    it('should allow access when no permissions are required', async () => {
      const context = createMockContext();

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) return null;
        return undefined;
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when user is not in context', async () => {
      const context = createMockContext();

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) {
          return [{ action: 'read', subject: 'User' }];
        }
        return undefined;
      });

      clsService.get.mockReturnValue(null);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
    });

    it('should allow access when user has required permission (single)', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({ 'read:User': true });

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) {
          return [{ action: 'read', subject: 'User' }];
        }
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });

      clsService.get.mockReturnValue({ id: 'user-123', tenantId: 'tenant-456' });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(policyEngine.buildAbility).toHaveBeenCalledWith({
        userId: 'user-123',
        tenantId: 'tenant-456',
        params: {},
      });
    });

    it('should deny access when user lacks required permission', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({ 'read:User': false });

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) {
          return [{ action: 'read', subject: 'User' }];
        }
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });

      clsService.get.mockReturnValue({ id: 'user-123' });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing permissions: read:User');
    });

    describe('AND mode (all permissions required)', () => {
      it('should allow when all permissions are satisfied', async () => {
        const context = createMockContext();
        const mockAbility = createMockAbility({
          'read:User': true,
          'read:Tenant': true,
        });

        (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
          if (key === SKIP_AUTH_KEY) return false;
          if (key === REQUIRED_PERMISSIONS_KEY) {
            return [
              { action: 'read', subject: 'User' },
              { action: 'read', subject: 'Tenant' },
            ];
          }
          if (key === PERMISSION_MODE_KEY) return 'AND';
          return undefined;
        });

        clsService.get.mockReturnValue({ id: 'user-123' });
        (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
      });

      it('should deny when any permission is missing', async () => {
        const context = createMockContext();
        const mockAbility = createMockAbility({
          'read:User': true,
          'read:Tenant': false, // Missing this one
        });

        (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
          if (key === SKIP_AUTH_KEY) return false;
          if (key === REQUIRED_PERMISSIONS_KEY) {
            return [
              { action: 'read', subject: 'User' },
              { action: 'read', subject: 'Tenant' },
            ];
          }
          if (key === PERMISSION_MODE_KEY) return 'AND';
          return undefined;
        });

        clsService.get.mockReturnValue({ id: 'user-123' });
        (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

        await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
        await expect(guard.canActivate(context)).rejects.toThrow('Missing permissions: read:Tenant');
      });
    });

    describe('OR mode (any permission required)', () => {
      it('should allow when at least one permission is satisfied', async () => {
        const context = createMockContext();
        const mockAbility = createMockAbility({
          'manage:User': false,
          'read:AuditLog': true, // Has this one
        });

        (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
          if (key === SKIP_AUTH_KEY) return false;
          if (key === REQUIRED_PERMISSIONS_KEY) {
            return [
              { action: 'manage', subject: 'User' },
              { action: 'read', subject: 'AuditLog' },
            ];
          }
          if (key === PERMISSION_MODE_KEY) return 'OR';
          return undefined;
        });

        clsService.get.mockReturnValue({ id: 'user-123' });
        (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
      });

      it('should deny when no permissions are satisfied', async () => {
        const context = createMockContext();
        const mockAbility = createMockAbility({
          'manage:User': false,
          'read:AuditLog': false,
        });

        (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
          if (key === SKIP_AUTH_KEY) return false;
          if (key === REQUIRED_PERMISSIONS_KEY) {
            return [
              { action: 'manage', subject: 'User' },
              { action: 'read', subject: 'AuditLog' },
            ];
          }
          if (key === PERMISSION_MODE_KEY) return 'OR';
          return undefined;
        });

        clsService.get.mockReturnValue({ id: 'user-123' });
        (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

        await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
        await expect(guard.canActivate(context)).rejects.toThrow('Requires at least one of: manage:User, read:AuditLog');
      });
    });

    it('should store ability in request and CLS context', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({ 'read:User': true });
      const request = context.switchToHttp().getRequest();

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) {
          return [{ action: 'read', subject: 'User' }];
        }
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });

      clsService.get.mockReturnValue({ id: 'user-123' });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await guard.canActivate(context);

      expect(request.ability).toBe(mockAbility);
      expect(clsService.set).toHaveBeenCalledWith('userAbility', mockAbility);
    });

    it('should throw ForbiddenException when PolicyEngine fails', async () => {
      const context = createMockContext();

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) {
          return [{ action: 'read', subject: 'User' }];
        }
        return undefined;
      });

      clsService.get.mockReturnValue({ id: 'user-123' });
      (policyEngine.buildAbility as any).mockRejectedValue(new Error('Database error'));

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Authorization failed');
    });

    it('should pass request params to PolicyEngine', async () => {
      const context = createMockContext({ params: { id: 'resource-123' } });
      const mockAbility = createMockAbility({ 'read:User': true });

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === REQUIRED_PERMISSIONS_KEY) {
          return [{ action: 'read', subject: 'User' }];
        }
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });

      clsService.get.mockReturnValue({ id: 'user-123', tenantId: 'tenant-456' });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await guard.canActivate(context);

      expect(policyEngine.buildAbility).toHaveBeenCalledWith({
        userId: 'user-123',
        tenantId: 'tenant-456',
        params: { id: 'resource-123' },
      });
    });
  });
});
