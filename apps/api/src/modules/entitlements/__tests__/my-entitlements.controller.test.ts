/**
 * MyEntitlementsController unit tests.
 *
 * Covers the controller's own logic: resolving `tenantId` from CLS and the
 * 400-when-absent guard (global-admins without a tenant context must use
 * `/admin/entitlements/*`, not silently see nothing). `@Authorize(['read',
 * 'Tenant'])` + `@RequiredScopes('tenant:account:read')` are exercised by the
 * guard pipeline (+ e2e); this file pins their presence to catch decorator
 * drift on a billing-adjacent read surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { REQUIRED_PERMISSIONS_KEY, API_KEY_REQUIRED_SCOPES } from '@arcaai/applications';

import { MyEntitlementsController } from '../my-entitlements.controller';

function makeController(tenantId: string | undefined) {
  const entitlements = { getCapabilities: vi.fn().mockResolvedValue({ tenantId }) };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : undefined)) };
  const controller = new MyEntitlementsController(entitlements as never, cls as never);
  return { controller, entitlements, cls };
}

describe('MyEntitlementsController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the CLS tenant and forwards it to the service', async () => {
    const { controller, entitlements, cls } = makeController('t1');
    await controller.me();
    expect(cls.get).toHaveBeenCalledWith('tenantId');
    expect(entitlements.getCapabilities).toHaveBeenCalledWith('t1');
  });

  it('400s when there is no tenant context', () => {
    const { controller } = makeController(undefined);
    expect(() => controller.me()).toThrow(BadRequestException);
  });
});

describe('MyEntitlementsController — authorization metadata', () => {
  const reflector = new Reflector();

  it('carries the tenant:account:read API-key scope at the class level', () => {
    const scopes = reflector.get(API_KEY_REQUIRED_SCOPES, MyEntitlementsController);
    expect(scopes).toEqual(['tenant:account:read']);
  });

  it('gates the me() route with read:Tenant', () => {
    const required = reflector.get(REQUIRED_PERMISSIONS_KEY, MyEntitlementsController.prototype.me);
    expect(required).toEqual([{ action: 'read', subject: 'Tenant' }]);
  });
});
