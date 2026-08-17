/**
 * AiTaskDefaultAdminController unit tests.
 *
 * CASL `@CanRead/@CanManage` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ e2e). These specs cover the controller's OWN logic:
 * taskKey validation (400), the all-keys effective aggregation, tenant vs.
 * super-admin scoping, If-Match-over-body version precedence, and the
 * guardrail-governance ForbiddenException passthrough from the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AI_TASK_KEYS } from '@arcaai/applications';
import { AiTaskDefaultAdminController } from '../ai-task-default-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    getEffective: vi.fn(),
    getRow: vi.fn(),
    upsertRow: vi.fn(),
  };
  const aiModelService = {
    // r2605 Finding E — the options endpoint uses the shared-read variant (the
    // exact-tenant getByTaskType defeats the SYSTEM-shared-read widening).
    getByTaskTypeSharedRead: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new AiTaskDefaultAdminController(service as never, aiModelService as never, cls as never);
  return { controller, service, aiModelService };
}

describe('AiTaskDefaultAdminController — taskKey validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s an unknown taskKey on GET (effective)', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getEffective('not.a.task')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getEffective).not.toHaveBeenCalled();
  });

  it('400s an unknown taskKey on GET row', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow('guardrail.oops')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getRow).not.toHaveBeenCalled();
  });

  it('400s a missing taskKey on GET row (row addressing requires the key)', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow(undefined as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getRow).not.toHaveBeenCalled();
  });

  it('400s an unknown taskKey on PUT row', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.upsertRow({ modelSlug: 'medical-ner' }, 0, 'nope', undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.upsertRow).not.toHaveBeenCalled();
  });
});

describe('AiTaskDefaultAdminController — selectable model options', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s an unknown or missing taskKey', async () => {
    const { controller, aiModelService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getOptions('nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getOptions(undefined as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(aiModelService.getByTaskTypeSharedRead).not.toHaveBeenCalled();
  });

  it('lists ENABLED registry models via the SHARED-READ query (r2605 Finding E — [tenant, SYSTEM] visibility)', async () => {
    const { controller, aiModelService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    aiModelService.getByTaskTypeSharedRead.mockResolvedValue([
      { slug: 'medical-ner', resourceStatus: 'ENABLED', provider: 'built-in' },
      { slug: 'legacy-ner', resourceStatus: 'DELETED', provider: 'built-in' },
      { slug: 'disabled-ner', resourceStatus: 'DISABLED', provider: 'built-in' },
    ]);

    const options = await controller.getOptions('nlp.ner');

    expect(aiModelService.getByTaskTypeSharedRead).toHaveBeenCalledWith('TOKEN_CLASSIFICATION');
    expect(options.map((m) => m.slug)).toEqual(['medical-ner']);
  });

  it('maps guardrail.validate to the GUARDRAIL taskType', async () => {
    const { controller, aiModelService } = makeController({ user: SUPER, tenantId: 't1' });
    aiModelService.getByTaskTypeSharedRead.mockResolvedValue([]);

    await controller.getOptions('guardrail.validate');

    expect(aiModelService.getByTaskTypeSharedRead).toHaveBeenCalledWith('GUARDRAIL');
  });
});

describe('AiTaskDefaultAdminController — effective resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates a single taskKey to the service scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const effective = { tenantId: 't1', taskKey: 'nlp.ner', modelSlug: 'medical-ner', source: 'tenant', model: null };
    service.getEffective.mockResolvedValue(effective);

    await expect(controller.getEffective('nlp.ner')).resolves.toBe(effective);
    expect(service.getEffective).toHaveBeenCalledTimes(1);
    expect(service.getEffective).toHaveBeenCalledWith('nlp.ner', 't1');
  });

  it('aggregates ALL task keys (in AI_TASK_KEYS order) when taskKey is omitted', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getEffective.mockImplementation(async (taskKey: string) => ({ tenantId: 't1', taskKey, modelSlug: null, source: null, model: null }));

    const result = (await controller.getEffective()) as Array<{ taskKey: string }>;

    expect(Array.isArray(result)).toBe(true);
    expect(result.map((r) => r.taskKey)).toEqual([...AI_TASK_KEYS]);
    for (const key of AI_TASK_KEYS) {
      expect(service.getEffective).toHaveBeenCalledWith(key, 't1');
    }
  });
});

describe('AiTaskDefaultAdminController — tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins a tenant admin to their CLS tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getRow.mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.ner', version: 0 });
    await controller.getRow('nlp.ner');
    expect(service.getRow).toHaveBeenCalledWith('nlp.ner', 't1');
  });

  it('rejects a tenant admin targeting another tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow('nlp.ner', 't2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getRow).not.toHaveBeenCalled();
  });

  it('lets a super admin target any tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.getRow.mockResolvedValue({ tenantId: 't9', taskKey: 'guardrail.validate', version: 2 });
    await controller.getRow('guardrail.validate', 't9');
    expect(service.getRow).toHaveBeenCalledWith('guardrail.validate', 't9');
  });

  it('400s when a super admin omits ?tenantId= and has no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.getEffective('nlp.ner')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AiTaskDefaultAdminController — PUT row (OCC wiring + governance passthrough)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.ner', version: 3 });

    await controller.upsertRow({ modelSlug: 'medical-ner', expectedVersion: 1 }, 2, 'nlp.ner', undefined);

    expect(service.upsertRow).toHaveBeenCalledWith('nlp.ner', expect.objectContaining({ modelSlug: 'medical-ner', expectedVersion: 2 }), 't1');
  });

  it('falls back to the body expectedVersion when no If-Match header', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.ner', version: 1 });

    await controller.upsertRow({ modelSlug: 'medical-ner', expectedVersion: 0 }, undefined, 'nlp.ner', undefined);

    expect(service.upsertRow).toHaveBeenCalledWith('nlp.ner', expect.objectContaining({ expectedVersion: 0 }), 't1');
  });

  it('propagates the service-level guardrail governance ForbiddenException (403, deliberately not 404)', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockRejectedValue(new ForbiddenException('Guardrail model configuration is super-admin-only'));

    await expect(controller.upsertRow({ modelSlug: 'granite-guardian-4.1-8b' }, 0, 'guardrail.validate', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(service.upsertRow).toHaveBeenCalledWith('guardrail.validate', expect.objectContaining({ modelSlug: 'granite-guardian-4.1-8b' }), 't1');
  });

  it('scopes a super-admin PUT to the ?tenantId= target', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.upsertRow.mockResolvedValue({ tenantId: 't9', taskKey: 'guardrail.validate', version: 1 });

    await controller.upsertRow({ modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 }, 0, 'guardrail.validate', 't9');

    expect(service.upsertRow).toHaveBeenCalledWith('guardrail.validate', expect.objectContaining({ expectedVersion: 0 }), 't9');
  });
});
