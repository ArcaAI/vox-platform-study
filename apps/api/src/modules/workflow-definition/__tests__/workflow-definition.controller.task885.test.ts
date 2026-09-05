/**
 * TASK-885 — the four routes this lane adds to `WorkflowDefinitionController`.
 *
 * The route-level authorization CONFORMANCE of all 656 routes is generated
 * (`tests/e2e/task-776-route-authz-matrix.spec.ts` off `route-manifest.json`), so nothing here
 * restates "an API key gets a 403". What this file pins is what a matrix cannot express:
 *
 *   - the two cross-tenant routes carry the mandatory `AUTH-NOTE` marker, because their real
 *     gate is imperative and the class decorator UNDERSTATES it (`05-nestjs-api.md`
 *     §Imperative Privilege Checks);
 *   - the slug-keyed route is mounted under the `slug/` prefix, not as a bare `:slug`, so a
 *     caller who passes an id gets a clean miss rather than a lookup of a workflow named after
 *     a UUID;
 *   - each route delegates to the service verb it claims to.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { WorkflowDefinitionController } from '../workflow-definition.controller';

const CONTROLLER_SOURCE = readFileSync(join(__dirname, '..', 'workflow-definition.controller.ts'), 'utf8');

function makeController() {
  const service = {
    exportDefinition: vi.fn().mockResolvedValue({ kind: 'workflow-definition', schemaVersion: 1 }),
    importDefinition: vi.fn().mockResolvedValue({ id: 'def-9' }),
    syncToTenants: vi.fn().mockResolvedValue({ slug: 'soap', sourceVersionNumber: 2, targets: [] }),
    promoteToSystem: vi.fn().mockResolvedValue({ promotionId: 'promo-1', published: true }),
  };
  return { controller: new WorkflowDefinitionController(service as never, {} as never), service };
}

describe('WorkflowDefinitionController — TASK-885 routes', () => {
  it('mounts export, import, sync and promote-to-system on the expected verbs and paths', () => {
    const proto = WorkflowDefinitionController.prototype as unknown as Record<string, object>;
    const route = (method: string) => ({
      path: Reflect.getMetadata(PATH_METADATA, proto[method]),
      method: Reflect.getMetadata(METHOD_METADATA, proto[method]),
    });

    expect(route('export')).toEqual({ path: ':id/export', method: RequestMethod.GET });
    expect(route('import')).toEqual({ path: 'import', method: RequestMethod.POST });
    expect(route('promoteToSystem')).toEqual({ path: 'promote-to-system', method: RequestMethod.POST });
    // Slug-keyed, under the `slug/` prefix the webhook-secret route already established — the id
    // and the slug are different keys and the URL says which one it wants.
    expect(route('sync')).toEqual({ path: 'slug/:slug/sync', method: RequestMethod.POST });
  });

  it('carries the AUTH-NOTE marker on both routes whose real gate is imperative', () => {
    const promoteSection = CONTROLLER_SOURCE.slice(0, CONTROLLER_SOURCE.indexOf("@Post('promote-to-system')"));
    const syncSection = CONTROLLER_SOURCE.slice(0, CONTROLLER_SOURCE.indexOf("@Post('slug/:slug/sync')"));

    // The marker must be the LAST AUTH-NOTE before each decorator — i.e. it annotates that route.
    expect(promoteSection.lastIndexOf('AUTH-NOTE')).toBeGreaterThan(promoteSection.lastIndexOf("@Post('import')"));
    expect(syncSection.lastIndexOf('AUTH-NOTE')).toBeGreaterThan(syncSection.lastIndexOf("@Post('promote-to-system')"));
  });

  it('delegates each route to the service verb it claims', async () => {
    const { controller, service } = makeController();

    await controller.export('def-1');
    expect(service.exportDefinition).toHaveBeenCalledWith('def-1');

    await controller.import({ targetSlug: 'imported', bundle: {} as never });
    expect(service.importDefinition).toHaveBeenCalledWith({ targetSlug: 'imported', bundle: {} });

    await controller.sync('soap', { sourceTenantId: 't-a', targetTenantIds: ['t-b'] });
    expect(service.syncToTenants).toHaveBeenCalledWith('soap', { sourceTenantId: 't-a', targetTenantIds: ['t-b'] });

    await controller.promoteToSystem({ sourceDefinitionSlug: 'soap' });
    expect(service.promoteToSystem).toHaveBeenCalledWith({ sourceDefinitionSlug: 'soap' });
  });

  it('documents each new route with a summary, a description and at least one 4xx (rule 05 §Documentation Surface)', () => {
    const proto = WorkflowDefinitionController.prototype as unknown as Record<string, object>;
    for (const method of ['export', 'import', 'sync', 'promoteToSystem']) {
      const operation = Reflect.getMetadata('swagger/apiOperation', proto[method]) as { summary?: string; description?: string };
      expect(operation?.summary, method).toBeTruthy();
      expect(operation?.description, method).toBeTruthy();
      const responses = Reflect.getMetadata('swagger/apiResponse', proto[method]) as Record<string, unknown>;
      expect(
        Object.keys(responses ?? {}).some((status) => Number(status) >= 400 && Number(status) < 500),
        method,
      ).toBe(true);
    }
  });
});
