/**
 * TASK-1045 lane CG-API — feedback routes + admin rollups. Thin shells over the feedback service:
 * read-access check first (404 cross-tenant), caller derived from the request credential,
 * Idempotency-Key passed through, 412/409 propagate untouched.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { API_KEY_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { ConsultationFeedbackController, FeedbackListQuery } from '../consultation-feedback.controller';
import { AdminFeedbackRollupController, FeedbackRollupQuery } from '../admin-feedback-rollup.controller';
import { ConsultationAccessHelper } from '../consultation-access.helper';

function makeController() {
  const access = {
    assertRead: vi.fn().mockResolvedValue(undefined),
    callerOf: vi.fn().mockReturnValue({ userId: 'u-1', isMachine: false }),
  };
  const service = {
    create: vi.fn().mockResolvedValue({ id: 'f-1' }),
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    reasonCodes: vi.fn().mockResolvedValue({ items: [], source: 'system' }),
  };
  const cls = { get: vi.fn().mockReturnValue('t-1') };
  return { controller: new ConsultationFeedbackController(access as never, service as never, cls as never), access, service };
}

describe('ConsultationFeedbackController', () => {
  it('declares the three routes; reason-codes is registered before :id/feedback', () => {
    const proto = ConsultationFeedbackController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, proto.create)).toBe(':id/feedback');
    expect(Reflect.getMetadata(PATH_METADATA, proto.list)).toBe(':id/feedback');
    expect(Reflect.getMetadata(PATH_METADATA, proto.reasonCodes)).toBe('feedback/reason-codes');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.create)).toBe(201);
    const order = Object.getOwnPropertyNames(proto);
    expect(order.indexOf('reasonCodes')).toBeLessThan(order.indexOf('list'));
  });

  it('create: read access, caller from the request, Idempotency-Key through', async () => {
    const { controller, access, service } = makeController();
    const req = { user: { id: 'u-1' } } as never;
    const body = { rating: 'up', target: { kind: 'NOTE', contextItemId: 'ci-1' } } as never;
    const out = await controller.create('c-1', body, 'key-1', req);
    expect(access.assertRead).toHaveBeenCalledWith('c-1');
    expect(access.callerOf).toHaveBeenCalledWith(req);
    expect(service.create).toHaveBeenCalledWith('c-1', body, 'key-1', { userId: 'u-1', isMachine: false });
    expect(out).toEqual({ id: 'f-1' });
  });

  it('create: 404 stops before the service; 409 and 412 from the service propagate', async () => {
    const { controller, access, service } = makeController();
    access.assertRead.mockRejectedValueOnce(new NotFoundException());
    await expect(controller.create('c-x', {} as never, undefined, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.create).not.toHaveBeenCalled();
    service.create.mockRejectedValueOnce(new ConflictException('CONSULTATION_APPROVED'));
    await expect(controller.create('c-1', {} as never, undefined, {} as never)).rejects.toBeInstanceOf(ConflictException);
    service.create.mockRejectedValueOnce(new PreconditionFailedException());
    await expect(controller.create('c-1', {} as never, undefined, {} as never)).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it('list: read access then filters through', async () => {
    const { controller, access, service } = makeController();
    const q = Object.assign(new FeedbackListQuery(), { targetKind: 'NOTE', includeHistory: true, limit: 5 });
    await controller.list('c-1', q);
    expect(access.assertRead).toHaveBeenCalledWith('c-1');
    expect(service.list).toHaveBeenCalledWith('c-1', { targetKind: 'NOTE', contextItemId: undefined, includeHistory: true, cursor: undefined, limit: 5 });
  });

  it('reasonCodes resolves for the request tenant', async () => {
    const { controller, service } = makeController();
    await controller.reasonCodes();
    expect(service.reasonCodes).toHaveBeenCalledWith('t-1');
  });

  it('list query coerces string flags and rejects a bad target kind', async () => {
    const ok = plainToInstance(FeedbackListQuery, { includeHistory: 'true', limit: '10', targetKind: 'SECTION' });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.includeHistory).toBe(true);
    expect(ok.limit).toBe(10);
    expect((await validate(plainToInstance(FeedbackListQuery, { targetKind: 'BOGUS' }))).length).toBeGreaterThan(0);
  });
});

describe('AdminFeedbackRollupController', () => {
  it('is admin-plane: API keys forbidden, svc admin scope, GET admin/feedback/rollups', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminFeedbackRollupController)).toBe('admin/feedback');
    expect(Reflect.getMetadata(PATH_METADATA, AdminFeedbackRollupController.prototype.rollups)).toBe('rollups');
    expect(Reflect.getMetadata(API_KEY_FORBIDDEN, AdminFeedbackRollupController)).toBe(true);
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, AdminFeedbackRollupController)).toEqual(['svc:admin:consultation-admin:manage']);
  });

  it('delegates to the reader with the parsed groupBy list', async () => {
    const reader = { query: vi.fn().mockResolvedValue({ rows: [], truncated: false }) };
    const controller = new AdminFeedbackRollupController(reader as never);
    const q = plainToInstance(FeedbackRollupQuery, { from: '2026-10-01', to: '2026-10-05', groupBy: 'day,reason', agentSlug: 'a' });
    expect(await validate(q)).toHaveLength(0);
    await controller.rollups(q);
    expect(reader.query).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05', groupBy: ['day', 'reason'], agentSlug: 'a', modelName: undefined });
  });

  it('rejects an unknown groupBy dimension', async () => {
    const q = plainToInstance(FeedbackRollupQuery, { groupBy: 'day,patient' });
    expect((await validate(q)).length).toBeGreaterThan(0);
  });
});

describe('ConsultationAccessHelper', () => {
  function helper(opts: { consultation?: unknown; user?: string; sa?: string; can?: boolean; sharing?: boolean; related?: boolean }) {
    const store: Record<string, unknown> = { tenantId: 't-1', user: opts.user ? { id: opts.user } : undefined, serviceAccount: opts.sa ? { id: opts.sa } : undefined, userAbility: {} };
    const consultations = {
      getById: vi.fn().mockResolvedValue(opts.consultation === undefined ? { doctorId: 'doc-1', patientId: 'p-1' } : opts.consultation),
      doctorHasPatientRelationship: vi.fn().mockResolvedValue(opts.related ?? false),
    };
    const policy = { can: vi.fn().mockReturnValue(opts.can ?? false) };
    const settings = { resolve: vi.fn().mockReturnValue({ value: opts.sharing ?? false }) };
    return new ConsultationAccessHelper(consultations as never, { get: (k: string) => store[k] } as never, policy as never, settings as never);
  }

  it('owner reads and writes; a missing consultation is 404', async () => {
    const h = helper({ user: 'doc-1' });
    await expect(h.assertRead('c')).resolves.toBeUndefined();
    await expect(h.assertWrite('c')).resolves.toBeUndefined();
    await expect(helper({ user: 'doc-1', consultation: null }).assertRead('c')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a service account passes on tenant + scope alone', async () => {
    const h = helper({ sa: 'sa-1' });
    await expect(h.assertRead('c')).resolves.toBeUndefined();
    await expect(h.assertWrite('c')).resolves.toBeUndefined();
  });

  it('a non-owner needs CASL (manage for write) or sharing (read only)', async () => {
    await expect(helper({ user: 'other' }).assertWrite('c')).rejects.toMatchObject({ status: 403 });
    await expect(helper({ user: 'other', can: true }).assertWrite('c')).resolves.toBeUndefined();
    await expect(helper({ user: 'other', sharing: true, related: true }).assertRead('c')).resolves.toBeUndefined();
    await expect(helper({ user: 'other', sharing: true, related: true }).assertWrite('c')).rejects.toMatchObject({ status: 403 });
  });

  it('callerOf classifies the three credential classes', () => {
    const h = helper({});
    expect(h.callerOf({ serviceAccount: { id: 's' } } as never)).toEqual({ serviceAccountId: 's', isMachine: true });
    expect(h.callerOf({ apiKey: { id: 'k', userId: 'u' } } as never)).toEqual({ apiKeyId: 'k', userId: 'u', isMachine: true });
    expect(h.callerOf({ user: { id: 'u' } } as never)).toEqual({ userId: 'u', isMachine: false });
  });
});
