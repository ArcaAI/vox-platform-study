/**
 * PoliciesController unit tests.
 *
 * `@CanAny/@CanManage('Policy')` + `@ForbidApiKey()` + `@RequiredSvcScopes(...)`
 * are exercised by the guard pipeline (+ e2e). These specs cover the
 * controller's OWN logic: delegation to `IPolicyService` with the exact
 * arguments, the 404-on-missing mapping for `findOne`, and the response
 * shaping in `toResponse` (defaulting `isProtected` and dropping a
 * null `description`). Policies gate every other permission in the system,
 * so a decorator regression here is a privilege-escalation surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY, API_KEY_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';

import { PoliciesController } from '../policies.controller';

const POLICY = {
  id: 'policy-1',
  name: 'tenant-admin',
  description: null,
  scope: 'TENANT',
  rules: [{ action: 'manage', subject: 'all' }],
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

function makeController() {
  const policyService = {
    findAll: vi.fn().mockResolvedValue({ data: [POLICY], total: 1 }),
    findOne: vi.fn().mockResolvedValue(POLICY),
    create: vi.fn().mockResolvedValue(POLICY),
    update: vi.fn().mockResolvedValue(POLICY),
    patch: vi.fn().mockResolvedValue(POLICY),
    softDelete: vi.fn().mockResolvedValue(undefined),
    validateRules: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };
  const controller = new PoliciesController(policyService as never);
  return { controller, policyService };
}

describe('PoliciesController — delegation', () => {
  let controller: PoliciesController;
  let policyService: ReturnType<typeof makeController>['policyService'];

  beforeEach(() => {
    ({ controller, policyService } = makeController());
  });

  it('lists with the query params forwarded to the service', async () => {
    const result = await controller.findAll(2, 10, 'admin', 'TENANT' as never);
    expect(policyService.findAll).toHaveBeenCalledWith({ page: 2, pageSize: 10, search: 'admin', scope: 'TENANT' });
    expect(result).toEqual({ data: [expect.objectContaining({ id: 'policy-1', isProtected: false })], total: 1, page: 2, pageSize: 10 });
  });

  it('gets a policy by id and maps to the response shape', async () => {
    const result = await controller.findOne('policy-1');
    expect(policyService.findOne).toHaveBeenCalledWith('policy-1');
    expect(result.description).toBeUndefined();
    expect(result.isProtected).toBe(false);
  });

  it('404s when the policy is missing', async () => {
    policyService.findOne.mockResolvedValueOnce(null);
    await expect(controller.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a policy with the request fields', async () => {
    const dto = { name: 'new-policy', description: 'desc', scope: 'GLOBAL', rules: [] };
    await controller.create(dto as never);
    expect(policyService.create).toHaveBeenCalledWith({ name: 'new-policy', description: 'desc', scope: 'GLOBAL', rules: [] });
  });

  it('updates a policy, forwarding breakGlass through', async () => {
    const dto = { name: 'renamed', rules: [], breakGlass: { password: 'p', confirmationName: 'renamed' } };
    await controller.update('policy-1', dto as never);
    expect(policyService.update).toHaveBeenCalledWith(
      'policy-1',
      expect.objectContaining({ name: 'renamed', breakGlass: { password: 'p', confirmationName: 'renamed' } }),
    );
  });

  it('patches a policy, forwarding resourceStatus + breakGlass through', async () => {
    const dto = { resourceStatus: 'DISABLED', breakGlass: { password: 'p', confirmationName: 'x' } };
    await controller.patch('policy-1', dto as never);
    expect(policyService.patch).toHaveBeenCalledWith(
      'policy-1',
      expect.objectContaining({ resourceStatus: 'DISABLED', breakGlass: { password: 'p', confirmationName: 'x' } }),
    );
  });

  it('removes a policy, forwarding the break-glass body', async () => {
    const breakGlass = { password: 'p', confirmationName: 'tenant-admin' };
    await controller.remove('policy-1', breakGlass as never);
    expect(policyService.softDelete).toHaveBeenCalledWith('policy-1', breakGlass);
  });

  it('validates rules', async () => {
    await controller.validate({ rules: [{ action: 'read', subject: 'all' }] } as never);
    expect(policyService.validateRules).toHaveBeenCalledWith([{ action: 'read', subject: 'all' }]);
  });
});

describe('PoliciesController — authorization metadata', () => {
  const reflector = new Reflector();

  it('forbids API-key credentials at the class level', () => {
    expect(reflector.get(API_KEY_FORBIDDEN, PoliciesController)).toBe(true);
  });

  it('requires the rbac-policy:write svc scope at the class level', () => {
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, PoliciesController)).toEqual(['svc:admin:rbac-policy:write']);
  });

  it('class-level default is manage:Policy', () => {
    expect(reflector.get(REQUIRED_PERMISSIONS_KEY, PoliciesController)).toEqual([{ action: 'manage', subject: 'Policy' }]);
  });

  it('read routes accept read OR manage on Policy', () => {
    for (const handler of [PoliciesController.prototype.findAll, PoliciesController.prototype.findOne]) {
      expect(reflector.get(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        { action: 'read', subject: 'Policy' },
        { action: 'manage', subject: 'Policy' },
      ]);
      expect(reflector.get(PERMISSION_MODE_KEY, handler)).toBe('OR');
    }
  });

  it('mutation routes require manage:Policy', () => {
    for (const handler of [
      PoliciesController.prototype.create,
      PoliciesController.prototype.update,
      PoliciesController.prototype.patch,
      PoliciesController.prototype.remove,
      PoliciesController.prototype.validate,
    ]) {
      expect(reflector.get(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([{ action: 'manage', subject: 'Policy' }]);
    }
  });
});
