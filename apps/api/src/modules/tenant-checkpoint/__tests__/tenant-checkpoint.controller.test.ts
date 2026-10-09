/**
 * TenantCheckpointController — tenant pinning (404 for a foreign tenant on EVERY route), the
 * ability each handler declares, the credential-class bans, and lock-exemption on the GETs only.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  API_KEY_FORBIDDEN,
  CreateCheckpointRequest,
  ListCheckpointsQuery,
  REQUIRED_PERMISSIONS_KEY,
  RestoreCheckpointRequest,
  SERVICE_ACCOUNT_FORBIDDEN,
} from '@arcaai/applications';
import { TENANT_LOCK_EXEMPT_KEY } from '../../../decorators';
import { TenantCheckpointController } from '../tenant-checkpoint.controller';

const OWN = '1032a000-0000-4000-8000-000000001032';
const FOREIGN = '1032b000-0000-4000-8000-000000001032';

function make(user: { id: string; tenantId: string; roles: string[] }) {
  const service = {
    create: vi.fn(async () => ({})),
    list: vi.fn(async () => ({})),
    get: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
    downloadUrl: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    initUpload: vi.fn(async () => ({})),
    completeUpload: vi.fn(async () => ({})),
    abortUpload: vi.fn(async () => ({})),
    restore: vi.fn(async () => ({})),
    listRestores: vi.fn(async () => ({})),
    getRestore: vi.fn(async () => ({})),
  };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? user : undefined)) };
  return { controller: new TenantCheckpointController(service as never, cls as never), service };
}

type Call = (c: TenantCheckpointController, tenantId: string) => unknown;
const ROUTES: Record<string, Call> = {
  create: (c, t) => c.create(t, { label: 'x', includesMedia: true }),
  list: (c, t) => c.list(t, {}),
  get: (c, t) => c.get(t, 'id'),
  cancel: (c, t) => c.cancel(t, 'id'),
  downloadUrl: (c, t) => c.downloadUrl(t, 'id'),
  remove: (c, t) => c.remove(t, 'id'),
  initUpload: (c, t) => c.initUpload(t, { filename: 'a.hcp', sizeBytes: 1 }),
  completeUpload: (c, t) => c.completeUpload(t, 'u', { parts: [{ partNumber: 1, etag: 'e' }] }),
  abortUpload: (c, t) => c.abortUpload(t, 'u'),
  restore: (c, t) => c.restore(t, 'id', { categories: ['CONFIG_CONTENT'], reason: 'long enough reason', password: 'p', confirmationName: 'n' }),
  listRestores: (c, t) => c.listRestores(t, {}),
  getRestore: (c, t) => c.getRestore(t, 'r'),
};

describe('TenantCheckpointController — tenant pinning', () => {
  it.each(Object.keys(ROUTES))('a tenant admin calling another tenant\'s :tenantId → 404 on %s, service untouched', async (route) => {
    const { controller, service } = make({ id: 'u1', tenantId: OWN, roles: ['TENANT_ADMIN'] });
    await expect(Promise.resolve().then(() => ROUTES[route](controller, FOREIGN))).rejects.toBeInstanceOf(NotFoundException);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(Object.keys(ROUTES))('a tenant admin on their own tenant reaches the service on %s', async (route) => {
    const { controller, service } = make({ id: 'u1', tenantId: OWN, roles: ['TENANT_ADMIN'] });
    await ROUTES[route](controller, OWN);
    expect(Object.values(service).filter((fn) => fn.mock.calls.length > 0)).toHaveLength(1);
  });

  it('a super admin may act on any tenant', async () => {
    const { controller, service } = make({ id: 'u1', tenantId: OWN, roles: ['SUPER_ADMIN'] });
    await controller.get(FOREIGN, 'id');
    expect(service.get).toHaveBeenCalledWith(FOREIGN, 'id');
  });

  it('the upload id and restore body are passed through untouched', async () => {
    const { controller, service } = make({ id: 'u1', tenantId: OWN, roles: ['TENANT_ADMIN'] });
    const body = { categories: ['USERS_ACCESS' as const], reason: 'long enough reason', password: 'p', confirmationName: 'n' };
    await controller.restore(OWN, 'cp', body);
    expect(service.restore).toHaveBeenCalledWith(OWN, 'cp', body);
    await controller.completeUpload(OWN, 'S3-ID', { parts: [{ partNumber: 1, etag: 'e' }] });
    expect(service.completeUpload).toHaveBeenCalledWith(OWN, 'S3-ID', { parts: [{ partNumber: 1, etag: 'e' }] });
  });
});

describe('TenantCheckpointController — metadata the boot audits and guards read', () => {
  const reflector = new Reflector();
  const proto = TenantCheckpointController.prototype;
  const permission = (handler: keyof typeof proto) =>
    reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [proto[handler] as never, TenantCheckpointController]);

  it('mounts at admin/tenants/:tenantId/checkpoints', () => {
    expect(Reflect.getMetadata('path', TenantCheckpointController)).toBe('admin/tenants/:tenantId/checkpoints');
  });

  it.each([
    ['create', 'create'],
    ['initUpload', 'create'],
    ['completeUpload', 'create'],
    ['abortUpload', 'create'],
    ['list', 'read'],
    ['get', 'read'],
    ['downloadUrl', 'read'],
    ['listRestores', 'read'],
    ['getRestore', 'read'],
    ['cancel', 'update'],
    ['remove', 'delete'],
    ['restore', 'manage'],
  ] as const)('%s declares %s:TenantCheckpoint', (handler, action) => {
    expect(permission(handler)).toEqual([{ action, subject: 'TenantCheckpoint' }]);
  });

  it('the class bans API keys and service accounts', () => {
    expect(Reflect.getMetadata(API_KEY_FORBIDDEN, TenantCheckpointController)).toBe(true);
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_FORBIDDEN, TenantCheckpointController)).toBe(true);
  });

  it('only the GET handlers are lock-exempt; the class is not', () => {
    const exempt = (name: keyof typeof proto) => Reflect.getMetadata(TENANT_LOCK_EXEMPT_KEY, proto[name] as never) === true;
    for (const name of ['list', 'get', 'listRestores', 'getRestore'] as const) expect(exempt(name)).toBe(true);
    for (const name of ['create', 'cancel', 'downloadUrl', 'remove', 'initUpload', 'completeUpload', 'abortUpload', 'restore'] as const) {
      expect(exempt(name)).toBe(false);
    }
    expect(Reflect.getMetadata(TENANT_LOCK_EXEMPT_KEY, TenantCheckpointController)).toBeUndefined();
  });

  it('static paths are declared before :id', () => {
    const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && Reflect.getMetadata('path', proto[n as keyof typeof proto] as never) !== undefined);
    const paths = names.map((n) => ({ n, p: Reflect.getMetadata('path', proto[n as keyof typeof proto] as never) as string, m: Reflect.getMetadata('method', proto[n as keyof typeof proto] as never) as number }));
    const idx = (n: string) => names.indexOf(n);
    expect(idx('listRestores')).toBeLessThan(idx('get'));
    expect(idx('getRestore')).toBeLessThan(idx('get'));
    expect(paths.find((x) => x.n === 'initUpload')?.p).toBe('uploads');
  });
});

describe('request DTOs', () => {
  const errors = async (cls: new () => object, plain: object) => (await validate(plainToInstance(cls, plain))).map((e) => e.property);

  it('restore: categories must be non-empty, unique and known; reason ≤1000 (the 10-char minimum is the platform policy, enforced in the service — TASK-1057); password/name optional (428 comes from the service)', async () => {
    const ok = { categories: ['CONFIG_CONTENT'], reason: 'long enough reason' };
    expect(await errors(RestoreCheckpointRequest, ok)).toEqual([]);
    expect(await errors(RestoreCheckpointRequest, { ...ok, categories: [] })).toContain('categories');
    expect(await errors(RestoreCheckpointRequest, { ...ok, categories: ['CONFIG_CONTENT', 'CONFIG_CONTENT'] })).toContain('categories');
    expect(await errors(RestoreCheckpointRequest, { ...ok, categories: ['LOGS'] })).toContain('categories');
    expect(await errors(RestoreCheckpointRequest, { ...ok, reason: 'short' })).toEqual([]);
    expect(await errors(RestoreCheckpointRequest, { categories: ['CONFIG_CONTENT'] })).toEqual([]);
    expect(await errors(RestoreCheckpointRequest, { ...ok, reason: 'x'.repeat(1001) })).toContain('reason');
  });

  it('create: passphrase 12-256 characters', async () => {
    const ok = { label: 'x', includesMedia: true };
    expect(await errors(CreateCheckpointRequest, { ...ok, passphrase: 'short' })).toContain('passphrase');
    expect(await errors(CreateCheckpointRequest, { ...ok, passphrase: 'a'.repeat(12) })).toEqual([]);
    expect(await errors(CreateCheckpointRequest, { ...ok, passphrase: 'a'.repeat(257) })).toContain('passphrase');
  });

  it('list: search is 1-120 characters and kind is MANUAL or SAFETY', async () => {
    expect(await errors(ListCheckpointsQuery, { search: 'a'.repeat(121) })).toContain('search');
    expect(await errors(ListCheckpointsQuery, { search: '' })).toContain('search');
    expect(await errors(ListCheckpointsQuery, { kind: 'OTHER' })).toContain('kind');
    expect(await errors(ListCheckpointsQuery, { kind: 'SAFETY', search: 'nightly', page: '2', limit: '5' })).toEqual([]);
  });
});
