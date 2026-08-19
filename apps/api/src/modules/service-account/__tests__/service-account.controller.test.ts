/**
 * ServiceAccountController unit tests.
 *
 * The controller's own doc block states the decorators UNDERSTATE the real
 * gate: `@CanManage('ServiceAccount')` keeps the boot audit green, but the
 * actual SUPER_ADMIN-only enforcement is imperative, inside
 * `ServiceAccountService.assertMayIssue()` — out of scope here (service
 * layer). This file covers what the controller itself is responsible for:
 * delegation with the exact arguments (incl. `expectedVersion ?? 0` on
 * update), and the THREE decorators that ARE declarative and therefore
 * regress silently — `@ForbidApiKey()`, `@ForbidServiceAccount()` (no
 * self-replication), and the absence of any `@RequiredSvcScopes(...)` (this
 * surface must never become machine-reachable), plus `@RequiresIfMatch()` on
 * the versioned update route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { REQUIRED_PERMISSIONS_KEY, API_KEY_FORBIDDEN, SERVICE_ACCOUNT_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators';

import { ServiceAccountController } from '../service-account.controller';

function makeController() {
  const service = {
    create: vi.fn().mockResolvedValue({ id: 'sa-1', clientSecret: 'secret' }),
    getAll: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue({ id: 'sa-1' }),
    update: vi.fn().mockResolvedValue({ id: 'sa-1', version: 2 }),
    rotate: vi.fn().mockResolvedValue({ id: 'sa-1', clientSecret: 'new-secret' }),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new ServiceAccountController(service as never);
  return { controller, service };
}

describe('ServiceAccountController — delegation', () => {
  let controller: ServiceAccountController;
  let service: ReturnType<typeof makeController>['service'];

  beforeEach(() => {
    ({ controller, service } = makeController());
  });

  it('creates a service account with the request body', async () => {
    const request = { name: 'ci-bot', scopes: ['svc:admin:department:manage'] };
    await controller.create(request as never);
    expect(service.create).toHaveBeenCalledWith(request);
  });

  it('lists service accounts', async () => {
    await controller.getAll();
    expect(service.getAll).toHaveBeenCalledWith();
  });

  it('gets by id', async () => {
    await controller.getById('sa-1');
    expect(service.getById).toHaveBeenCalledWith('sa-1');
  });

  it('updates with the id, body, and expectedVersion', async () => {
    const request = { scopes: ['svc:admin:department:manage'] };
    await controller.update('sa-1', request as never, 3);
    expect(service.update).toHaveBeenCalledWith('sa-1', request, 3);
  });

  it('defaults expectedVersion to 0 when the header/body carried none', async () => {
    const request = { scopes: [] };
    await controller.update('sa-1', request as never, undefined);
    expect(service.update).toHaveBeenCalledWith('sa-1', request, 0);
  });

  it('rotates the client secret', async () => {
    await controller.rotate('sa-1');
    expect(service.rotate).toHaveBeenCalledWith('sa-1');
  });

  it('revokes an account', async () => {
    await controller.revoke('sa-1');
    expect(service.revoke).toHaveBeenCalledWith('sa-1');
  });
});

describe('ServiceAccountController — authorization metadata', () => {
  const reflector = new Reflector();

  it('forbids API-key credentials at the class level', () => {
    expect(reflector.get(API_KEY_FORBIDDEN, ServiceAccountController)).toBe(true);
  });

  it('forbids service-account credentials at the class level (no self-replication)', () => {
    expect(reflector.get(SERVICE_ACCOUNT_FORBIDDEN, ServiceAccountController)).toBe(true);
  });

  it('declares NO svc:* scope — this surface must never become machine-reachable', () => {
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, ServiceAccountController)).toBeUndefined();
  });

  it('class-level default is manage:ServiceAccount', () => {
    expect(reflector.get(REQUIRED_PERMISSIONS_KEY, ServiceAccountController)).toEqual([{ action: 'manage', subject: 'ServiceAccount' }]);
  });

  it('read routes are gated with read:ServiceAccount', () => {
    for (const handler of [
      ServiceAccountController.prototype.getAvailableScopes,
      ServiceAccountController.prototype.getAll,
      ServiceAccountController.prototype.getById,
    ]) {
      expect(reflector.get(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([{ action: 'read', subject: 'ServiceAccount' }]);
    }
  });

  it('requires If-Match on the update route', () => {
    const flag = reflector.get(REQUIRES_IF_MATCH_KEY, ServiceAccountController.prototype.update);
    expect(flag).toBe(true);
  });

  it('does NOT require If-Match on create/rotate/revoke', () => {
    for (const handler of [
      ServiceAccountController.prototype.create,
      ServiceAccountController.prototype.rotate,
      ServiceAccountController.prototype.revoke,
    ]) {
      expect(reflector.get(REQUIRES_IF_MATCH_KEY, handler)).toBeUndefined();
    }
  });
});
