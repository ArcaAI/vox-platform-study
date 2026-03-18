/**
 * UserGroup Removal Verification Tests
 *
 * These tests verify that all UserGroup-related code has been properly
 * removed from the domains package. After removal:
 * - ResourceType enum should not include UserGroup values
 * - EventTypes enum should not include UserGroup events
 * - No UserGroup exports should exist from barrel files
 */

import { describe, it, expect } from 'vitest';
import { ResourceType } from '../enums/generated/ResourceType';
import { EventTypes } from '../common/events/eventTypes';

describe('UserGroup Removal — Domain Layer', () => {
  describe('ResourceType enum', () => {
    it('should NOT contain UserGroup value', () => {
      const values = Object.values(ResourceType);
      expect(values).not.toContain('UserGroup');
    });

    it('should NOT contain UserGroupAssignment value', () => {
      const values = Object.values(ResourceType);
      expect(values).not.toContain('UserGroupAssignment');
    });

    it('should still contain other resource types', () => {
      const values = Object.values(ResourceType);
      expect(values).toContain('User');
      expect(values).toContain('Role');
      expect(values).toContain('UserRoleAssignment');
      expect(values).toContain('Tenant');
      expect(values).toContain('Department');
    });
  });

  describe('EventTypes enum', () => {
    it('should NOT contain UserGroupCreated event', () => {
      const values = Object.values(EventTypes);
      expect(values).not.toContain('userGroup.created');
    });

    it('should NOT contain UserGroupUpdated event', () => {
      const values = Object.values(EventTypes);
      expect(values).not.toContain('userGroup.updated');
    });

    it('should still contain other event types', () => {
      const values = Object.values(EventTypes);
      expect(values).toContain('user.created');
      expect(values).toContain('user.updated');
      expect(values).toContain('resource.created');
    });
  });
});
