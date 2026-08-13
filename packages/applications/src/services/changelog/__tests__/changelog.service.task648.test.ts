import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ChangelogAudience, ChangelogPublishStatus, ChangelogSeverity } from '@arcaai/domains';
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
    platformVersion: '2.1.0',
    title: 'HOPE 2.1.0',
    summary: 'Malayalam TTS',
    body: '# body',
    severity: ChangelogSeverity.IMPORTANT,
    audience: ChangelogAudience.ALL,
    publishStatus: ChangelogPublishStatus.PUBLISHED,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    version: 3,
    ...over,
  };
  return {
    ...state,
    changes: {},
    hasChanges: true,
    validate: () => undefined,
    toObject: () => ({ ...state }),
  } as never;
};

const makeAck = (entryId: string, over: Record<string, unknown> = {}) =>
  ({
    id: `ack-${entryId}`,
    userId: 'user-1',
    changelogEntryId: entryId,
    autoAcknowledged: false,
    acknowledgedAt: new Date(),
    ...over,
  }) as never;

function build(ctx: Ctx) {
  const entryRepo = {
    findAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findById: vi.fn(),
    create: vi.fn(async (e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const ackRepo = {
    findAll: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn(async (e: unknown) => e),
  };
  const userRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1', createdAt: new Date('2020-01-01T00:00:00.000Z') }),
  };
  const emitter = { emit: vi.fn() };
  const service = new ChangelogService(entryRepo as never, ackRepo as never, userRepo as never, emitter as never, makeCls(ctx) as never);
  return { service, entryRepo, ackRepo, userRepo, emitter };
}

const TENANT_USER: Ctx = { user: { id: 'user-1', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' }, tenantId: 'tenant-1' };
const GLOBAL_ADMIN: Ctx = { user: { id: 'admin-1', roles: ['GLOBAL_ADMIN'] }, tenantId: null };

describe('ChangelogService — listUnseen', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = build(TENANT_USER);
  });

  it('excludes DRAFT and wrong-audience entries at the query level', async () => {
    await harness.service.listUnseen();

    const where = harness.entryRepo.findAll.mock.calls[0][0].where;
    expect(where.publishStatus).toBe(ChangelogPublishStatus.PUBLISHED);
    expect(where.audience).toEqual({ in: [ChangelogAudience.ALL, ChangelogAudience.TENANT_ADMIN] });
  });

  it('excludes entries the user has already acknowledged', async () => {
    harness.entryRepo.findAll.mockResolvedValue([makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]);
    harness.ackRepo.findAll.mockResolvedValue([makeAck('a')]);

    const result = await harness.service.listUnseen();

    expect(result.map((r) => r.id)).toEqual(['b']);
  });

  it('caps the result at 3', async () => {
    harness.entryRepo.findAll.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map((id) => makeEntry({ id })));

    const result = await harness.service.listUnseen();

    expect(result).toHaveLength(3);
  });

  it('returns an empty array — never an error — when there is nothing to show', async () => {
    harness.entryRepo.findAll.mockResolvedValue([]);
    await expect(harness.service.listUnseen()).resolves.toEqual([]);
  });

  it('returns EMPTY while impersonating and writes no acknowledgement', async () => {
    const impersonated = build({ user: { id: 'user-1', roles: ['TENANT_ADMIN'], impersonatedBy: 'admin-9' }, tenantId: 'tenant-1' });
    impersonated.entryRepo.findAll.mockResolvedValue([makeEntry({ id: 'a' })]);

    const result = await impersonated.service.listUnseen();

    expect(result).toEqual([]);
    expect(impersonated.ackRepo.createMany).not.toHaveBeenCalled();
    expect(impersonated.ackRepo.create).not.toHaveBeenCalled();
  });

  it('auto-acknowledges entries published before the user existed and does NOT show them', async () => {
    harness.userRepo.findById.mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1', createdAt: new Date('2026-08-05T00:00:00.000Z') });
    harness.entryRepo.findAll.mockResolvedValue([
      makeEntry({ id: 'new', publishedAt: new Date('2026-08-06T00:00:00.000Z') }),
      makeEntry({ id: 'predates', publishedAt: new Date('2026-08-01T00:00:00.000Z') }),
    ]);

    const result = await harness.service.listUnseen();

    expect(result.map((r) => r.id)).toEqual(['new']);
    expect(harness.ackRepo.createMany).toHaveBeenCalledTimes(1);
    const written = harness.ackRepo.createMany.mock.calls[0][0];
    expect(written).toHaveLength(1);
    expect(written[0].changelogEntryId).toBe('predates');
    expect(written[0].autoAcknowledged).toBe(true);
  });

  it('a global admin sees the GLOBAL_ADMIN audience, not TENANT_ADMIN', async () => {
    const admin = build(GLOBAL_ADMIN);
    await admin.service.listUnseen();

    expect(admin.entryRepo.findAll.mock.calls[0][0].where.audience).toEqual({
      in: [ChangelogAudience.ALL, ChangelogAudience.GLOBAL_ADMIN],
    });
  });
});

describe('ChangelogService — acknowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is idempotent: an already-acknowledged entry is a no-op, not a conflict', async () => {
    const h = build(TENANT_USER);
    h.ackRepo.findAll.mockResolvedValue([makeAck('a')]);

    await expect(h.service.acknowledge(['a'])).resolves.toBeUndefined();
    expect(h.ackRepo.createMany).not.toHaveBeenCalled();
  });

  it('writes acknowledgements only for entries not yet acknowledged, with autoAcknowledged false', async () => {
    const h = build(TENANT_USER);
    h.ackRepo.findAll.mockResolvedValue([makeAck('a')]);

    await h.service.acknowledge(['a', 'b']);

    const written = h.ackRepo.createMany.mock.calls[0][0];
    expect(written).toHaveLength(1);
    expect(written[0].changelogEntryId).toBe('b');
    expect(written[0].autoAcknowledged).toBe(false);
  });
});

describe('ChangelogService — list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a global admin DRAFT entries too', async () => {
    const h = build(GLOBAL_ADMIN);
    await h.service.list({});

    expect(h.entryRepo.findAll.mock.calls[0][0].where.publishStatus).toBeUndefined();
  });

  it('pins a non-global caller to PUBLISHED', async () => {
    const h = build(TENANT_USER);
    await h.service.list({});

    expect(h.entryRepo.findAll.mock.calls[0][0].where.publishStatus).toBe(ChangelogPublishStatus.PUBLISHED);
  });

  it('filters by platformVersion prefix when `version` is supplied', async () => {
    const h = build(TENANT_USER);
    await h.service.list({ version: '2.1' });

    expect(h.entryRepo.findAll.mock.calls[0][0].where.platformVersion).toEqual({ startsWith: '2.1' });
  });
});

describe('ChangelogService — authoring (GLOBAL_ADMIN only)', () => {
  beforeEach(() => vi.clearAllMocks());

  const createDto = { platformVersion: '2.2.0', title: 't', summary: 's', body: 'b' };

  it('rejects create/update/publish for a non-global admin', async () => {
    const h = build(TENANT_USER);
    h.entryRepo.findById.mockResolvedValue(makeEntry());

    await expect(h.service.create(createDto)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.update('entry-1', { title: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.publish('entry-1', 3)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates as DRAFT under the SYSTEM tenant', async () => {
    const h = build(GLOBAL_ADMIN);

    const result = await h.service.create(createDto);

    expect(result.publishStatus).toBe(ChangelogPublishStatus.DRAFT);
    expect(result.publishedAt).toBeNull();
    const entity = h.entryRepo.create.mock.calls[0][0];
    expect(entity.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('publishes a DRAFT: sets PUBLISHED + publishedAt through updateWithVersion', async () => {
    const h = build(GLOBAL_ADMIN);
    h.entryRepo.findById.mockResolvedValue(makeEntry({ publishStatus: ChangelogPublishStatus.DRAFT, publishedAt: null }));

    await h.service.publish('entry-1', 3);

    expect(h.entryRepo.updateWithVersion).toHaveBeenCalledWith('entry-1', expect.anything(), 3);
    const written = h.entryRepo.updateWithVersion.mock.calls[0][1];
    expect(written.publishStatus).toBe(ChangelogPublishStatus.PUBLISHED);
    expect(written.publishedAt).toBeInstanceOf(Date);
  });

  it('rejects publishing an already-published entry with 409', async () => {
    const h = build(GLOBAL_ADMIN);
    h.entryRepo.findById.mockResolvedValue(makeEntry({ publishStatus: ChangelogPublishStatus.PUBLISHED }));

    await expect(h.service.publish('entry-1', 3)).rejects.toBeInstanceOf(ConflictException);
    expect(h.entryRepo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('propagates OCC drift on publish', async () => {
    const h = build(GLOBAL_ADMIN);
    h.entryRepo.findById.mockResolvedValue(makeEntry({ publishStatus: ChangelogPublishStatus.DRAFT, publishedAt: null }));
    h.entryRepo.updateWithVersion.mockRejectedValue(
      new OptimisticConcurrencyException('ChangelogEntry', 'entry-1', { expectedVersion: 1, currentVersion: 3 }),
    );

    await expect(h.service.publish('entry-1', 1)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });
});
