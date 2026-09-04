/**
 * TASK-863 — AgentAdminController / AgentAssignmentAdminController: route metadata the boot
 * audits read (admin path, manage:Agent, ForbidApiKey, svc scope), the If-Match fold, and
 * delegation of every lifecycle transition.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { AgentAdminController } from '../agent-admin.controller';
import { AgentAssignmentAdminController } from '../agent-assignment-admin.controller';

function makeAdmin() {
  const service = {
    list: vi.fn(async () => []),
    getById: vi.fn(async (id: string) => ({ id })),
    listVersions: vi.fn(async () => []),
    create: vi.fn(async (dto: unknown) => dto),
    update: vi.fn(async (id: string, dto: unknown, expected?: number) => ({ id, dto, expected })),
    deleteById: vi.fn(async (id: string) => ({ id })),
    validate: vi.fn(async (id: string) => ({ id, status: 'VALIDATED' })),
    publish: vi.fn(async (id: string, dto: unknown) => ({ id, dto, status: 'PUBLISHED' })),
    newVersion: vi.fn(async (id: string, dto: unknown) => ({ parentVersionId: id, dto })),
    deprecate: vi.fn(async (id: string) => ({ id, status: 'DEPRECATED' })),
  };
  return { controller: new AgentAdminController(service as never), service };
}

describe('AgentAdminController — metadata', () => {
  it('mounts at admin/agents, gated by manage:Agent, off the API-key surface, on the derived svc scope', () => {
    expect(Reflect.getMetadata('path', AgentAdminController)).toBe('admin/agents');
    const permissions = new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [AgentAdminController.prototype.create, AgentAdminController]);
    expect(permissions).toEqual([{ action: 'manage', subject: 'Agent' }]);
    // Decorator metadata, read the way the boot audits read it: a `true` flag for the
    // API-key ban and the exact svc-scope list, whatever the key strings are named.
    const values = Reflect.getMetadataKeys(AgentAdminController).map((key) => Reflect.getMetadata(key, AgentAdminController));
    expect(values).toContainEqual(['svc:admin:agent:manage']);
    expect(values.filter((value) => value === true).length).toBeGreaterThanOrEqual(1);
  });

  it('declares the lifecycle routes as state transitions (200), not CAS writes', () => {
    const proto = AgentAdminController.prototype;
    expect(Reflect.getMetadata('path', proto.validate)).toBe(':id/validate');
    expect(Reflect.getMetadata('path', proto.publish)).toBe(':id/publish');
    expect(Reflect.getMetadata('path', proto.deprecate)).toBe(':id/deprecate');
    expect(Reflect.getMetadata('path', proto.newVersion)).toBe(':id/versions');
    expect(Reflect.getMetadata('__httpCode__', proto.validate)).toBe(200);
    expect(Reflect.getMetadata('__httpCode__', proto.publish)).toBe(200);
    expect(Reflect.getMetadata('__httpCode__', proto.deprecate)).toBe(200);
    expect(Reflect.getMetadata('__httpCode__', proto.newVersion)).toBeUndefined();
  });
});

describe('AgentAdminController — delegation', () => {
  it('PATCH folds the If-Match header over the body expectedVersion', async () => {
    const { controller, service } = makeAdmin();
    await controller.update('a1', { name: 'x', expectedVersion: 1 }, 7);
    expect(service.update).toHaveBeenCalledWith('a1', { name: 'x', expectedVersion: 7 }, 7);
    await controller.update('a1', { name: 'x', expectedVersion: 2 }, undefined);
    expect(service.update).toHaveBeenLastCalledWith('a1', { name: 'x', expectedVersion: 2 }, 2);
  });

  it('routes every lifecycle transition to the service', async () => {
    const { controller, service } = makeAdmin();
    await controller.validate('a1');
    await controller.publish('a1', { activate: false });
    await controller.newVersion('a1', { name: 'v2' });
    await controller.deprecate('a1');
    await controller.remove('a1');
    await controller.fetchAll('TEXT_GENERATION' as never, 'true');
    expect(service.validate).toHaveBeenCalledWith('a1');
    expect(service.publish).toHaveBeenCalledWith('a1', { activate: false });
    expect(service.newVersion).toHaveBeenCalledWith('a1', { name: 'v2' });
    expect(service.deprecate).toHaveBeenCalledWith('a1');
    expect(service.deleteById).toHaveBeenCalledWith('a1');
    expect(service.list).toHaveBeenCalledWith('TEXT_GENERATION', true);
  });
});

describe('AgentAssignmentAdminController', () => {
  it('reuses the Agent subject + svc scope and folds If-Match on PATCH/DELETE', async () => {
    expect(Reflect.getMetadata('path', AgentAssignmentAdminController)).toBe('admin/agent-assignments');
    const permissions = new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [AgentAssignmentAdminController.prototype.create, AgentAssignmentAdminController]);
    expect(permissions).toEqual([{ action: 'manage', subject: 'Agent' }]);
    const service = { list: vi.fn(async () => []), getById: vi.fn(), upsert: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) };
    const controller = new AgentAssignmentAdminController(service as never);
    const request = { scope: 'TENANT', task: 'SPEECH_TO_TEXT', agentSlug: 'x', expectedVersion: 1 } as never;
    await controller.update(request, 5);
    expect(service.upsert).toHaveBeenCalledWith(request, 5);
    await controller.remove('as1', 3, 'why');
    expect(service.remove).toHaveBeenCalledWith('as1', 3, 'why');
  });
});
