/**
 * TASK-950 — `ContextUserIdentityService.resolveOrProvision` (plan TDD tests 7–15).
 *
 * Repositories, the Prisma base client, CLS, the event emitter, the settings facade and
 * entitlements are all mocked; what is under test is the DECISION TREE and the exact rows and
 * events a provision writes.
 *
 * One note on the cross-tenant test (7/8). With a mocked repository, "another tenant's user is
 * not matched" cannot be proved by the repository returning nothing — that is just the mock
 * doing as it is told. The real assertion is on the WHERE CLAUSE the service builds, because
 * that clause IS the tenant boundary: `UserProfile` has no tenant column, so
 * `User.UserRoleAssignments.some({ tenantId, ENABLED })` is the only thing standing between one
 * tenant's staff id and another tenant's user. So the test asserts the predicate, and separately
 * asserts that an empty result provisions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException, QuotaExceededException } from '@arcaai/exceptions';
import { ResourceStatusType, ResourceType, SysEventType } from '@arcaai/domains';
import { ContextUserIdentityService } from '../context-user-identity.service';
import {
  IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY,
  IDENTITY_AUTO_PROVISION_ENABLED_KEY,
  IDENTITY_AUTO_PROVISION_ROLE_ID_KEY,
} from '../../../settings-registry/descriptors/user-identity.descriptors';
import type { ResolveUserIdentityInput } from '../IContextUserIdentityService';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const DOCTOR_ROLE_ID = '00000000-0000-0000-0000-000000000010';
const DEPARTMENT_ID = '00000000-0000-0000-0000-0000000000d1';
const SERVICE_ACCOUNT_ID = 'svc-1';

const PROVENANCE = {
  plane: 'consultation-open' as const,
  kindKey: 'context',
  field: 'consultant_id',
  serviceAccountId: SERVICE_ACCOUNT_ID,
  schemaId: 'schema-1',
  versionNumber: 3,
};

const input = (over: Partial<ResolveUserIdentityInput> = {}): ResolveUserIdentityInput => ({
  tenantId: TENANT,
  staffId: 'DR-1',
  provenance: PROVENANCE,
  ...over,
});

/** Minimal stand-in for a persisted row: the service only reads `id` and `createdAt`. */
const row = (id: string) => ({ id, createdAt: new Date('2026-09-11T00:00:00.000Z') });

function build(
  opts: {
    /** Profiles the PRE-transaction lookup returns. */
    profiles?: Array<{ userId: string }>;
    /** `userRepository.findById` answers, keyed by user id. */
    userStatuses?: Record<string, ResourceStatusType>;
    /** Profiles the IN-transaction re-check returns (the race path). */
    txProfiles?: Array<{ userId: string; User: { resourceStatus: ResourceStatusType } }>;
    settings?: Partial<Record<string, unknown>>;
    /** Keys whose resolve should raise the declared fail-closed error. */
    unresolved?: string[];
    roleName?: string;
    enforcement?: boolean;
    seats?: number;
    quotaError?: Error;
    /** Number of leading `userRepository.create` calls that fail with a username collision. */
    usernameCollisions?: number;
  } = {},
) {
  const settings: Record<string, unknown> = {
    [IDENTITY_AUTO_PROVISION_ENABLED_KEY]: true,
    [IDENTITY_AUTO_PROVISION_ROLE_ID_KEY]: DOCTOR_ROLE_ID,
    [IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY]: DEPARTMENT_ID,
    ...(opts.settings ?? {}),
  };
  const unresolved = new Set(opts.unresolved ?? []);

  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => {
      if (unresolved.has(key)) {
        throw new ArgumentInvalidException(`Setting '${key}' could not be resolved and is declared fail-closed;`);
      }
      return { key, tier: 'global-kv', value: settings[key], sourceScope: 'tenant' };
    }),
  };

  const userProfileRepository = {
    findAll: vi.fn(async () => opts.profiles ?? []),
    create: vi.fn(async (entity: { id: string; createdAt: Date }) => entity),
  };

  let createCalls = 0;
  const userRepository = {
    findById: vi.fn(async (id: string) => {
      const status = opts.userStatuses?.[id];
      if (!status) throw new Error(`test setup: no status registered for ${id}`);
      return { id, resourceStatus: status };
    }),
    create: vi.fn(async (entity: { id: string; createdAt: Date }) => {
      createCalls += 1;
      if (createCalls <= (opts.usernameCollisions ?? 0)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['username'] } });
      }
      return entity;
    }),
  };

  const userRoleAssignmentRepository = { create: vi.fn(async (entity: { id: string; createdAt: Date }) => entity) };
  const userDepartmentRepository = { create: vi.fn(async (entity: { id: string; createdAt: Date }) => entity) };

  const txUserProfileFindMany = vi.fn(async () => opts.txProfiles ?? []);
  const txUserUpdate = vi.fn(async () => row('u-new'));
  const executeRaw = vi.fn(async () => 1);
  const tx = {
    $executeRaw: executeRaw,
    userProfile: { findMany: txUserProfileFindMany },
    user: { update: txUserUpdate },
  };

  const roleFindUnique = vi.fn(async () => ({ name: opts.roleName ?? 'DOCTOR' }));
  const seatFindMany = vi.fn(async () => Array.from({ length: opts.seats ?? 0 }, (_, i) => ({ userId: `seat-${i}` })));
  const $transaction = vi.fn(async (cb: (t: unknown) => unknown) => cb(tx));
  const databaseService = {
    baseClient: {
      $transaction,
      role: { findUnique: roleFindUnique },
      userRoleAssignment: { findMany: seatFindMany },
    },
  };

  const assertQuantityQuota = vi.fn(async () => {
    if (opts.quotaError) throw opts.quotaError;
  });
  const entitlements = {
    isEnforcementEnabled: vi.fn(() => opts.enforcement ?? false),
    assertQuantityQuota,
  };

  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn() };

  const service = new ContextUserIdentityService(
    userRepository as never,
    userProfileRepository as never,
    userRoleAssignmentRepository as never,
    userDepartmentRepository as never,
    eventEmitter as never,
    clsService as never,
    databaseService as never,
    effectiveSettings as never,
    entitlements as never,
  );

  return {
    service,
    userRepository,
    userProfileRepository,
    userRoleAssignmentRepository,
    userDepartmentRepository,
    effectiveSettings,
    eventEmitter,
    $transaction,
    executeRaw,
    txUserProfileFindMany,
    txUserUpdate,
    roleFindUnique,
    assertQuantityQuota,
  };
}

/** Every `ResourceCreated` broadcast, as `[resourceType, payload]` pairs. */
function created(eventEmitter: { emit: ReturnType<typeof vi.fn> }): Array<[ResourceType, Record<string, unknown>]> {
  return eventEmitter.emit.mock.calls
    .filter(([type]) => type === SysEventType.ResourceCreated)
    .map(([, payload]) => [(payload as { resourceType: ResourceType }).resourceType, payload as Record<string, unknown>]);
}

beforeEach(() => vi.clearAllMocks());

// ── 7 / 8 — reuse, and the tenant boundary ──────────────────────────────────
describe('resolveOrProvision — an existing user (test 7)', () => {
  it('reuses the single ENABLED match and writes nothing', async () => {
    const t = build({ profiles: [{ userId: 'u-1' }], userStatuses: { 'u-1': ResourceStatusType.ENABLED } });

    await expect(t.service.resolveOrProvision(input())).resolves.toEqual({ userId: 'u-1', provisioned: false });

    expect(t.$transaction).not.toHaveBeenCalled();
    expect(t.userRepository.create).not.toHaveBeenCalled();
    expect(t.userProfileRepository.create).not.toHaveBeenCalled();
    // The gate is consulted only AFTER a miss, so a hit never depends on the setting.
    expect(t.effectiveSettings.resolveEffective).not.toHaveBeenCalled();
    expect(created(t.eventEmitter)).toEqual([]);
  });

  it('scopes the lookup to the request tenant through the role assignment (test 8)', async () => {
    const t = build({ profiles: [{ userId: 'u-1' }], userStatuses: { 'u-1': ResourceStatusType.ENABLED } });

    await t.service.resolveOrProvision(input({ tenantId: OTHER_TENANT }));

    // `UserProfile` has no tenant column, so THIS clause is the tenant boundary. If it ever
    // drops, one tenant's staff id silently resolves to another tenant's clinician.
    expect(t.userProfileRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          staffId: 'DR-1',
          resourceStatus: { not: ResourceStatusType.DELETED },
          User: {
            resourceStatus: { not: ResourceStatusType.DELETED },
            UserRoleAssignments: { some: { tenantId: OTHER_TENANT, resourceStatus: ResourceStatusType.ENABLED } },
          },
        },
        // 2, not 1 — a second row is the difference between "reuse" and 409 AMBIGUOUS.
        limit: 2,
      }),
    );
  });

  it('provisions when no user in THIS tenant carries the id, even though another tenant does', async () => {
    const t = build({ profiles: [] });

    await expect(t.service.resolveOrProvision(input())).resolves.toMatchObject({ provisioned: true });

    expect(t.userRepository.create).toHaveBeenCalledTimes(1);
  });
});

// ── 9 — unusable and ambiguous ──────────────────────────────────────────────
describe('resolveOrProvision — refusals on a match (test 9)', () => {
  it.each([ResourceStatusType.DISABLED, ResourceStatusType.SUSPENDED, ResourceStatusType.ARCHIVED])(
    'refuses a %s user with 404 USER_IDENTITY_NOT_USABLE rather than provisioning a second one',
    async (status) => {
      const t = build({ profiles: [{ userId: 'u-1' }], userStatuses: { 'u-1': status } });

      await expect(t.service.resolveOrProvision(input())).rejects.toMatchObject({
        status: 404,
        response: { code: 'USER_IDENTITY_NOT_USABLE' },
      });
      await expect(t.service.resolveOrProvision(input())).rejects.toBeInstanceOf(NotFoundException);
      expect(t.$transaction).not.toHaveBeenCalled();
    },
  );

  it('refuses two matches with 409 USER_IDENTITY_AMBIGUOUS and does not pick a winner', async () => {
    const t = build({
      profiles: [{ userId: 'u-1' }, { userId: 'u-2' }],
      userStatuses: { 'u-1': ResourceStatusType.ENABLED, 'u-2': ResourceStatusType.ENABLED },
    });

    await expect(t.service.resolveOrProvision(input())).rejects.toMatchObject({
      status: 409,
      response: { code: 'USER_IDENTITY_AMBIGUOUS' },
    });
    await expect(t.service.resolveOrProvision(input())).rejects.toBeInstanceOf(ConflictException);
    expect(t.$transaction).not.toHaveBeenCalled();
  });
});

// ── 10 — the gate ───────────────────────────────────────────────────────────
describe('resolveOrProvision — auto-provisioning disabled (test 10)', () => {
  it('refuses an unknown staff id with 404 USER_IDENTITY_UNKNOWN and writes nothing', async () => {
    const t = build({ profiles: [], settings: { [IDENTITY_AUTO_PROVISION_ENABLED_KEY]: false } });

    await expect(t.service.resolveOrProvision(input())).rejects.toMatchObject({
      status: 404,
      response: { code: 'USER_IDENTITY_UNKNOWN' },
    });

    expect(t.$transaction).not.toHaveBeenCalled();
    expect(t.userRepository.create).not.toHaveBeenCalled();
    // Refused before role/department are even resolved — nothing about the shape of the write
    // is computed for a request that will not write.
    expect(t.effectiveSettings.resolveEffective).toHaveBeenCalledTimes(1);
  });
});

// ── 11 — the four rows, the lock, the events ────────────────────────────────
describe('resolveOrProvision — provisioning (test 11)', () => {
  it('takes the advisory lock FIRST, re-checks, then writes the four rows in one transaction', async () => {
    const t = build({ profiles: [] });

    const result = await t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }));

    expect(result.provisioned).toBe(true);
    expect(t.$transaction).toHaveBeenCalledTimes(1);

    // The lock is the FIRST statement, keyed by `tenantId:staffId`, and is a transaction-scoped
    // lock (`pg_advisory_xact_lock`) so no path — exception included — can leak it.
    const [sql, lockKey] = t.executeRaw.mock.calls[0] as [string[], string];
    expect(sql.join('?')).toContain('pg_advisory_xact_lock(hashtext(');
    expect(lockKey).toBe(`${TENANT}:DR-1`);
    // Re-checked INSIDE the lock — without this the lock only serialises two duplicate inserts
    // instead of preventing the second.
    expect(t.txUserProfileFindMany).toHaveBeenCalledTimes(1);
    expect(t.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(t.txUserProfileFindMany.mock.invocationCallOrder[0]);

    const user = t.userRepository.create.mock.calls[0][0] as {
      id: string;
      username: string;
      password: string;
      isServiceAccount: boolean;
      tags: string[];
    };
    expect(user.username).toMatch(/^auto_[0-9a-f]{16}$/);
    // The staff id may be PII — it must never appear in a platform-global unique column.
    expect(user.username).not.toContain('DR-1');
    expect(user.password).toBe('');
    expect(user.isServiceAccount).toBe(false);
    expect(user.tags).toEqual(['auto-provisioned']);

    // Every repository write participates in the SAME transaction — a partial write would be an
    // account that cannot log in.
    for (const repo of [t.userRepository, t.userProfileRepository, t.userRoleAssignmentRepository, t.userDepartmentRepository]) {
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create.mock.calls[0][1]).toBeDefined();
    }

    expect(t.userProfileRepository.create.mock.calls[0][0]).toMatchObject({ userId: user.id, staffId: 'DR-1' });
    expect(t.userRoleAssignmentRepository.create.mock.calls[0][0]).toMatchObject({ roleId: DOCTOR_ROLE_ID, tenantId: TENANT });
    expect(t.userDepartmentRepository.create.mock.calls[0][0]).toMatchObject({ tenantId: TENANT, departmentId: DEPARTMENT_ID, isPrimary: true });
  });

  it('records provisioning provenance in the User _metadata, inside the same transaction', async () => {
    const t = build({ profiles: [] });

    await t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }));

    // `_metadata` is a real User column the domain entity does not surface, so it is written
    // through `tx` — inside the transaction, so it commits or rolls back with the four rows.
    expect(t.txUserUpdate).toHaveBeenCalledTimes(1);
    const { data } = t.txUserUpdate.mock.calls[0][0] as { data: { metaData: { provisioning: Record<string, unknown> } } };
    expect(data.metaData.provisioning).toMatchObject({
      source: 'context-schema',
      plane: 'consultation-open',
      kindKey: 'context',
      field: 'consultant_id',
      serviceAccountId: SERVICE_ACCOUNT_ID,
      schemaId: 'schema-1',
      versionNumber: 3,
    });
    expect(data.metaData.provisioning.at).toEqual(expect.any(String));
    // The identifier itself is NOT copied into the metadata — it lives on the profile, behind
    // the tenancy checks that guard every other read of it.
    expect(JSON.stringify(data.metaData)).not.toContain('DR-1');
  });

  it('broadcasts ResourceCreated for all four rows, after the commit', async () => {
    const t = build({ profiles: [] });

    await t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }));

    const events = created(t.eventEmitter);
    expect(events.map(([type]) => type)).toEqual([
      ResourceType.User,
      ResourceType.UserProfile,
      ResourceType.UserRoleAssignment,
      ResourceType.UserDepartment,
    ]);
    for (const [, payload] of events) {
      expect(payload.tenantId).toBe(TENANT);
      expect(payload.resourceId).toEqual(expect.any(String));
    }
  });

  it('reuses the winner and provisions nothing when the in-transaction re-check finds a race', async () => {
    // The loser of two simultaneous first requests. Without the re-check both would provision,
    // and every request after that would get 409 AMBIGUOUS forever.
    const t = build({ profiles: [], txProfiles: [{ userId: 'u-winner', User: { resourceStatus: ResourceStatusType.ENABLED } }] });

    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).resolves.toEqual({
      userId: 'u-winner',
      provisioned: false,
    });

    expect(t.userRepository.create).not.toHaveBeenCalled();
    expect(created(t.eventEmitter)).toEqual([]);
  });
});

// ── 12 — department resolution and the SUPER_ADMIN guard ────────────────────
describe('resolveOrProvision — department and role policy (test 12)', () => {
  it('prefers the request department over the tenant setting', async () => {
    const t = build({ profiles: [] });

    await t.service.resolveOrProvision(input({ departmentId: 'dept-from-request' }));

    expect(t.userDepartmentRepository.create.mock.calls[0][0]).toMatchObject({ departmentId: 'dept-from-request' });
    // The setting is not even consulted when the request names one.
    expect(t.effectiveSettings.resolveEffective).not.toHaveBeenCalledWith(IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY, expect.anything());
  });

  it('falls back to the tenant setting when the request names no department', async () => {
    const t = build({ profiles: [] });

    await t.service.resolveOrProvision(input());

    expect(t.userDepartmentRepository.create.mock.calls[0][0]).toMatchObject({ departmentId: DEPARTMENT_ID });
  });

  it('refuses with 400 USER_IDENTITY_DEPARTMENT_UNRESOLVED, BEFORE writing anything', async () => {
    const t = build({ profiles: [], unresolved: [IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY] });

    await expect(t.service.resolveOrProvision(input())).rejects.toMatchObject({
      status: 400,
      response: { code: 'USER_IDENTITY_DEPARTMENT_UNRESOLVED' },
    });
    await expect(t.service.resolveOrProvision(input())).rejects.toBeInstanceOf(BadRequestException);
    // A user without a department cannot satisfy `assertUserBelongsToTenant`, so a half-written
    // account is worse than a refusal.
    expect(t.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a role that resolves to SUPER_ADMIN with 403, before writing anything', async () => {
    const t = build({ profiles: [], roleName: 'SUPER_ADMIN' });

    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.$transaction).not.toHaveBeenCalled();
    // Checked by NAME, so pointing the setting at a tenant-cloned role called SUPER_ADMIN does
    // not slip past it.
    expect(t.roleFindUnique).toHaveBeenCalledWith({ where: { id: DOCTOR_ROLE_ID }, select: { name: true } });
  });

  it('lets an unresolved fail-closed roleId propagate rather than substituting one', async () => {
    const t = build({ profiles: [], unresolved: [IDENTITY_AUTO_PROVISION_ROLE_ID_KEY] });

    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(t.$transaction).not.toHaveBeenCalled();
  });
});

// ── 13 — the seat quota ─────────────────────────────────────────────────────
describe('resolveOrProvision — seat quota (test 13)', () => {
  it('checks maxUsers against the tenant seat count before writing', async () => {
    const t = build({ profiles: [], enforcement: true, seats: 7 });

    await t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }));

    expect(t.assertQuantityQuota).toHaveBeenCalledWith(TENANT, 'maxUsers', 7);
    expect(t.assertQuantityQuota.mock.invocationCallOrder[0]).toBeLessThan(t.$transaction.mock.invocationCallOrder[0]);
  });

  it('propagates QuotaExceededException — a machine plane must not mint unbilled users', async () => {
    const quotaError = new QuotaExceededException('maxUsers quota exceeded', { capability: 'maxUsers' } as never);
    const t = build({ profiles: [], enforcement: true, quotaError });

    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).rejects.toBe(quotaError);
    expect(t.$transaction).not.toHaveBeenCalled();
  });

  it('skips the seat COUNT entirely when enforcement is off', async () => {
    const t = build({ profiles: [], enforcement: false });

    await t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }));

    expect(t.assertQuantityQuota).not.toHaveBeenCalled();
  });
});

// ── 14 — normalisation ──────────────────────────────────────────────────────
describe('resolveOrProvision — value normalisation (test 14)', () => {
  it('trims before looking up, so "DR-1" and "  DR-1 " are one clinician', async () => {
    const t = build({ profiles: [{ userId: 'u-1' }], userStatuses: { 'u-1': ResourceStatusType.ENABLED } });

    await t.service.resolveOrProvision(input({ staffId: '  DR-1 ' }));

    expect(t.userProfileRepository.findAll.mock.calls[0][0].where).toMatchObject({ staffId: 'DR-1' });
  });

  it('trims before persisting and before hashing the advisory lock key', async () => {
    const t = build({ profiles: [] });

    await t.service.resolveOrProvision(input({ staffId: '\tDR-1\n ', departmentId: DEPARTMENT_ID }));

    expect(t.userProfileRepository.create.mock.calls[0][0]).toMatchObject({ staffId: 'DR-1' });
    // Untrimmed, this would hash to a DIFFERENT lock than the trimmed request — two locks, two
    // users, one clinician.
    expect(t.executeRaw.mock.calls[0][1]).toBe(`${TENANT}:DR-1`);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'x'.repeat(129)],
    // A staff id round-trips through logs, an advisory-lock hash and an admin console. These
    // are the shapes of a log-injection or display-spoof payload, never of an employee number.
    ['newline', 'DR\n1'],
    ['carriage return', 'DR\r1'],
    ['ESC', 'DR\u001b[31m1'],
    ['NUL', 'DR\u00001'],
    ['DEL', 'DR\u007f1'],
  ])('refuses a %s value with 400 USER_IDENTITY_INVALID', async (_label, staffId) => {
    const t = build({ profiles: [] });

    await expect(t.service.resolveOrProvision(input({ staffId }))).rejects.toMatchObject({
      status: 400,
      response: { code: 'USER_IDENTITY_INVALID' },
    });
    // Refused at the edge — no lookup, no settings read, no write.
    expect(t.userProfileRepository.findAll).not.toHaveBeenCalled();
    expect(t.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a value of exactly the 128-character maximum', async () => {
    const staffId = 'x'.repeat(128);
    const t = build({ profiles: [] });

    await expect(t.service.resolveOrProvision(input({ staffId, departmentId: DEPARTMENT_ID }))).resolves.toMatchObject({ provisioned: true });
    expect(t.userProfileRepository.create.mock.calls[0][0]).toMatchObject({ staffId });
  });

  it('does NOT trim interior whitespace — a staff id may legitimately contain a space', async () => {
    const t = build({ profiles: [] });

    await t.service.resolveOrProvision(input({ staffId: 'DR 1', departmentId: DEPARTMENT_ID }));

    expect(t.userProfileRepository.create.mock.calls[0][0]).toMatchObject({ staffId: 'DR 1' });
  });
});

// ── 15 — username collision ─────────────────────────────────────────────────
describe('resolveOrProvision — username collision (test 15)', () => {
  it('regenerates and retries the whole transaction on a P2002 username collision', async () => {
    const t = build({ profiles: [], usernameCollisions: 1 });

    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).resolves.toMatchObject({ provisioned: true });

    // The RETRY is of the transaction, not the insert: a failed statement aborts a Postgres
    // transaction, so retrying in place would fail with "current transaction is aborted".
    expect(t.$transaction).toHaveBeenCalledTimes(2);
    expect(t.userRepository.create).toHaveBeenCalledTimes(2);
    const [first, second] = t.userRepository.create.mock.calls.map((call) => (call[0] as { username: string }).username);
    expect(first).not.toBe(second);
    expect(second).toMatch(/^auto_[0-9a-f]{16}$/);
  });

  it('gives up after three attempts rather than looping', async () => {
    const t = build({ profiles: [], usernameCollisions: 3 });

    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).rejects.toMatchObject({ code: 'P2002' });
    expect(t.$transaction).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a unique violation on any other column', async () => {
    const t = build({ profiles: [] });
    t.userRepository.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['externalId'] } }));

    // Retrying would re-run the transaction three times and then surface the same error, having
    // hidden the real cause behind two pointless round trips.
    await expect(t.service.resolveOrProvision(input({ departmentId: DEPARTMENT_ID }))).rejects.toMatchObject({ code: 'P2002' });
    expect(t.$transaction).toHaveBeenCalledTimes(1);
  });
});
