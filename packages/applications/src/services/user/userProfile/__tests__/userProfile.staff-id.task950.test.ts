/**
 * TASK-950 — `UserProfile.staffId` per-tenant uniqueness on the admin write paths (plan test 16).
 *
 * What is being pinned here is the PREDICATE, not a mock's return value. `UserProfile` has no
 * tenant column, so "taken in this tenant" is expressible only as
 * `User.UserRoleAssignments.some({ tenantId, ENABLED })`. With a mocked repository, a test that
 * only checked "returns 409 when the mock returns a row" would pass just as happily with the
 * tenant clause deleted — which is the bug that would let one tenant's staff id block another's.
 * So every test below asserts the WHERE the service builds.
 *
 * The check is deliberately NOT a concurrency guard (check-then-write is racy by construction).
 * The machine plane that actually races is `ContextUserIdentityService`, which closes its own
 * race with `pg_advisory_xact_lock` and an in-transaction re-check.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { UserProfileService } from '../userProfile.service';

const TENANT = 'tenant-a';

function build(opts: { tenantId?: string | null; clashes?: unknown[]; existing?: unknown } = {}) {
  const repository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(async (entity: unknown) => entity),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
  };

  // `findAll` serves two DIFFERENT queries in these paths — the uniqueness probe (a `staffId`
  // where) and the by-user lookup — so the stub dispatches on the predicate rather than on call
  // order, which would silently invert if the service reordered its reads.
  repository.findAll.mockImplementation(async (props: { where?: Record<string, unknown> }) => {
    if (props?.where && 'staffId' in props.where) return opts.clashes ?? [];
    return opts.existing === undefined ? [] : [opts.existing];
  });

  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? (opts.tenantId === undefined ? TENANT : opts.tenantId) : undefined)),
    set: vi.fn(),
  };
  const eventEmitter = { emit: vi.fn() };

  const service = new UserProfileService(repository as never, eventEmitter as never, clsService as never);
  return { service, repository, eventEmitter };
}

/** The uniqueness probe's `where`, or undefined when the service never ran one. */
function probeWhere(repository: { findAll: ReturnType<typeof vi.fn> }): Record<string, unknown> | undefined {
  const call = repository.findAll.mock.calls.find(([props]) => props?.where && 'staffId' in props.where);
  return call?.[0]?.where;
}

beforeEach(() => vi.clearAllMocks());

describe('UserProfileService — staffId uniqueness is per TENANT (test 16)', () => {
  it('refuses a staffId another user in the tenant holds, with 409 STAFF_ID_TAKEN', async () => {
    const t = build({ clashes: [{ id: 'profile-other', userId: 'u-other' }] });

    await expect(t.service.upsertByUserId('u-1', { staffId: 'DR-1' } as never)).rejects.toMatchObject({
      status: 409,
      response: { code: 'STAFF_ID_TAKEN' },
    });
    await expect(t.service.upsertByUserId('u-1', { staffId: 'DR-1' } as never)).rejects.toBeInstanceOf(ConflictException);

    // Refused BEFORE any write — a 409 that had already created the row would be a lie.
    expect(t.repository.create).not.toHaveBeenCalled();
    expect(t.repository.update).not.toHaveBeenCalled();
  });

  it('scopes the probe to the CALLER tenant via the role assignment — the same value in another tenant is allowed', async () => {
    const t = build({ clashes: [] });

    await t.service.upsertByUserId('u-1', { staffId: 'DR-1' } as never);

    // This clause IS the per-tenant scope. Without it, one hospital employing staff number
    // `12345` would stop every other hospital from recording theirs.
    expect(probeWhere(t.repository)).toEqual({
      staffId: 'DR-1',
      resourceStatus: { not: ResourceStatusType.DELETED },
      User: {
        resourceStatus: { not: ResourceStatusType.DELETED },
        UserRoleAssignments: { some: { tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED } },
      },
      // Excludes the user being written, so re-saving a profile with its own unchanged staff id
      // is not a conflict with itself.
      userId: { not: 'u-1' },
    });
  });

  it('excludes the profile OWNER on the by-id update path too', async () => {
    const t = build({ clashes: [] });
    t.repository.findById.mockResolvedValue({
      id: 'profile-1',
      userId: 'u-1',
      toObject: () => ({ id: 'profile-1' }),
      hasChanges: true,
      changes: { staffId: 'DR-1' },
    });

    await t.service.update('profile-1', { staffId: 'DR-1' } as never);

    // The row is resolved FIRST so the exclusion can name the profile's own user.
    expect(probeWhere(t.repository)).toMatchObject({ userId: { not: 'u-1' } });
    expect(t.repository.findById.mock.invocationCallOrder[0]).toBeLessThan(t.repository.findAll.mock.invocationCallOrder[0]);
  });

  it('does not probe when staffId is absent — an unrelated profile edit costs no extra query', async () => {
    const t = build({ clashes: [{ id: 'profile-other' }] });

    await t.service.upsertByUserId('u-1', { firstName: 'Ada' } as never);

    expect(probeWhere(t.repository)).toBeUndefined();
  });

  it('does not probe when staffId is null — clearing a value can never collide', async () => {
    const t = build({ clashes: [{ id: 'profile-other' }] });

    await t.service.upsertByUserId('u-1', { staffId: null } as never);

    expect(probeWhere(t.repository)).toBeUndefined();
  });

  it('skips the check with no tenant in context — "unique within the tenant" needs a tenant', async () => {
    // An unscoped super admin. Widening the probe to every tenant would refuse a staff id that
    // is perfectly legal in the target tenant, inventing a collision the model does not have.
    const t = build({ tenantId: null, clashes: [{ id: 'profile-other' }] });

    await expect(t.service.upsertByUserId('u-1', { staffId: 'DR-1' } as never)).resolves.toBeDefined();
    expect(probeWhere(t.repository)).toBeUndefined();
  });

  it('carries staffId through create when the user has no profile yet', async () => {
    const t = build({ clashes: [] });

    await t.service.upsertByUserId('u-1', { staffId: 'DR-1' } as never);

    expect(t.repository.create).toHaveBeenCalledTimes(1);
    expect(t.repository.create.mock.calls[0][0]).toMatchObject({ userId: 'u-1', staffId: 'DR-1' });
  });
});
