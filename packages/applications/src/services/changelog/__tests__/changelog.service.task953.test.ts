/**
 * TASK-953 — the authoring by-id read.
 *
 * `update` and `publish` both require `If-Match`, and this is the ONLY route
 * that hands the authoring client the `_version` to put in it. While it did not
 * exist, the console could create a DRAFT and then neither edit nor publish it,
 * so no release note could ever reach a tenant. These tests pin the three
 * properties that make it usable: DRAFT is visible, `version` is carried, and
 * the super-admin gate matches the rest of the authoring surface.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ChangelogAudience, ChangelogPublishStatus, ChangelogSeverity, SysEventType } from '@arcaai/domains';
import { ChangelogService } from '../changelog.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

type Ctx = {
  user?: { id: string; roles?: string[]; impersonatedBy?: string; tenantId?: string } | null;
  tenantId?: string | null;
};

const makeCls = (ctx: Ctx) => ({
  get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]),
});

const makeEntry = (over: Partial<Record<string, unknown>> = {}) => {
  const state: Record<string, unknown> = {
    id: 'entry-1',
    tenantId: SYSTEM_TENANT_ID,
    platformVersion: '2.2.0',
    title: 'HOPE 2.2.0',
    summary: 'Agents, workflows and the realtime consultation plane',
    body: '# body',
    severity: ChangelogSeverity.IMPORTANT,
    audience: ChangelogAudience.ALL,
    publishStatus: ChangelogPublishStatus.DRAFT,
    publishedAt: null,
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    version: 7,
    ...over,
  };
  return { ...state, changes: {}, hasChanges: true, validate: () => undefined, toObject: () => ({ ...state }) } as never;
};

function build(ctx: Ctx) {
  const entryRepo = {
    findAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findById: vi.fn().mockResolvedValue(makeEntry()),
    create: vi.fn(async (e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const ackRepo = { findAll: vi.fn().mockResolvedValue([]), createMany: vi.fn(), create: vi.fn() };
  const userRepo = { findById: vi.fn().mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1', createdAt: new Date('2020-01-01T00:00:00.000Z') }) };
  const emitter = { emit: vi.fn() };
  const service = new ChangelogService(entryRepo as never, ackRepo as never, userRepo as never, emitter as never, makeCls(ctx) as never);
  return { service, entryRepo, emitter };
}

const TENANT_ADMIN: Ctx = { user: { id: 'user-1', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' }, tenantId: 'tenant-1' };
const SUPER_ADMIN: Ctx = { user: { id: 'admin-1', roles: ['SUPER_ADMIN'] }, tenantId: null };

describe('ChangelogService — get (authoring by-id read)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries `version`, which is what the ETag/If-Match round trip is for', async () => {
    const { service } = build(SUPER_ADMIN);

    const result = await service.get('entry-1');

    // The ETagInterceptor stamps `ETag: "<version>"` off this field; a response
    // without it gets no ETag, and the client can never satisfy `If-Match`.
    expect(result.version).toBe(7);
  });

  it('returns a DRAFT — the authoring read is not the reader plane', async () => {
    const { service } = build(SUPER_ADMIN);

    const result = await service.get('entry-1');

    expect(result.publishStatus).toBe(ChangelogPublishStatus.DRAFT);
    expect(result.id).toBe('entry-1');
  });

  it('does not pin a tenantId on the read — SYSTEM rows widen via SYSTEM_SHARED_READ_MODELS', async () => {
    const { service, entryRepo } = build(SUPER_ADMIN);

    await service.get('entry-1');

    expect(entryRepo.findById).toHaveBeenCalledWith('entry-1');
  });

  it('refuses a tenant admin with 403 — a privilege boundary, not 404-over-403', async () => {
    const { service, entryRepo } = build(TENANT_ADMIN);

    await expect(service.get('entry-1')).rejects.toBeInstanceOf(ForbiddenException);
    // Gate BEFORE the read: a tenant admin must not be able to probe the id space.
    expect(entryRepo.findById).not.toHaveBeenCalled();
  });

  it('propagates the repository 404 for an unknown id', async () => {
    const { service, entryRepo } = build(SUPER_ADMIN);
    entryRepo.findById.mockRejectedValue(new DataNotFoundException('ChangelogEntry', 'nope'));

    await expect(service.get('nope')).rejects.toBeInstanceOf(DataNotFoundException);
  });

  it('broadcasts ResourceViewed', async () => {
    const { service, emitter } = build(SUPER_ADMIN);

    await service.get('entry-1');

    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: 'entry-1' }));
  });
});
