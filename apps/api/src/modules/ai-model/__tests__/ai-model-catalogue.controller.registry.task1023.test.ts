/**
 * The two registry routes ANY admin may call — `GET access` and `GET registry` — live on
 * `AiModelCatalogueController` (the `read:AiModel` plane), not on the super-admin
 * `AiModelAdminController`. The boot audit (`auditAdminControllersDeclareCorrectSvcScope`)
 * admits the `svc:admin:ai-model:read` + `:manage` pair only off the admin controller, so a
 * read route there refuses the gateway start — every admin-controller route must carry
 * exactly the `:manage` twin.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { AiModelAdminController } from '../ai-model-admin.controller';
import { AiModelCatalogueController } from '../ai-model-catalogue.controller';

const reflector = new Reflector();
type Proto = Record<string, (...args: unknown[]) => unknown>;
const catalogueProto = AiModelCatalogueController.prototype as unknown as Proto;
const adminProto = AiModelAdminController.prototype as unknown as Proto;
const meta = (key: string, proto: Proto, cls: object, handler: string) => reflector.getAllAndOverride(key, [proto[handler], cls as never]);

describe('AiModelCatalogueController — the read-only registry routes', () => {
  it.each([
    ['access', 'access'],
    ['registry', 'registry'],
  ])('%s is GET %s with read:AiModel and the read-or-manage svc scopes', (handler, path) => {
    expect(Reflect.getMetadata(PATH_METADATA, catalogueProto[handler])).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, catalogueProto[handler])).toBe(RequestMethod.GET);
    expect(meta(REQUIRED_PERMISSIONS_KEY, catalogueProto, AiModelCatalogueController, handler)).toEqual([{ action: 'read', subject: 'AiModel' }]);
    expect(meta(SERVICE_ACCOUNT_REQUIRED_SCOPES, catalogueProto, AiModelCatalogueController, handler)).toEqual([
      'svc:admin:ai-model:read',
      'svc:admin:ai-model:manage',
    ]);
  });

  it('access delegates to ModelRegistryAccessService', async () => {
    const getAccess = vi.fn().mockResolvedValue({ canManage: false, tenantManagementEnabled: true });
    const controller = new AiModelCatalogueController({} as never, { getAccess } as never);
    await expect(controller.access()).resolves.toEqual({ canManage: false, tenantManagementEnabled: true });
  });

  it('registry delegates the whole query to AiModelService.listRegistry', async () => {
    const listRegistry = vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 });
    const controller = new AiModelCatalogueController({ listRegistry } as never, {} as never);
    const query = { page: 2, limit: 5, search: 'ner', searchFields: 'name' };
    await controller.registry(query as never);
    expect(listRegistry).toHaveBeenCalledWith(query);
  });
});

describe('AiModelAdminController — stays a platform-only plane', () => {
  const routes = Object.getOwnPropertyNames(AiModelAdminController.prototype).filter(
    (name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, adminProto[name]) !== undefined,
  );

  it('carries no read-only registry route', () => {
    expect(routes).not.toContain('access');
    expect(routes).not.toContain('registry');
  });

  it.each(routes)('%s requires exactly the svc:admin:ai-model:manage twin (the boot audit rule) and manage:all', (handler) => {
    expect(meta(SERVICE_ACCOUNT_REQUIRED_SCOPES, adminProto, AiModelAdminController, handler)).toEqual(['svc:admin:ai-model:manage']);
    expect(meta(REQUIRED_PERMISSIONS_KEY, adminProto, AiModelAdminController, handler)).toEqual([{ action: 'manage', subject: 'all' }]);
  });
});
