/**
 * Authorization Decorators Unit Tests
 *
 * Tests for the authorization decorator functions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Public,
  SetPermissions,
  SetPermissionMode,
  Authorize,
  AuthorizeAny,
  RequiredScopes,
  CanRead,
  CanList,
  CanCreate,
  CanUpdate,
  CanDelete,
  CanManage,
  CanAny,
  CanAll,
} from '../decorators';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { API_KEY_REQUIRED_SCOPES } from '../unified-auth.guard';

const GUARDS_METADATA = '__guards__';

// Helper to extract metadata from decorator
const getMetadata = (decorator: ClassDecorator | MethodDecorator, key: string) => {
  const target = {};
  const descriptor = { value: () => {} };

  // Apply decorator
  (decorator as any)(target, 'testMethod', descriptor);

  // Get metadata
  return Reflect.getMetadata(key, descriptor.value);
};

describe('Authorization Decorators', () => {
  describe('Public', () => {
    it('should set SKIP_AUTH metadata to true', () => {
      const decorator = Public();
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(SKIP_AUTH_KEY, descriptor.value);
      expect(metadata).toBe(true);
    });
  });

  describe('SetPermissions', () => {
    it('should set required permissions metadata', () => {
      const decorator = SetPermissions(['read', 'User'], ['create', 'Document']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
      expect(metadata).toEqual([
        { action: 'read', subject: 'User' },
        { action: 'create', subject: 'Document' },
      ]);
    });

    it('should handle single permission', () => {
      const decorator = SetPermissions(['read', 'User']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
      expect(metadata).toEqual([{ action: 'read', subject: 'User' }]);
    });
  });

  describe('SetPermissionMode', () => {
    it('should set AND mode', () => {
      const decorator = SetPermissionMode('AND');
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(PERMISSION_MODE_KEY, descriptor.value);
      expect(metadata).toBe('AND');
    });

    it('should set OR mode', () => {
      const decorator = SetPermissionMode('OR');
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(PERMISSION_MODE_KEY, descriptor.value);
      expect(metadata).toBe('OR');
    });
  });

  describe('Authorize', () => {
    it('should set permissions with AND mode', () => {
      const decorator = Authorize(['read', 'User'], ['read', 'Tenant']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
      const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, descriptor.value);

      expect(permissions).toEqual([
        { action: 'read', subject: 'User' },
        { action: 'read', subject: 'Tenant' },
      ]);
      expect(mode).toBe('AND');
    });

    it('should work with single permission', () => {
      const decorator = Authorize(['manage', 'User']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
      expect(permissions).toEqual([{ action: 'manage', subject: 'User' }]);
    });

    it('should NOT attach a route-level guard (metadata-only; global APP_GUARD enforces)', () => {
      const decorator = Authorize(['read', 'User']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      // @Authorize() is metadata-only. The global UnifiedAuthGuard
      // (APP_GUARD) reads REQUIRED_PERMISSIONS_KEY; the decorator must NOT
      // re-apply @UseGuards(UnifiedAuthGuard), which previously ran the guard
      // (and its CASL + Redis work) twice per request.
      const guards = Reflect.getMetadata(GUARDS_METADATA, descriptor.value);
      expect(guards).toBeUndefined();
    });
  });

  describe('AuthorizeAny', () => {
    it('should set permissions with OR mode', () => {
      const decorator = AuthorizeAny(['manage', 'User'], ['read', 'AuditLog']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
      const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, descriptor.value);

      expect(permissions).toEqual([
        { action: 'manage', subject: 'User' },
        { action: 'read', subject: 'AuditLog' },
      ]);
      expect(mode).toBe('OR');
    });

    it('should NOT attach a route-level guard (metadata-only; global APP_GUARD enforces)', () => {
      const decorator = AuthorizeAny(['manage', 'User'], ['read', 'AuditLog']);
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      // Like @Authorize(), @AuthorizeAny() is metadata-only.
      const guards = Reflect.getMetadata(GUARDS_METADATA, descriptor.value);
      expect(guards).toBeUndefined();
    });
  });

  describe('RequiredScopes', () => {
    it('should set API_KEY_REQUIRED_SCOPES metadata to the given scopes', () => {
      const decorator = RequiredScopes('consultation:report:write');
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(API_KEY_REQUIRED_SCOPES, descriptor.value);
      expect(metadata).toEqual(['consultation:report:write']);
    });

    it('should support multiple scopes (OR semantics enforced by the guard)', () => {
      const decorator = RequiredScopes('consultation:report:read', 'consultation:report:write');
      const target = {};
      const descriptor = { value: () => {} };

      (decorator as any)(target, 'testMethod', descriptor);

      const metadata = Reflect.getMetadata(API_KEY_REQUIRED_SCOPES, descriptor.value);
      expect(metadata).toEqual(['consultation:report:read', 'consultation:report:write']);
    });

    it('should accept a registry wildcard scope (e.g. "consultation:*") without throwing at decoration time', () => {
      expect(() => RequiredScopes('consultation:*')).not.toThrow();
    });

    it('should accept the bare "*" superadmin wildcard scope without throwing', () => {
      expect(() => RequiredScopes('*')).not.toThrow();
    });

    it('should throw at decoration time when a scope is not in API_KEY_SCOPE_REGISTRY (typo guard)', () => {
      expect(() => RequiredScopes('consultation:report:wrote')).toThrow(/unknown API-key scope/i);
    });

    it('should name every unknown scope in the thrown error, not just the first', () => {
      expect(() => RequiredScopes('bogus:one', 'consultation:report:write', 'bogus:two')).toThrow(/bogus:one.*bogus:two/s);
    });
  });

  describe('Convenience Decorators', () => {
    describe('CanRead', () => {
      it('should set read permission for subject', () => {
        const decorator = CanRead('User');
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
        expect(permissions).toEqual([{ action: 'read', subject: 'User' }]);
      });
    });

    describe('CanList', () => {
      it('should set list permission for subject', () => {
        const decorator = CanList('Document');
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
        expect(permissions).toEqual([{ action: 'list', subject: 'Document' }]);
      });
    });

    describe('CanCreate', () => {
      it('should set create permission for subject', () => {
        const decorator = CanCreate('User');
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
        expect(permissions).toEqual([{ action: 'create', subject: 'User' }]);
      });
    });

    describe('CanUpdate', () => {
      it('should set update permission for subject', () => {
        const decorator = CanUpdate('User');
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
        expect(permissions).toEqual([{ action: 'update', subject: 'User' }]);
      });
    });

    describe('CanDelete', () => {
      it('should set delete permission for subject', () => {
        const decorator = CanDelete('User');
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
        expect(permissions).toEqual([{ action: 'delete', subject: 'User' }]);
      });
    });

    describe('CanManage', () => {
      it('should set manage permission for subject', () => {
        const decorator = CanManage('Tenant');
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, descriptor.value);
        expect(permissions).toEqual([{ action: 'manage', subject: 'Tenant' }]);
      });
    });

    describe('CanAny', () => {
      it('should be alias for AuthorizeAny', () => {
        const decorator = CanAny(['read', 'User'], ['read', 'Tenant']);
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, descriptor.value);
        expect(mode).toBe('OR');
      });
    });

    describe('CanAll', () => {
      it('should be alias for Authorize', () => {
        const decorator = CanAll(['read', 'User'], ['read', 'Tenant']);
        const target = {};
        const descriptor = { value: () => {} };

        (decorator as any)(target, 'testMethod', descriptor);

        const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, descriptor.value);
        expect(mode).toBe('AND');
      });
    });
  });

  describe('Decorator Composition', () => {
    it('should allow combining decorators on class and method', () => {
      // This tests that decorators can be stacked
      @(CanManage('User') as ClassDecorator)
      class TestController {
        @CanRead('Document')
        findDocuments() {}
      }

      // Method-level decorator should be applied
      const methodPermissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, TestController.prototype.findDocuments);
      expect(methodPermissions).toEqual([{ action: 'read', subject: 'Document' }]);
    });
  });
});
