/**
 * TASK-863 — AgentAdminController / AgentAssignmentAdminController: route metadata the boot
 * audits read (admin path, manage:Agent, ForbidApiKey, svc scope), the If-Match fold, and
 * delegation of every lifecycle transition.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * TASK-884 — the four portability routes. Route SHAPE and delegation only: the behaviour they
 * delegate to (404-over-403 on a foreign source, the SUPER_ADMIN-only cross-tenant clone, the
 * 404 for an unmanaged sync target, the named 409s) is proven at the service, in
 * `packages/applications/src/services/agent/__tests__/agent.portability.task884.test.ts`.
 */
describe('AgentAdminController — portability (TASK-884)', () => {
  function makePortable() {
    const service = {
      clone: vi.fn(async (slug: string, dto: unknown) => ({ slug, dto })),
      exportBySlug: vi.fn(async (slug: string, version?: number) => ({ kind: 'agent', source: { slug, version } })),
      importBundle: vi.fn(async (dto: unknown) => ({ dto })),
      syncToTenants: vi.fn(async (slug: string, dto: unknown) => ({ slug, dto })),
    };
    return { controller: new AgentAdminController(service as never), service };
  }

  it('addresses clone / export / sync by the lineage SLUG, and mounts import at a static path', () => {
    const proto = AgentAdminController.prototype;
    expect(Reflect.getMetadata('path', proto.importBundle)).toBe('import');
    expect(Reflect.getMetadata('path', proto.exportBySlug)).toBe(':slug/export');
    expect(Reflect.getMetadata('path', proto.clone)).toBe(':slug/clone');
    expect(Reflect.getMetadata('path', proto.sync)).toBe(':slug/sync');
  });

  it('creates (201) on clone and import, and answers 200 on the sync report', () => {
    const proto = AgentAdminController.prototype;
    expect(Reflect.getMetadata('__httpCode__', proto.clone)).toBeUndefined();
    expect(Reflect.getMetadata('__httpCode__', proto.importBundle)).toBeUndefined();
    expect(Reflect.getMetadata('__httpCode__', proto.sync)).toBe(200);
  });

  it('inherits the class gate: manage:Agent, off the API-key surface, on the svc scope', () => {
    const permissions = new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [AgentAdminController.prototype.sync, AgentAdminController]);
    expect(permissions).toEqual([{ action: 'manage', subject: 'Agent' }]);
  });

  it('delegates each verb, parsing the export version query as a number', async () => {
    const { controller, service } = makePortable();
    await controller.clone('platform-summarization', { newSlug: 'clinic-notes' });
    await controller.exportBySlug('clinic-notes', '3');
    await controller.exportBySlug('clinic-notes');
    await controller.importBundle({ bundle: { kind: 'agent' } });
    await controller.sync('clinic-notes', { targetTenantIds: ['t2'] });

    expect(service.clone).toHaveBeenCalledWith('platform-summarization', { newSlug: 'clinic-notes' });
    expect(service.exportBySlug).toHaveBeenNthCalledWith(1, 'clinic-notes', 3);
    expect(service.exportBySlug).toHaveBeenNthCalledWith(2, 'clinic-notes', undefined);
    expect(service.importBundle).toHaveBeenCalledWith({ bundle: { kind: 'agent' } });
    expect(service.syncToTenants).toHaveBeenCalledWith('clinic-notes', { targetTenantIds: ['t2'] });
  });

  // Both routes' real gate is imperative, so the AUTH-NOTE marker is the only thing telling the
  // next reader that the class decorator understates it (rule 05 §Imperative Privilege Checks).
  it('carries the AUTH-NOTE marker on the two routes whose gate the decorator understates', () => {
    const source = readFileSync(join(__dirname, '..', 'agent-admin.controller.ts'), 'utf8');
    // The marker itself, not the class docstring that also names it.
    const markers = source.match(/^\s*\/\/ AUTH-NOTE:/gm) ?? [];
    expect(markers).toHaveLength(2);
    expect(source).toContain('SUPER_ADMIN-only');
    expect(source).toContain('answers 404, NOT 403');
  });
});
