/**
 * The consultation history read plane: admin `admin/consultations/:id/{activity,items/...}` and
 * business `consultations/:id/{history,encounters/:seq/recap}`.
 *
 *  - route metadata: admin routes forbid API keys and need the admin service scope; business routes
 *    carry the session-read scopes;
 *  - the query DTO is validated by the global pipe (cursor, limit bounds, kinds, grouping);
 *  - handlers delegate to the history service with the right plane flag;
 *  - the business plane refuses a doctor who does not own the consultation, and answers 404 for a
 *    consultation that is not in the caller's tenant.
 */
import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import { API_KEY_FORBIDDEN, ConsultationActivityQuery, ItemRunsQuery, ItemVersionDiffQuery } from '@arcaai/applications';
import { createGlobalValidationPipe } from '../../../filters/validation-violations';
import { AdminConsultationHistoryController } from '../admin-consultation-history.controller';
import { ConsultationAccessHelper } from '../../consultation/consultation-access.helper';
import { ConsultationHistoryController } from '../consultation-history.controller';

async function validate<T>(metatype: new () => T, value: unknown): Promise<T> {
  return createGlobalValidationPipe().transform(plainToInstance(metatype, value), { type: 'query', metatype } as never) as Promise<T>;
}

const meta = (key: string, target: object) => Reflect.getMetadata(key, target);

function history() {
  return {
    getActivity: vi.fn().mockResolvedValue({ items: [] }),
    listItemVersions: vi.fn().mockResolvedValue([]),
    getItemVersion: vi.fn().mockResolvedValue({}),
    diffItemVersions: vi.fn().mockResolvedValue({}),
    listItemRuns: vi.fn().mockResolvedValue([]),
    getRecap: vi.fn().mockResolvedValue({}),
  };
}

describe('route metadata', () => {
  it('the admin controller forbids API keys and needs the admin service scope', () => {
    expect(meta(API_KEY_FORBIDDEN, AdminConsultationHistoryController)).toBeTruthy();
    expect(
      JSON.stringify(Reflect.getMetadataKeys(AdminConsultationHistoryController).map((k) => meta(k, AdminConsultationHistoryController))),
    ).toContain('svc:admin:consultation-admin:manage');
    expect(meta('path', AdminConsultationHistoryController)).toBe('admin/consultations');
  });

  it('every admin route is a GET with a distinct path', () => {
    const proto = AdminConsultationHistoryController.prototype;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => meta('path', proto[name as keyof typeof proto] as object));
    expect(paths.sort()).toEqual(
      [
        ':id/activity',
        ':id/items/:itemId/runs',
        ':id/items/:itemId/versions',
        ':id/items/:itemId/versions/:n',
        ':id/items/:itemId/versions/:n/diff',
      ].sort(),
    );
  });

  it('the business controller carries the session-read scopes on every route', () => {
    const proto = ConsultationHistoryController.prototype;
    for (const name of ['getHistory', 'getRecap'] as const) {
      const keys = Reflect.getMetadataKeys(proto[name]).map((k) => JSON.stringify(meta(k, proto[name])));
      expect(keys.join('|')).toContain('consultation:session:read');
      expect(keys.join('|')).toContain('svc:consultation:session:read');
    }
    expect(meta('path', ConsultationHistoryController)).toBe('consultations');
  });
});

describe('query validation', () => {
  it('accepts a full valid query and coerces numbers, booleans and csv', async () => {
    const query = await validate(ConsultationActivityQuery, {
      cursor: 'abc',
      limit: '100',
      kinds: 'NOTE,TRANSCRIPT_SEGMENT',
      encounterSeq: '2',
      edited: 'true',
      grouping: 'none',
    });
    expect(query).toMatchObject({ limit: 100, kinds: ['NOTE', 'TRANSCRIPT_SEGMENT'], encounterSeq: 2, edited: true, grouping: 'none' });
  });

  it.each([{ limit: '101' }, { limit: '0' }, { kinds: 'NOPE' }, { grouping: 'x' }, { smuggled: '1' }])('refuses %j', async (bad) => {
    await expect(validate(ConsultationActivityQuery, bad)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the diff needs a positive `against`; the runs filter is optional but bounded', async () => {
    await expect(validate(ItemVersionDiffQuery, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate(ItemVersionDiffQuery, { against: '2' })).resolves.toMatchObject({ against: 2 });
    await expect(validate(ItemRunsQuery, { version: '0' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate(ItemRunsQuery, {})).resolves.toBeDefined();
  });
});

describe('admin delegation', () => {
  it('passes the admin plane flag and the right arguments', async () => {
    const service = history();
    const controller = new AdminConsultationHistoryController(service as never);
    const query = { limit: 10, kinds: ['NOTE'] } as never;

    await controller.getActivity('c1', query);
    expect(service.getActivity).toHaveBeenCalledWith('c1', query, { admin: true });

    await controller.listVersions('c1', 'i1');
    expect(service.listItemVersions).toHaveBeenCalledWith('c1', 'i1', { admin: true });

    await controller.getVersion('c1', 'i1', 3);
    expect(service.getItemVersion).toHaveBeenCalledWith('c1', 'i1', 3, { admin: true });

    await controller.diff('c1', 'i1', 3, { against: 2 });
    expect(service.diffItemVersions).toHaveBeenCalledWith('c1', 'i1', 3, 2, { admin: true });

    await controller.listRuns('c1', 'i1', { version: 2 });
    expect(service.listItemRuns).toHaveBeenCalledWith('c1', 'i1', 2, { admin: true });
  });

  it('refuses a version number below 1', async () => {
    const controller = new AdminConsultationHistoryController(history() as never);
    await expect(controller.getVersion('c1', 'i1', 0)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('business plane', () => {
  function build(options: { consultation?: unknown; user?: unknown; serviceAccount?: unknown; canRead?: boolean; sharing?: boolean; shares?: boolean }) {
    const service = history();
    const consultations = {
      getById: vi.fn().mockResolvedValue(options.consultation === undefined ? { doctorId: 'doc-1', patientId: 'p1' } : options.consultation),
      doctorHasPatientRelationship: vi.fn().mockResolvedValue(options.shares ?? false),
    };
    const store: Record<string, unknown> = { user: options.user, serviceAccount: options.serviceAccount, userAbility: {}, tenantId: 't1' };
    const cls = { get: (key: string) => store[key] };
    const policy = { can: vi.fn().mockReturnValue(options.canRead ?? false) };
    const settings = { resolve: vi.fn().mockReturnValue({ value: options.sharing ?? false }) };
    const access = new ConsultationAccessHelper(consultations as never, cls as never, policy as never, settings as never);
    const controller = new ConsultationHistoryController(service as never, access);
    return { controller, service, consultations, policy };
  }

  it('lets the owning doctor read, on the business plane', async () => {
    const { controller, service } = build({ user: { id: 'doc-1' } });
    await controller.getHistory('c1', {} as never);
    expect(service.getActivity).toHaveBeenCalledWith('c1', {}, { admin: false });
  });

  it('serves the recap for the owner', async () => {
    const { controller, service } = build({ user: { id: 'doc-1' } });
    await controller.getRecap('c1', 2);
    expect(service.getRecap).toHaveBeenCalledWith('c1', 2, { admin: false });
  });

  it('lets a service account through on tenant + scope alone', async () => {
    const { controller, service } = build({ serviceAccount: { id: 'sa' } });
    await controller.getHistory('c1', {} as never);
    expect(service.getActivity).toHaveBeenCalled();
  });

  it('lets a non-owner holding read:Consultation through', async () => {
    const { controller, policy } = build({ user: { id: 'other' }, canRead: true });
    await controller.getHistory('c1', {} as never);
    expect(policy.can).toHaveBeenCalled();
  });

  it('refuses a non-owner without the ability (403) and never reads', async () => {
    const { controller, service } = build({ user: { id: 'other' }, canRead: false });
    await expect(controller.getHistory('c1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getActivity).not.toHaveBeenCalled();
  });

  it('lets a shared-patient doctor read while tenant sharing is on, like GET consultations/:id', async () => {
    const { controller, service } = build({ user: { id: 'other' }, sharing: true, shares: true });
    await controller.getHistory('c1', {} as never);
    expect(service.getActivity).toHaveBeenCalled();
  });

  it('refuses a shared-patient doctor when tenant sharing is off', async () => {
    const { controller } = build({ user: { id: 'other' }, sharing: false, shares: true });
    await expect(controller.getHistory('c1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 when the consultation is not in the tenant', async () => {
    const { controller, service } = build({ consultation: null, user: { id: 'doc-1' } });
    await expect(controller.getHistory('c1', {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.getActivity).not.toHaveBeenCalled();
  });

  it('refuses an encounter sequence below 1', async () => {
    const { controller } = build({ user: { id: 'doc-1' } });
    await expect(controller.getRecap('c1', 0)).rejects.toBeInstanceOf(BadRequestException);
  });
});
