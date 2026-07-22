/**
 * Clone + resync route surface.
 *
 * Route-metadata + delegation tests in the house style (see
 * `audio-pipeline.controller.test.ts`): the controllers hold no logic, so what
 * matters is that the routes exist at the documented paths/verbs, carry the
 * right authorization posture, and pass through to the service unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AudioPipelineController } from '../audio-pipeline.controller';
import { TenantPipelineResyncController } from '../../tenant/tenant-pipeline-resync.controller';

describe('AudioPipelineController — clone route', () => {
  let pipelineService: any;
  let controller: AudioPipelineController;

  beforeEach(() => {
    pipelineService = {
      clone: vi.fn().mockResolvedValue({ id: 'new-1', slug: 'copy', templateLocked: false }),
    };
    controller = new AudioPipelineController(pipelineService);
  });

  it('exposes POST :id/clone', () => {
    const handler = (AudioPipelineController.prototype as any).clone;
    expect(typeof handler).toBe('function');

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/clone');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it('delegates to PipelineService.clone with the id and body', async () => {
    const body = { name: 'My Copy', slug: 'my-copy' };
    const result = await controller.clone('source-1', body as never);

    expect(pipelineService.clone).toHaveBeenCalledWith('source-1', body);
    expect(result).toEqual({ id: 'new-1', slug: 'copy', templateLocked: false });
  });

  // Cloning is explicitly NOT an OCC content edit — it creates a new row — so it
  // must not inherit the If-Match requirement that PATCH :id carries.
  it('does not require If-Match (it creates a row rather than editing one)', () => {
    const handler = (AudioPipelineController.prototype as any).clone;
    const requiresIfMatch = Reflect.getMetadata('requiresIfMatch', handler);
    expect(requiresIfMatch).toBeFalsy();
  });
});

describe('TenantPipelineResyncController — resync route', () => {
  let resyncService: any;
  let controller: TenantPipelineResyncController;

  beforeEach(() => {
    resyncService = {
      resyncTenant: vi.fn().mockResolvedValue({ added: 1, fastForwarded: 2, skipped: 6 }),
    };
    controller = new TenantPipelineResyncController(resyncService);
  });

  it('is mounted under the admin/tenants prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TenantPipelineResyncController)).toBe('admin/tenants');
  });

  it('exposes POST :id/pipelines/resync', () => {
    const handler = (TenantPipelineResyncController.prototype as any).resync;
    expect(typeof handler).toBe('function');

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/pipelines/resync');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it('returns the reconciliation summary from the service', async () => {
    const result = await controller.resync('tenant-42');

    expect(resyncService.resyncTenant).toHaveBeenCalledWith('tenant-42');
    expect(result).toEqual({ added: 1, fastForwarded: 2, skipped: 6 });
  });

  // Resync writes into an arbitrary tenant, so it is global-admin only —
  // same posture as tenant provisioning.
  it('is gated on manage:Tenant (global admin)', () => {
    const handler = (TenantPipelineResyncController.prototype as any).resync;
    const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);

    expect(permissions).toEqual([{ action: 'manage', subject: 'Tenant' }]);
  });
});
