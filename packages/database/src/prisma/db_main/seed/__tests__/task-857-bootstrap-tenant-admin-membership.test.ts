/**
 * the bootstrap TENANT_ADMIN must be able to LOG IN.
 *
 * `93-bootstrap-tenant-admin.ts` created the user, the profile and the
 * tenant-scoped role assignment — and no `UserDepartment`. Login requires BOTH
 * halves of tenant membership for a non-super-admin
 * (`apps/api/src/modules/auth/auth.controller.ts:275-297`), so the account the
 * platform provisions so an operator can get in could not get in.
 *
 * These are BEHAVIOURAL: the real seed phase runs against an in-memory fake
 * Prisma client (the `task-686-loop-defaults-idempotency.test.ts` precedent — no
 * seed test in this repo touches a live database), and the assertion is not
 * "a row was written" but "a query with the LOGIN GATE'S OWN PREDICATE now finds
 * one". A drift guard below pins that predicate to the service it is copied
 * from, so the day the gate changes shape, this file fails instead of lying.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CorePrismaClient } from '../../../../client';
import { BOOTSTRAP_TENANT_ADMIN_ENV_VARS, BOOTSTRAP_TENANT_ADMIN_USER_ID, seedBootstrapTenantAdmin } from '../93-bootstrap-tenant-admin';
import { SYSTEM_TENANT_ID } from '../00-constants';

type Row = Record<string, any>;

const V = BOOTSTRAP_TENANT_ADMIN_ENV_VARS;
const PASSWORD = 'a-real-bootstrap-passphrase';
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';

/** Minimal in-memory stand-in for the model surfaces this phase touches. */
class FakeTable {
  rows: Row[] = [];
  creates = 0;

  /** Column defaults the DATABASE would apply (mirrors the Prisma model). */
  constructor(private readonly defaults: Row = {}) {}

  matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value !== null && typeof value === 'object' && 'in' in value) return (value.in as unknown[]).includes(row[key]);
      return row[key] === value;
    });
  }

  async findFirst({ where }: { where: Row; select?: Row }): Promise<Row | null> {
    return this.rows.find((row) => this.matches(row, where)) ?? null;
  }

  async findMany({ where }: { where?: Row } = {}): Promise<Row[]> {
    return where ? this.rows.filter((row) => this.matches(row, where)) : [...this.rows];
  }

  async create({ data }: { data: Row }): Promise<Row> {
    this.creates += 1;
    const row = { ...this.defaults, ...data };
    this.rows.push(row);
    return row;
  }
}

/** The ArcaAI clinical roster, in `04-department.ts` order. */
const ARCAAI_DEPARTMENT_CODES = ['GEN', 'SURG', 'RHEUM', 'NEUR', 'ORTH', 'HEME', 'BREN', 'DERM', 'DIET', 'NEPH', 'SONC'];
/** The Global tenant's platform-generic care-setting catalog. */
const CARE_SETTING_DEPARTMENT_CODES = ['OPD', 'IPD', 'ER', 'PERI', 'RAD', 'LAB', 'BEH', 'PEDS'];

function fakeClient(options: { tenantKey?: string; departmentCodes?: string[]; tenantId?: string } = {}) {
  const tenantId = options.tenantId ?? ARCAAI_TENANT_ID;
  const tables = {
    tenant: new FakeTable(),
    user: new FakeTable(),
    userProfile: new FakeTable(),
    role: new FakeTable(),
    userRoleAssignment: new FakeTable({ resourceStatus: 'ENABLED' }),
    department: new FakeTable({ resourceStatus: 'ENABLED' }),
    // `UserDepartment.resourceStatus` defaults to ENABLED in the schema
    // (`user.prisma:312`); the seed relies on that default, and the login gate
    // reads it, so the fake must apply it too.
    userDepartment: new FakeTable({ resourceStatus: 'ENABLED' }),
  };

  tables.tenant.rows.push({ id: tenantId, key: options.tenantKey ?? 'ARCAAI' });
  tables.role.rows.push({ id: 'role-tenant-admin', name: 'TENANT_ADMIN', tenantId: SYSTEM_TENANT_ID });
  for (const code of options.departmentCodes ?? ARCAAI_DEPARTMENT_CODES) {
    tables.department.rows.push({ id: `dept-${code}`, code, tenantId, resourceStatus: 'ENABLED' });
  }

  return { client: tables as unknown as CorePrismaClient, tables, tenantId };
}

/**
 * The login gate, verbatim: `UserDepartmentService.findActiveDepartmentForUserInTenant`
 * (`user-department.service.ts:52-67`) — the query `auth.controller.ts:290` runs.
 */
async function loginGateFindsMembership(tables: { userDepartment: FakeTable }, userId: string, tenantId: string) {
  return tables.userDepartment.findFirst({ where: { userId, tenantId, resourceStatus: 'ENABLED' } });
}

function setEnv(overrides: Record<string, string> = {}) {
  process.env[V.email] = 'ops@example.test';
  process.env[V.password] = PASSWORD;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

beforeEach(() => {
  for (const key of Object.values(V)) delete process.env[key];
});

describe('the bootstrap TENANT_ADMIN can satisfy the login gate', () => {
  it('writes a UserDepartment that the login gate finds', async () => {
    setEnv();
    const { client, tables, tenantId } = fakeClient();

    await seedBootstrapTenantAdmin(client);

    const membership = await loginGateFindsMembership(tables, BOOTSTRAP_TENANT_ADMIN_USER_ID, tenantId);
    expect(membership).not.toBeNull();
    expect(membership).toMatchObject({
      userId: BOOTSTRAP_TENANT_ADMIN_USER_ID,
      tenantId,
      isPrimary: true,
      resourceStatus: 'ENABLED',
    });
  });

  it('binds the membership to a department of the SAME tenant', async () => {
    setEnv();
    const { client, tables, tenantId } = fakeClient();

    await seedBootstrapTenantAdmin(client);

    const membership = tables.userDepartment.rows[0]!;
    const department = tables.department.rows.find((d) => d.id === membership.departmentId);
    expect(department, 'membership must reference a real department (it is a FK)').toBeDefined();
    expect(department!.tenantId).toBe(tenantId);
  });

  it('joins ArcaAI at GEN — the department 91-user gives its own tenant administrator', async () => {
    setEnv();
    const { client, tables } = fakeClient({ departmentCodes: ARCAAI_DEPARTMENT_CODES });

    await seedBootstrapTenantAdmin(client);

    expect(tables.userDepartment.rows[0]!.departmentId).toBe('dept-GEN');
  });

  it('joins a care-setting catalog at OPD — the department 91-user gives the Global tenant administrator', async () => {
    setEnv({ [V.tenantKey]: 'ACME' });
    const { client, tables } = fakeClient({ tenantKey: 'ACME', departmentCodes: CARE_SETTING_DEPARTMENT_CODES });

    await seedBootstrapTenantAdmin(client);

    expect(tables.userDepartment.rows[0]!.departmentId).toBe('dept-OPD');
  });

  it('falls back deterministically for a catalog with no general/front-door code', async () => {
    setEnv({ [V.tenantKey]: 'ACME' });
    const { client, tables } = fakeClient({ tenantKey: 'ACME', departmentCodes: ['ZED', 'CARD', 'MSK'] });

    await seedBootstrapTenantAdmin(client);

    expect(tables.userDepartment.rows[0]!.departmentId).toBe('dept-CARD');
  });

  it('refuses to mint an unloggable administrator when the tenant has no department', async () => {
    setEnv({ [V.tenantKey]: 'ACME' });
    const { client } = fakeClient({ tenantKey: 'ACME', departmentCodes: [] });

    await expect(seedBootstrapTenantAdmin(client)).rejects.toThrow(/department/i);
  });

  it('ignores DISABLED departments when choosing', async () => {
    setEnv();
    const { client, tables } = fakeClient({ departmentCodes: ARCAAI_DEPARTMENT_CODES });
    tables.department.rows.find((d) => d.code === 'GEN')!.resourceStatus = 'DISABLED';

    await seedBootstrapTenantAdmin(client);

    expect(tables.userDepartment.rows[0]!.departmentId).not.toBe('dept-GEN');
    expect(tables.userDepartment.rows[0]!.departmentId).toBe('dept-BREN');
  });
});

describe('idempotency and the upgrade path', () => {
  it('adds nothing on a re-seed', async () => {
    setEnv();
    const { client, tables } = fakeClient();

    await seedBootstrapTenantAdmin(client);
    const passwordHash = tables.user.rows[0]!.password;
    await seedBootstrapTenantAdmin(client);

    expect(tables.userDepartment.rows).toHaveLength(1);
    expect(tables.user.rows).toHaveLength(1);
    expect(tables.user.rows[0]!.password, 'a re-seed must never reset a rotated credential').toBe(passwordHash);
  });

  it('heals an ALREADY-PROVISIONED bootstrap admin that has no membership', async () => {
    // The account a deployment already created with the broken phase. `93` is
    // create-only keyed by the reserved id, so without this the fix would never
    // reach the very accounts it exists to repair.
    setEnv();
    const { client, tables, tenantId } = fakeClient();
    tables.user.rows.push({ id: BOOTSTRAP_TENANT_ADMIN_USER_ID, username: 'tenant-admin', password: 'pre-existing-hash' });
    tables.userRoleAssignment.rows.push({
      userId: BOOTSTRAP_TENANT_ADMIN_USER_ID,
      roleId: 'role-tenant-admin',
      tenantId,
      resourceStatus: 'ENABLED',
    });

    await seedBootstrapTenantAdmin(client);

    expect(await loginGateFindsMembership(tables, BOOTSTRAP_TENANT_ADMIN_USER_ID, tenantId)).not.toBeNull();
    expect(tables.user.rows[0]!.password, 'healing membership must not touch the credential').toBe('pre-existing-hash');
    expect(tables.user.creates).toBe(0);
  });

  it('does not fight an operator who DISABLED the membership', async () => {
    setEnv();
    const { client, tables, tenantId } = fakeClient();
    await seedBootstrapTenantAdmin(client);
    tables.userDepartment.rows[0]!.resourceStatus = 'DISABLED';

    await seedBootstrapTenantAdmin(client);

    // No second row on the same (tenant, user, department) — that unique index
    // (`user.prisma:329`) would reject the insert and break the Argo sync.
    expect(tables.userDepartment.rows).toHaveLength(1);
  });
});

describe('drift guard — the predicate this suite copies', () => {
  it('still matches the login gate in @arcaai/applications', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'applications/src/services/user/userDepartment/user-department.service.ts'),
      'utf8',
    );
    const gate = source.slice(source.indexOf('async findActiveDepartmentForUserInTenant'));
    const where = gate.slice(gate.indexOf('where: {'), gate.indexOf('},', gate.indexOf('where: {')));
    expect(where).toContain('userId');
    expect(where).toContain('tenantId');
    expect(where).toContain('resourceStatus: ResourceStatusType.ENABLED');
  });
});
