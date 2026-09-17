/**
 * TASK-965 WS-2 — the two new agent routes: `GET admin/agents/lineages` (OD-965-3) and
 * `POST admin/agents/:id/activate` (OD-965-1).
 *
 * The declaration-ORDER assertion is the one that would otherwise bite silently: Nest matches
 * routes in the order their handlers are declared, so a `lineages` literal declared BELOW
 * `:id` is swallowed by the parameterised route and the console gets a 404 for an id it never
 * sent.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { AgentAdminController } from '../agent-admin.controller';

function makeAdmin() {
  const service = {
    listLineages: vi.fn(async (query: unknown) => ({ count: 0, limit: 10, page: 1, data: [], query })),
    activate: vi.fn(async (id: string) => ({ id, isActive: true, status: 'PUBLISHED' })),
  };
  return { controller: new AgentAdminController(service as never), service };
}

describe('AgentAdminController — lineage routes', () => {
  it('declares `lineages` ABOVE every `:id` route, so the literal is not swallowed by the parameter', () => {
    const declared = Object.getOwnPropertyNames(AgentAdminController.prototype);
    expect(declared).toContain('fetchLineages');
    expect(declared.indexOf('fetchLineages')).toBeLessThan(declared.indexOf('fetchById'));
    expect(Reflect.getMetadata('path', AgentAdminController.prototype.fetchLineages)).toBe('lineages');
  });

  it('declares activate as a state transition (200), beside publish/deprecate', () => {
    const proto = AgentAdminController.prototype;
    expect(Reflect.getMetadata('path', proto.activate)).toBe(':id/activate');
    expect(Reflect.getMetadata('__httpCode__', proto.activate)).toBe(200);
  });

  it('inherits the class gate on both routes: manage:Agent, off the API-key surface, on the svc scope', () => {
    const reflector = new Reflector();
    for (const handler of [AgentAdminController.prototype.fetchLineages, AgentAdminController.prototype.activate]) {
      expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, AgentAdminController])).toEqual([{ action: 'manage', subject: 'Agent' }]);
    }
    const values = Reflect.getMetadataKeys(AgentAdminController).map((key) => Reflect.getMetadata(key, AgentAdminController));
    expect(values).toContainEqual(['svc:admin:agent:manage']);
  });

  it('delegates the query object verbatim and the id to the service', async () => {
    const { controller, service } = makeAdmin();
    const query = { page: 1, limit: 20, task: 'TEXT_GENERATION' } as never;

    await controller.fetchLineages(query);
    expect(service.listLineages).toHaveBeenCalledWith(query);

    const activated = await controller.activate('agent-1');
    expect(service.activate).toHaveBeenCalledWith('agent-1');
    expect(activated).toMatchObject({ isActive: true });
  });
});
