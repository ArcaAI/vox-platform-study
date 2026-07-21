/**
 * AudioPipelinePublicController
 *
 * Public (non-admin) pipeline read endpoints must exist so the SDK can
 * resolve a pipeline by id or slug without `manage:AsrPipeline` privileges.
 * The PipelineService enforces tenant-scoping, so this controller is
 * intentionally thin — it only validates that the routes exist, are wired to
 * the service, and translate `null` into `404`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { AudioPipelinePublicController } from '../audio-pipeline-public.controller';

describe('AudioPipelinePublicController — TASK-298 D-8', () => {
  let pipelineService: any;
  let controller: AudioPipelinePublicController;

  beforeEach(() => {
    pipelineService = {
      getAll: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      getBySlug: vi.fn(),
    };
    controller = new AudioPipelinePublicController(pipelineService);
  });

  it('class-level @Controller path stays audio/pipelines', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelinePublicController);
    expect(path).toBe('audio/pipelines');
  });

  it('exposes GET :id (fetchById)', () => {
    const handler = (AudioPipelinePublicController.prototype as any).fetchById;
    expect(typeof handler).toBe('function');

    const path = Reflect.getMetadata(PATH_METADATA, handler);
    const method = Reflect.getMetadata(METHOD_METADATA, handler);
    expect(path).toBe(':id');
    expect(method).toBe(RequestMethod.GET);
  });

  it('exposes GET slug/:slug (fetchBySlug)', () => {
    const handler = (AudioPipelinePublicController.prototype as any).fetchBySlug;
    expect(typeof handler).toBe('function');

    const path = Reflect.getMetadata(PATH_METADATA, handler);
    const method = Reflect.getMetadata(METHOD_METADATA, handler);
    expect(path).toBe('slug/:slug');
    expect(method).toBe(RequestMethod.GET);
  });

  it('fetchById returns the tenant-scoped pipeline from the service', async () => {
    const pipeline = { id: 'p-1', tenantId: 't-1', name: 'P1', slug: 'p-1' };
    pipelineService.getById.mockResolvedValue(pipeline);

    const result = await controller.fetchById('p-1');

    expect(pipelineService.getById).toHaveBeenCalledWith('p-1');
    expect(result).toEqual(pipeline);
  });

  it('fetchById throws NotFoundException when service returns null (cross-tenant or missing)', async () => {
    pipelineService.getById.mockResolvedValue(null);

    await expect(controller.fetchById('p-cross')).rejects.toThrow(NotFoundException);
  });

  it('fetchBySlug returns the tenant-scoped pipeline from the service', async () => {
    const pipeline = { id: 'p-1', tenantId: 't-1', name: 'P1', slug: 'fast' };
    pipelineService.getBySlug.mockResolvedValue(pipeline);

    const result = await controller.fetchBySlug('fast');

    expect(pipelineService.getBySlug).toHaveBeenCalledWith('fast');
    expect(result).toEqual(pipeline);
  });

  it('fetchBySlug throws NotFoundException when service returns null', async () => {
    pipelineService.getBySlug.mockResolvedValue(null);

    await expect(controller.fetchBySlug('not-here')).rejects.toThrow(NotFoundException);
  });
});
