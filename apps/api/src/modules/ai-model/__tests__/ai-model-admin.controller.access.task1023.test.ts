/**
 * The two registry routes ANY admin may call — `GET access` and `GET registry` — carry
 * `read:AiModel` at the METHOD level, which overrides the controller's class-level
 * `manage:all` (the guards resolve with `getAllAndOverride([handler, class])`). Every
 * other route keeps `manage:all`.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { AiModelAdminController } from '../ai-model-admin.controller';

const reflector = new Reflector();
const proto = AiModelAdminController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const permissionsOf = (handler: string) => reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [proto[handler], AiModelAdminController]);
const svcScopesOf = (handler: string) => reflector.getAllAndOverride(SERVICE_ACCOUNT_REQUIRED_SCOPES, [proto[handler], AiModelAdminController]);

describe('AiModelAdminController — the read-only registry routes', () => {
  it.each([
    ['access', 'access'],
    ['registry', 'registry'],
  ])('%s is GET %s with read:AiModel and the read-or-manage svc scopes', (handler, path) => {
    expect(Reflect.getMetadata(PATH_METADATA, proto[handler])).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, proto[handler])).toBe(RequestMethod.GET);
    expect(permissionsOf(handler)).toEqual([{ action: 'read', subject: 'AiModel' }]);
    expect(svcScopesOf(handler)).toEqual(['svc:admin:ai-model:read', 'svc:admin:ai-model:manage']);
  });

  it('are declared BEFORE the `:id` family, so they are never captured as an id', () => {
    const names = Object.getOwnPropertyNames(AiModelAdminController.prototype);
    expect(names).toContain('access');
    expect(names).toContain('registry');
    expect(names.indexOf('access')).toBeLessThan(names.indexOf('fetchById'));
    expect(names.indexOf('registry')).toBeLessThan(names.indexOf('fetchById'));
  });

  it.each(['create', 'fetchAll', 'list', 'fetchById', 'fetchBySlug', 'update', 'delete', 'setPlatformDefault'])(
    '%s still requires manage:all',
    (handler) => {
      expect(permissionsOf(handler)).toEqual([{ action: 'manage', subject: 'all' }]);
    },
  );

  it('access delegates to ModelRegistryAccessService', async () => {
    const getAccess = vi.fn().mockResolvedValue({ canManage: false, tenantManagementEnabled: true });
    const controller = new AiModelAdminController({} as never, {} as never, {} as never, {} as never, { getAccess } as never);
    await expect(controller.access()).resolves.toEqual({ canManage: false, tenantManagementEnabled: true });
  });

  it('registry delegates the whole query to AiModelService.listRegistry', async () => {
    const listRegistry = vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 });
    const controller = new AiModelAdminController({ listRegistry } as never, {} as never, {} as never, {} as never, {} as never);
    const query = { page: 2, limit: 5, search: 'ner', searchFields: 'name' };
    await controller.registry(query as never);
    expect(listRegistry).toHaveBeenCalledWith(query);
  });
});
