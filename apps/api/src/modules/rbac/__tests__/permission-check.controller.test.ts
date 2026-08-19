/**
 * PermissionCheckController + UserPermissionCheckController unit tests.
 *
 * These two are the TASK-760 split of the retired `rbac/check` RPC. Route
 * ORDER is load-bearing (pinned separately by
 * `user/controllers/__tests__/users-me-route-precedence.test.ts`); this file
 * covers the controllers' own authorization logic: a caller may always check
 * their own permissions, checking someone else requires `manage:User` on the
 * CALLER's ability, and the body's `userId`/`tenantId` override the path only
 * when the caller is privileged enough.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';

import { PermissionCheckController, UserPermissionCheckController } from '../permission-check.controller';

function makeAbility(rules: Array<{ action: string; subject: string; conditions?: unknown }>, canManageUser = false) {
  return {
    rules,
    can: vi.fn((action: string, subject: string) => (action === 'manage' && subject === 'User' ? canManageUser : true)),
  };
}

describe('PermissionCheckController — self permissions', () => {
  it('builds the ability for the CLS user and maps rules to the response', async () => {
    const ability = makeAbility([{ action: 'read', subject: 'Department' }]);
    const policyEngine = { buildAbility: vi.fn().mockResolvedValue(ability) };
    const cls = { get: vi.fn().mockReturnValue({ id: 'user-1', tenantId: 'tenant-1' }) };
    const controller = new PermissionCheckController(policyEngine as never, cls as never);

    const result = await controller.getMyPermissions();

    expect(policyEngine.buildAbility).toHaveBeenCalledWith({ userId: 'user-1', tenantId: 'tenant-1' });
    expect(result).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-1',
      permissions: [{ action: 'read', subject: 'Department', conditions: undefined }],
    });
  });

  it('throws when there is no authenticated user in CLS', async () => {
    const policyEngine = { buildAbility: vi.fn() };
    const cls = { get: vi.fn().mockReturnValue(null) };
    const controller = new PermissionCheckController(policyEngine as never, cls as never);
    await expect(controller.getMyPermissions()).rejects.toThrow('User not authenticated');
  });
});

describe('UserPermissionCheckController — checkPermission', () => {
  let policyEngine: { buildAbility: ReturnType<typeof vi.fn> };
  let cls: { get: ReturnType<typeof vi.fn> };
  let controller: UserPermissionCheckController;

  beforeEach(() => {
    policyEngine = { buildAbility: vi.fn() };
    cls = { get: vi.fn().mockReturnValue({ id: 'caller-1', tenantId: 'tenant-1' }) };
    controller = new UserPermissionCheckController(policyEngine as never, cls as never);
  });

  it('`id: me` resolves to the caller', async () => {
    const ability = makeAbility([]);
    policyEngine.buildAbility.mockResolvedValue(ability);

    const result = await controller.checkPermission('me', { action: 'read', subject: 'Department' } as never);

    expect(policyEngine.buildAbility).toHaveBeenCalledWith({ userId: 'caller-1', tenantId: 'tenant-1' });
    expect(result.userId).toBe('caller-1');
    expect(result.allowed).toBe(true);
  });

  it('checking another user without manage:User throws', async () => {
    const adminAbility = makeAbility([], false);
    policyEngine.buildAbility.mockResolvedValue(adminAbility);

    await expect(
      controller.checkPermission('other-user', { action: 'read', subject: 'Department', userId: 'other-user' } as never),
    ).rejects.toThrow('You can only check your own permissions');
  });

  it('checking another user WITH manage:User builds the ability for the target', async () => {
    const adminAbility = makeAbility([], true);
    const targetAbility = makeAbility([]);
    policyEngine.buildAbility.mockResolvedValueOnce(adminAbility).mockResolvedValueOnce(targetAbility);

    const result = await controller.checkPermission('other-user', {
      action: 'manage',
      subject: 'User',
      userId: 'other-user',
      tenantId: 'tenant-2',
    } as never);

    expect(policyEngine.buildAbility).toHaveBeenNthCalledWith(2, { userId: 'other-user', tenantId: 'tenant-2' });
    expect(result.userId).toBe('other-user');
    expect(result.tenantId).toBe('tenant-2');
  });

  it('evaluates with a resource via policyEngine.can when dto.resource is present', async () => {
    const ability = makeAbility([]);
    policyEngine.buildAbility.mockResolvedValue(ability);
    const canSpy = { can: vi.fn().mockReturnValue(true) };
    // policyEngine.can is invoked (not ability.can) when a resource is supplied
    (policyEngine as never as typeof canSpy).can = canSpy.can;

    const result = await controller.checkPermission('me', {
      action: 'read',
      subject: 'Department',
      resource: { id: 'dept-1' },
    } as never);

    expect(canSpy.can).toHaveBeenCalledWith(ability, 'read', 'Department', { id: 'dept-1' });
    expect(result.allowed).toBe(true);
  });
});

describe('UserPermissionCheckController — checkPermissionsBulk', () => {
  it('reports allAllowed/anyAllowed correctly across mixed results', async () => {
    const cls = { get: vi.fn().mockReturnValue({ id: 'caller-1', tenantId: 'tenant-1' }) };
    const ability = {
      can: vi.fn((action: string) => action === 'read'),
    };
    const policyEngine = { buildAbility: vi.fn().mockResolvedValue(ability) };
    const controller = new UserPermissionCheckController(policyEngine as never, cls as never);

    const result = await controller.checkPermissionsBulk('me', {
      permissions: [
        { action: 'read', subject: 'Department' },
        { action: 'delete', subject: 'Department' },
      ],
    } as never);

    expect(result.results).toEqual([
      { action: 'read', subject: 'Department', allowed: true },
      { action: 'delete', subject: 'Department', allowed: false },
    ]);
    expect(result.allAllowed).toBe(false);
    expect(result.anyAllowed).toBe(true);
  });
});

describe('PermissionCheckController / UserPermissionCheckController — authorization metadata', () => {
  const reflector = new Reflector();

  it('both controllers carry the user:profile:read API-key scope at the class level', () => {
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, PermissionCheckController)).toEqual(['user:profile:read']);
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, UserPermissionCheckController)).toEqual(['user:profile:read']);
  });

  it('every route requires an authenticated caller (@Authorize() with no args)', () => {
    expect(reflector.get(REQUIRED_PERMISSIONS_KEY, PermissionCheckController.prototype.getMyPermissions)).toEqual([]);
    expect(reflector.get(REQUIRED_PERMISSIONS_KEY, UserPermissionCheckController.prototype.checkPermission)).toEqual([]);
    expect(reflector.get(REQUIRED_PERMISSIONS_KEY, UserPermissionCheckController.prototype.checkPermissionsBulk)).toEqual([]);
  });
});
