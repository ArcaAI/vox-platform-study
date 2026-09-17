/**
 * AiModelAdminController
 *
 * Mirrors `audio-pipeline.controller.test.ts`: unit-level assertions on the
 * runtime decorator metadata (route paths/methods, class-level `@Authorize`)
 * and plain delegation to `AiModelService`, including the OCC `If-Match` fold.
 */
import { describe, it, expect, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod, HttpStatus } from '@nestjs/common';
import { AiModelAdminController } from '../ai-model-admin.controller';

// =============================================================================
// Authorization — super-admin only (manage:all)
// =============================================================================
describe('AiModelAdminController authorization metadata', () => {
  it('is decorated @Authorize(["manage","all"]) at class level (super-admin only)', () => {
    const meta = Reflect.getMetadata('required_permissions', AiModelAdminController);
    expect(meta).toBeDefined();
    expect(meta).toEqual(expect.arrayContaining([{ action: 'manage', subject: 'all' }]));
    // The registry is a super-admin plane: the tenant-scoped `manage:AiModel`
    // grant must no longer open this controller (console gates to manage:all).
    expect(JSON.stringify(meta)).not.toContain('"AiModel"');
  });

  it('class-level @Controller path is admin/ai-models', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AiModelAdminController);
    expect(path).toBe('admin/ai-models');
  });
});

// =============================================================================
// Route metadata — the OCC-guarded PATCH + the slug/delete routes
// =============================================================================
describe('AiModelAdminController route metadata', () => {
  it('update is bound to PATCH :id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.update)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.update)).toBe(RequestMethod.PATCH);
  });

  it('fetchBySlug is bound to GET slug/:slug', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.fetchBySlug)).toBe('slug/:slug');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.fetchBySlug)).toBe(RequestMethod.GET);
  });

  it('delete is bound to DELETE :id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.delete)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.delete)).toBe(RequestMethod.DELETE);
  });
});

// =============================================================================
// Delegation — thin controller, exact-tenant admin list
// =============================================================================
describe('AiModelAdminController delegation', () => {
  it('fetchAll delegates to getAllForAdmin (ENABLED+DISABLED, exact-tenant), not getAll', async () => {
    const getAllForAdmin = vi.fn().mockResolvedValue([
      { id: 'm1', resourceStatus: 'ENABLED' },
      { id: 'm2', resourceStatus: 'DISABLED' },
    ]);
    const getAll = vi.fn().mockResolvedValue([]);
    const controller = new AiModelAdminController({ getAllForAdmin, getAll } as never, {} as never, {} as never);

    const result = await controller.fetchAll();

    expect(getAllForAdmin).toHaveBeenCalledTimes(1);
    // The enabled-only `getAll` (public surface) must not back the admin grid.
    expect(getAll).not.toHaveBeenCalled();
    expect(result.map((m) => m.resourceStatus)).toContain('DISABLED');
  });

  it('create/fetchById/fetchBySlug/delete delegate to AiModelService', async () => {
    const svc = {
      create: vi.fn().mockResolvedValue({ id: 'm1' }),
      getById: vi.fn().mockResolvedValue({ id: 'm1' }),
      getBySlug: vi.fn().mockResolvedValue({ id: 'm1' }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as never;
    const controller = new AiModelAdminController(svc, {} as never, {} as never);

    await controller.create({ name: 'x' } as never);
    await controller.fetchById('m1');
    await controller.fetchBySlug('slug-1');
    await controller.delete('m1');

    expect((svc as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith({ name: 'x' });
    expect((svc as { getById: ReturnType<typeof vi.fn> }).getById).toHaveBeenCalledWith('m1');
    expect((svc as { getBySlug: ReturnType<typeof vi.fn> }).getBySlug).toHaveBeenCalledWith('slug-1');
    expect((svc as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith('m1');
  });
});

// =============================================================================
// OCC — the If-Match header folds over the body `expectedVersion`
// =============================================================================
describe('AiModelAdminController update — OCC If-Match fold', () => {
  const build = () => {
    const update = vi.fn().mockResolvedValue({ id: 'm1', name: 'Updated', version: 8 });
    return { controller: new AiModelAdminController({ update } as never, {} as never, {} as never), update };
  };

  it('forwards the body unchanged when If-Match header is absent (body wins)', async () => {
    const { controller, update } = build();
    await controller.update('m1', { name: 'Updated', expectedVersion: 7 } as never, undefined);
    expect(update).toHaveBeenCalledWith('m1', { name: 'Updated', expectedVersion: 7 });
  });

  it('folds the If-Match header into the body-field expectedVersion (header wins)', async () => {
    const { controller, update } = build();
    await controller.update('m1', { name: 'Updated', expectedVersion: 99 } as never, 7);
    expect(update).toHaveBeenCalledWith('m1', expect.objectContaining({ name: 'Updated', expectedVersion: 7 }));
  });

  it('returns the service result (including the bumped version) verbatim', async () => {
    const { controller, update } = build();
    const result = await controller.update('m1', { name: 'Updated', expectedVersion: 7 } as never, undefined);
    expect(result).toEqual(expect.objectContaining({ id: 'm1', version: 8 }));
  });
});

// =============================================================================
// Download action — route metadata + delegation
// =============================================================================
describe('AiModelAdminController download route metadata', () => {
  it('triggerDownload is bound to POST :id/download, HttpCode 202', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.triggerDownload)).toBe(':id/download');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.triggerDownload)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AiModelAdminController.prototype.triggerDownload)).toBe(HttpStatus.ACCEPTED);
  });

  it('getDownloadStatus is bound to GET :id/download', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.getDownloadStatus)).toBe(':id/download');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.getDownloadStatus)).toBe(RequestMethod.GET);
  });
});

describe('AiModelAdminController download delegation', () => {
  it('triggerDownload delegates to AiModelDownloadService.triggerDownload and returns its result verbatim', async () => {
    const triggerDownload = vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'DOWNLOADING' });
    const controller = new AiModelAdminController({} as never, { triggerDownload } as never, {} as never);

    const result = await controller.triggerDownload('m1');

    expect(triggerDownload).toHaveBeenCalledWith('m1');
    expect(result).toEqual({ jobId: 'job-1', status: 'DOWNLOADING' });
  });

  it('getDownloadStatus delegates to AiModelDownloadService.getDownloadStatus and returns its result verbatim', async () => {
    const getDownloadStatus = vi.fn().mockResolvedValue({
      status: 'DOWNLOADED',
      startedAt: null,
      finishedAt: null,
      fileSizeMb: 3350,
      sha256: 'abc',
      localPath: '/mnt/models-bucket/gemma4-e2b-it-qat/q4-0-451faffb5a16/',
      error: null,
    });
    const controller = new AiModelAdminController({} as never, { getDownloadStatus } as never, {} as never);

    const result = await controller.getDownloadStatus('m1');

    expect(getDownloadStatus).toHaveBeenCalledWith('m1');
    expect(result.status).toBe('DOWNLOADED');
    expect(result.localPath).toBe('/mnt/models-bucket/gemma4-e2b-it-qat/q4-0-451faffb5a16/');
  });
});

// =============================================================================
// TASK-860 — inventory + platform-default election
// =============================================================================
describe('AiModelAdminController inventory + platform-default (TASK-860)', () => {
  it('runInventory is bound to POST inventory and returns the report verbatim', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.runInventory)).toBe('inventory');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.runInventory)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AiModelAdminController.prototype.runInventory)).toBe(HttpStatus.OK);

    const report = { checkedAt: new Date(), counts: { available: 1, missing: 0, partial: 0, notApplicable: 0 }, rows: [], unregistered: [] };
    const runInventory = vi.fn().mockResolvedValue(report);
    const controller = new AiModelAdminController({} as never, {} as never, { runInventory } as never);

    expect(await controller.runInventory()).toBe(report);
    expect(runInventory).toHaveBeenCalledTimes(1);
  });

  it('setPlatformDefault is bound to PATCH :id/platform-default and delegates to AiModelService.setPlatformDefaultFor', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelAdminController.prototype.setPlatformDefault)).toBe(':id/platform-default');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelAdminController.prototype.setPlatformDefault)).toBe(RequestMethod.PATCH);

    const setPlatformDefaultFor = vi.fn().mockResolvedValue({ id: 'm1', isPlatformDefaultFor: ['SPEECH_TO_TEXT'] });
    const controller = new AiModelAdminController({ setPlatformDefaultFor } as never, {} as never, {} as never);

    const result = await controller.setPlatformDefault('m1', { tasks: ['SPEECH_TO_TEXT'] } as never);

    expect(setPlatformDefaultFor).toHaveBeenCalledWith('m1', { tasks: ['SPEECH_TO_TEXT'] });
    expect(result).toEqual(expect.objectContaining({ isPlatformDefaultFor: ['SPEECH_TO_TEXT'] }));
  });
});

// =============================================================================
// TASK-983 R1/R4 — the list route must accept the standard PaginatedQuery
// =============================================================================
/**
 * The defect: `list(@Query('page'), @Query('limit'))` bound TWO named params and
 * nothing else, so the grid's `search` / `searchFields` / `filters` / `sort`
 * were dropped by the framework before the handler ran — silently, because
 * individual `@Query('x')` bindings never trip `forbidNonWhitelisted`. The fix
 * is one whole-object `@Query() query: PaginatedQuery` binding, which is also
 * what makes the global validation pipe police the params.
 */
// `RouteParamtypes.QUERY`. The enum lives at `@nestjs/common/enums/route-paramtypes.enum`
// and is not re-exported from the package root, so the value is spelled out here
// rather than reached for through a deep internal path.
const QUERY_PARAMTYPE = 4;

describe('AiModelAdminController list — PaginatedQuery (TASK-983)', () => {
  it('binds ONE whole-object @Query (no named page/limit params)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AiModelAdminController, 'list') as Record<string, { index: number; data?: unknown }>;
    const queryArgs = Object.entries(args ?? {}).filter(([key]) => key.startsWith(`${QUERY_PARAMTYPE}:`));
    expect(queryArgs).toHaveLength(1);
    // `data === undefined` is what distinguishes `@Query()` from `@Query('page')`.
    expect(queryArgs[0][1].data).toBeUndefined();
  });

  it('documents search / searchFields / filters / sort alongside page / limit', () => {
    const params = (Reflect.getMetadata('swagger/apiParameters', AiModelAdminController.prototype.list) ?? []) as { name: string }[];
    const names = params.map((param) => param.name);
    expect(names).toEqual(expect.arrayContaining(['page', 'limit', 'search', 'searchFields', 'filters', 'sort']));
  });

  it('forwards the whole query — search, searchFields, filters and sort included — to AiModelService.list', async () => {
    const list = vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 3, totalPages: 0 });
    const controller = new AiModelAdminController({ list } as never, {} as never, {} as never);

    const query = { page: 1, limit: 3, search: 'whisper', searchFields: 'name,slug', filters: 'deploymentKind[in]:CLOUD', sort: 'name:desc' };
    await controller.list(query);

    expect(list).toHaveBeenCalledWith(query);
  });
});
