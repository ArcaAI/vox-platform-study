import { describe, it, expect } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY, SUBJECT_INSTANCE_RESOLVER_KEY } from '@arcaai/applications';
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

    it('keeps CREATE manage-only', () => {
      expect(required(RolesController.prototype.create)).toEqual([{ action: 'manage', subject: 'Role' }]);
    });

    /**
     * TASK-766 OD-1 (owner decision, 2026-08-20). `update`/`patch`/`remove`
     * used to be `manage`-only, which is exactly the gap OD-1 records: a tenant
     * admin holds the DECOMPOSED `update`/`delete:Role` from the seeded
     * `rbac-tenant-manage` policy but NOT the `manage:Role` alias, so it could
     * not edit even a custom role it had just cloned. They now accept either,
     * mirroring what the read routes already did.
     *
     * The ability is only half the gate — WHICH ROW may be written is decided
     * by `RbacRoleService.assertMutable` plus the tenant-scope Prisma extension
     * (own tenant → allowed, SYSTEM → 403, another tenant → 404). Those are
     * covered in `role.service.task766.test.ts`.
     */
    it('accepts update OR manage on the two update routes (OD-1)', () => {
      for (const handler of [RolesController.prototype.update, RolesController.prototype.patch]) {
        expect(required(handler)).toEqual([
          { action: 'update', subject: 'Role' },
          { action: 'manage', subject: 'Role' },
        ]);
        expect(mode(handler)).toBe('OR');
      }
    });

    it('accepts delete OR manage on remove (OD-1)', () => {
      expect(required(RolesController.prototype.remove)).toEqual([
        { action: 'delete', subject: 'Role' },
        { action: 'manage', subject: 'Role' },
      ]);
      expect(mode(RolesController.prototype.remove)).toBe('OR');
    });

    it('clone requires create:Role (a clone only ever CREATES a CUSTOM role; tenant admins hold the seeded `create Role {isSystemRole:false}` grant)', () => {
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

/**
 * TASK-781 — every `@ResolveSubjectInstance` on this controller must DECLARE
 * the subject it resolves an instance for.
 *
 * Without the declaration one route-level resolver is compared against EVERY
 * required permission on the route, so an instance shaped for subject X is
 * evaluated against subject Y's conditions — where a spurious `false` becomes
 * a wrongful 403 the moment any pair on that route is enforced. The `Role`
 * resolvers carried the declaration on the TASK-781 branch; the TASK-766
 * revert (`f69e3598f`) stripped it as collateral while backing out an
 * unrelated `Role.tenantId` change. This pins it back.
 *
 * `enforceGrade` stays FALSE on all four: the resolver loads its row through
 * `RoleService`, which asserts access, so it fails OPEN on exactly the request
 * an enforced pair would exist to deny. Declaring otherwise is the one thing
 * `assertCaslEnforcePairReachability` cannot catch. (These routes are OR-mode
 * anyway, which that audit refuses outright — R4.)
 */
const resolverDescriptor = (target: object) =>
  Reflect.getMetadata(SUBJECT_INSTANCE_RESOLVER_KEY, target) as { subject?: string; enforceGrade: boolean } | undefined;

describe('CASL subject-instance resolver attestation (TASK-781)', () => {
  for (const method of ['findOne', 'update', 'patch', 'remove'] as const) {
    it(`RolesController.${method} declares subject 'Role' and does not claim enforce grade`, () => {
      const descriptor = resolverDescriptor(RolesController.prototype[method]);
      expect(descriptor).toBeDefined();
      expect(descriptor?.subject).toBe('Role');
      expect(descriptor?.enforceGrade).toBe(false);
    });
  }
});
