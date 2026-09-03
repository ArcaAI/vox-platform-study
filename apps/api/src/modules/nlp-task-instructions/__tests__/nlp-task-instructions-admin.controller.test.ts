/**
 * NlpTaskInstructionsAdminController unit tests.
 *
 * CASL `@CanRead/@CanManage` + `If-Match`/`@RequiresIfMatch` are exercised by
 * the guard/interceptor (+ e2e). These specs cover the controller's OWN
 * logic: taskKey validation (400), tenant vs. super-admin scoping, and
 * If-Match-over-body version precedence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TENANT_NLP_INSTRUCTION_TASK_KEYS } from '@arcaai/applications';
import { NlpTaskInstructionsAdminController } from '../nlp-task-instructions-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = { getRow: vi.fn(), upsertRow: vi.fn() };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new NlpTaskInstructionsAdminController(service as never, cls as never);
  return { controller, service };
}

describe('NlpTaskInstructionsAdminController — taskKey validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s an unknown taskKey on GET row', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow('nlp.classification')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getRow).not.toHaveBeenCalled();
  });

  it('400s a missing taskKey on GET row', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow(undefined as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getRow).not.toHaveBeenCalled();
  });

  it('400s an unknown taskKey on PUT row', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.upsertRow({ instructionsJson: ['a'] }, 0, 'nlp.ner', undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.upsertRow).not.toHaveBeenCalled();
  });

  it.each(TENANT_NLP_INSTRUCTION_TASK_KEYS)('accepts %s on GET row', async (taskKey) => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getRow.mockResolvedValue({ tenantId: 't1', taskKey, instructionsJson: null, version: 0 });
    await expect(controller.getRow(taskKey)).resolves.toBeDefined();
    expect(service.getRow).toHaveBeenCalledWith(taskKey, 't1');
  });
});

describe('NlpTaskInstructionsAdminController — tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tenant admin is pinned to their own tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getRow.mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.topic', instructionsJson: null, version: 0 });
    await controller.getRow('nlp.topic');
    expect(service.getRow).toHaveBeenCalledWith('nlp.topic', 't1');
  });

  it('super admin must pass ?tenantId= (or a working tenant elevated into CLS)', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    await expect(controller.getRow('nlp.topic')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getRow).not.toHaveBeenCalled();
  });

  it('super admin can target an explicit tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    service.getRow.mockResolvedValue({ tenantId: 'other', taskKey: 'nlp.topic', instructionsJson: null, version: 0 });
    await controller.getRow('nlp.topic', 'other');
    expect(service.getRow).toHaveBeenCalledWith('nlp.topic', 'other');
  });
});

describe('NlpTaskInstructionsAdminController — PUT row If-Match precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match-derived expectedVersion over a body-supplied one', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.topic', instructionsJson: ['a'], version: 2 });

    await controller.upsertRow({ instructionsJson: ['a'], expectedVersion: 99 }, 1, 'nlp.topic', undefined);

    expect(service.upsertRow).toHaveBeenCalledWith('nlp.topic', expect.objectContaining({ expectedVersion: 1 }), 't1');
  });

  it('falls back to the body expectedVersion when no If-Match header value is parsed', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.intent', instructionsJson: ['a'], version: 1 });

    await controller.upsertRow({ instructionsJson: ['a'], expectedVersion: 0 }, undefined, 'nlp.intent', undefined);

    expect(service.upsertRow).toHaveBeenCalledWith('nlp.intent', expect.objectContaining({ expectedVersion: 0 }), 't1');
  });
});
