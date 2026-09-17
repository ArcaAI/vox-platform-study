/**
 * TASK-965 WS-2 — the three new workflow-definition routes: `GET …/lineages` (OD-965-3),
 * `POST …/:id/activate` (OD-965-1) and `POST …/:id/deprecate` (OD-965-2).
 *
 * The declaration-ORDER assertion is the one that would otherwise bite silently: Nest matches in
 * declaration order, so `lineages` below `:id` is read as a definition id and answers 404. The
 * controller already carries that discipline for `templates` and `slug/:slug/*`; this keeps it.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { WorkflowDefinitionController } from '../workflow-definition.controller';

function makeController() {
  const service = {
    listLineages: vi.fn(async (query: unknown) => ({ count: 0, limit: 10, page: 1, data: [], query })),
    activate: vi.fn(async (id: string) => ({ id, isActive: true, status: 'PUBLISHED' })),
    deprecate: vi.fn(async (id: string) => ({ id, isActive: false, status: 'DEPRECATED' })),
  };
  return { controller: new WorkflowDefinitionController(service as never, {} as never), service };
}

describe('WorkflowDefinitionController — lineage + lifecycle routes', () => {
  it('declares `lineages` ABOVE every `:id` route', () => {
    const declared = Object.getOwnPropertyNames(WorkflowDefinitionController.prototype);
    expect(declared).toContain('fetchLineages');
    expect(declared.indexOf('fetchLineages')).toBeLessThan(declared.indexOf('fetchById'));
    expect(Reflect.getMetadata('path', WorkflowDefinitionController.prototype.fetchLineages)).toBe('lineages');
  });

  it('declares activate and deprecate as state transitions (200), beside publish', () => {
    const proto = WorkflowDefinitionController.prototype;
    expect(Reflect.getMetadata('path', proto.activate)).toBe(':id/activate');
    expect(Reflect.getMetadata('path', proto.deprecate)).toBe(':id/deprecate');
    expect(Reflect.getMetadata('__httpCode__', proto.activate)).toBe(200);
    expect(Reflect.getMetadata('__httpCode__', proto.deprecate)).toBe(200);
  });

  it('inherits the class gate on all three: manage:WorkflowDefinition, off the API-key surface, on the svc scope', () => {
    const reflector = new Reflector();
    const proto = WorkflowDefinitionController.prototype;
    for (const handler of [proto.fetchLineages, proto.activate, proto.deprecate]) {
      expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, WorkflowDefinitionController])).toEqual([
        { action: 'manage', subject: 'WorkflowDefinition' },
      ]);
    }
    const values = Reflect.getMetadataKeys(WorkflowDefinitionController).map((key) => Reflect.getMetadata(key, WorkflowDefinitionController));
    expect(values).toContainEqual(['svc:admin:workflow-definition:manage']);
  });

  it('delegates each verb to the service', async () => {
    const { controller, service } = makeController();
    const query = { page: 1, limit: 20, paletteKey: 'core' } as never;

    await controller.fetchLineages(query);
    expect(service.listLineages).toHaveBeenCalledWith(query);

    await controller.activate('wf-1');
    expect(service.activate).toHaveBeenCalledWith('wf-1');

    await controller.deprecate('wf-1');
    expect(service.deprecate).toHaveBeenCalledWith('wf-1');
  });
});
