import { describe, it, expect } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '@arcaai/applications';
import { RolesController } from '../roles.controller';
import { PoliciesController } from '../policies.controller';

/**
 * RBAC admin screens 403'd for TENANT_ADMIN because the
 * read/list routes required the `manage` alias while the seed grants the
 * decomposed `read:<Subject>` permission. Read/list routes must therefore be
 * satisfied by `read` OR `manage` (OR mode); every mutation stays `manage`-only
 * so write access remains restricted to operators that hold `manage`.
 */
const required = (target: object) => Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, target);
const mode = (target: object) => Reflect.getMetadata(PERMISSION_MODE_KEY, target);

describe('RBAC controller route permissions (AC-03)', () => {
  describe('RolesController', () => {
    it('findAll accepts read OR manage on Role', () => {
      expect(required(RolesController.prototype.findAll)).toEqual([
        { action: 'read', subject: 'Role' },
        { action: 'manage', subject: 'Role' },
      ]);
      expect(mode(RolesController.prototype.findAll)).toBe('OR');
    });

    it('findOne accepts read OR manage on Role', () => {
      expect(required(RolesController.prototype.findOne)).toEqual([
        { action: 'read', subject: 'Role' },
        { action: 'manage', subject: 'Role' },
      ]);
      expect(mode(RolesController.prototype.findOne)).toBe('OR');
    });

    it('keeps mutations manage-only (create / update / remove)', () => {
      expect(required(RolesController.prototype.create)).toEqual([{ action: 'manage', subject: 'Role' }]);
      expect(required(RolesController.prototype.update)).toEqual([{ action: 'manage', subject: 'Role' }]);
      expect(required(RolesController.prototype.remove)).toEqual([{ action: 'manage', subject: 'Role' }]);
    });

    it('TASK-501/534 G9 — clone requires create:Role (a clone only ever CREATES a CUSTOM role; tenant admins hold the seeded `create Role {isSystemRole:false}` grant)', () => {
      expect(required(RolesController.prototype.clone)).toEqual([{ action: 'create', subject: 'Role' }]);
    });
  });

  describe('PoliciesController', () => {
    it('findAll accepts read OR manage on Policy', () => {
      expect(required(PoliciesController.prototype.findAll)).toEqual([
        { action: 'read', subject: 'Policy' },
        { action: 'manage', subject: 'Policy' },
      ]);
      expect(mode(PoliciesController.prototype.findAll)).toBe('OR');
    });

    it('findOne accepts read OR manage on Policy', () => {
      expect(required(PoliciesController.prototype.findOne)).toEqual([
        { action: 'read', subject: 'Policy' },
        { action: 'manage', subject: 'Policy' },
      ]);
      expect(mode(PoliciesController.prototype.findOne)).toBe('OR');
    });

    it('keeps mutations manage-only (create / update / remove)', () => {
      expect(required(PoliciesController.prototype.create)).toEqual([{ action: 'manage', subject: 'Policy' }]);
      expect(required(PoliciesController.prototype.update)).toEqual([{ action: 'manage', subject: 'Policy' }]);
      expect(required(PoliciesController.prototype.remove)).toEqual([{ action: 'manage', subject: 'Policy' }]);
    });
  });
});
