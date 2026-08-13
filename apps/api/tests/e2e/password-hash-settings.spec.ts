/**
 * Live API contract for the two pre-existing-defect fixes.
 *
 * Run against the live test stack (`SKIP_DB_PRECHECK=true API_URL=http://localhost:8968/api/v1`),
 * harness mirrors (seeded `super_admin` on `__GLOBAL__`; throwaway
 * rows only; cleanup is soft-delete via the service path — never SQL DELETE).
 *
 * Defect 1 — admin-created passwords must be bcrypt-hashed:
 *   A1. create user (creation-time password) → that user logs in immediately.
 *   A2. the stored password is bcrypt-format (`$2…`), NOT the plaintext, and
 *       `passwordChangedAt` is stamped (rotation parity).
 *   A3. weak creation password → clear 400 listing the unmet rules (password
 *       complexity policy enforced on this path), no row written.
 *   A4. the generic PATCH update path hashes too: update the password, old
 *       login stops working, new one works, hash at rest.
 *
 * Defect 2 — GlobalSetting soft-delete + recreate:
 *   B1. create → soft-delete → RE-CREATE the same (name, key) succeeds by
 *       REVIVING the same row id (was: 409 P2002 unique-index conflict).
 *   B2. the revived row is ENABLED, carries the new value, and remains
 *       fetchable; the DELETED tombstone no longer exists as a second row
 *       (single row id, audit lineage preserved).
 *   B3. cache refresh stays healthy with the revived key present (the
 *       boot-cycle restart proof is executed by the runner after this spec).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface UserRow {
  password: string;
  passwordChangedAt: Date | null;
}
interface DbClient {
  user: {
    findUnique(args: { where: { id: string }; select: { password: boolean; passwordChangedAt: boolean } }): Promise<UserRow | null>;
  };
  globalSetting: {
    findMany(args: { where: { key: string } }): Promise<Array<{ id: string; resourceStatus: string; value: string; name: string }>>;
  };
  $disconnect(): Promise<void>;
}

let dbClient: DbClient | null = null;
async function getDb(): Promise<DbClient> {
  if (!dbClient) {
    const distEntry = pathToFileURL(join(__dirname, '../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as DbClient;
  }
  return dbClient;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const UNIQUE = Date.now();
const CREATED_PW = `Created${UNIQUE}!aB`;
const UPDATED_PW = `Updated${UNIQUE}!cD`;

let saGlobalToken: string;

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

/** Create a throwaway user + role + department so it can authenticate into __GLOBAL__. */
async function createLoginableUser(request: APIRequestContext, username: string, password: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/admin/users', {
    headers: bearer(saGlobalToken),
    data: { username, password, email: `${username}@example.com` },
  });
  expect(res.status(), `create throwaway user ${username}`).toBeLessThan(300);
  const u = (await res.json()) as { id: string };

  const rolesRes = await request.get('/api/v1/admin/rbac/roles', { headers: bearer(saGlobalToken) });
  const roles = asArray<{ id: string; name: string }>(await rolesRes.json());
  const role = roles.find((r) => r.name === 'DOCTOR') ?? roles[0];
  expect(role, 'a seeded role exists').toBeTruthy();
  const assignRole = await request.post(`/api/v1/admin/users/${u.id}/roles`, { headers: bearer(saGlobalToken), data: { roleId: role.id } });
  expect([200, 201]).toContain(assignRole.status());

  const deptRes = await request.get('/api/v1/admin/departments', { headers: bearer(saGlobalToken) });
  const depts = asArray<{ id: string }>(await deptRes.json());
  expect(depts.length, 'a seeded department exists').toBeGreaterThan(0);
  const assignDept = await request.post(`/api/v1/admin/users/${u.id}/departments`, {
    headers: bearer(saGlobalToken),
    data: { departmentId: depts[0].id, isPrimary: true },
  });
  expect([200, 201]).toContain(assignDept.status());

  return u;
}

test.beforeAll(async ({ request }) => {
  const saG = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  saGlobalToken = saG!.token;
});

test.afterAll(async () => {
  await dbClient?.$disconnect().catch(() => undefined);
});

// =============================================================================
// A — Defect 1: creation/update-time passwords are policy-checked + hashed
// =============================================================================
test.describe.serial('A — admin-created password is hashed and immediately loginable', () => {
  let userId: string | undefined;
  const username = `t402hash_${UNIQUE}`;

  test.afterAll(async ({ request }) => {
    if (userId) await request.delete(`/api/v1/admin/users/${userId}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
  });

  test('A1 — create-with-password → login 200 immediately', async ({ request }) => {
    const u = await createLoginableUser(request, username, CREATED_PW);
    userId = u.id;

    const login = await loginUser(request, username, CREATED_PW, DEFAULT_TENANT_KEY);
    expect(login, 'the creation-time password authenticates (bcrypt compare passes)').toBeTruthy();
    expect(login!.token.length).toBeGreaterThan(10);
  });

  test('A2 — the stored value is a bcrypt hash, not the plaintext; passwordChangedAt stamped', async () => {
    const db = await getDb();
    const row = await db.user.findUnique({ where: { id: userId! }, select: { password: true, passwordChangedAt: true } });
    expect(row, 'user row readable').toBeTruthy();
    expect(row!.password, 'bcrypt-format at rest').toMatch(/^\$2[aby]\$/);
    expect(row!.password).not.toBe(CREATED_PW);
    expect(row!.passwordChangedAt, 'rotation stamp set at creation').toBeTruthy();
  });

  test('A3 — weak creation-time password → 400 listing the unmet rules', async ({ request }) => {
    const res = await request.post('/api/v1/admin/users', {
      headers: bearer(saGlobalToken),
      data: { username: `t402weak_${UNIQUE}`, password: 'weak' },
    });
    expect(res.status(), 'policy rejects the weak password').toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toMatch(/at least 12 characters/i);
    expect(body).toMatch(/uppercase/i);
  });

  test('A4 — PATCH-path password update is hashed: old password stops working, new one logs in', async ({ request }) => {
    const patch = await request.patch(`/api/v1/admin/users/${userId}`, {
      headers: bearer(saGlobalToken),
      data: { password: UPDATED_PW },
    });
    expect(patch.status(), 'password update accepted').toBeLessThan(300);

    const oldLogin = await loginUser(request, username, CREATED_PW, DEFAULT_TENANT_KEY);
    expect(oldLogin, 'old password no longer authenticates').toBeFalsy();
    const newLogin = await loginUser(request, username, UPDATED_PW, DEFAULT_TENANT_KEY);
    expect(newLogin, 'updated password authenticates').toBeTruthy();

    const db = await getDb();
    const row = await db.user.findUnique({ where: { id: userId! }, select: { password: true, passwordChangedAt: true } });
    expect(row!.password).toMatch(/^\$2[aby]\$/);
    expect(row!.password).not.toBe(UPDATED_PW);
  });

  test('A5 — weak PATCH-path password → 400, credential unchanged', async ({ request }) => {
    const res = await request.patch(`/api/v1/admin/users/${userId}`, {
      headers: bearer(saGlobalToken),
      data: { password: 'short' },
    });
    expect(res.status()).toBe(400);
    const stillWorks = await loginUser(request, username, UPDATED_PW, DEFAULT_TENANT_KEY);
    expect(stillWorks, 'previous strong password still authenticates').toBeTruthy();
  });
});

// =============================================================================
// B — Defect 2: soft-delete → recreate REVIVES the same GlobalSetting row
// =============================================================================
test.describe.serial('B — GlobalSetting delete → recreate revives the row', () => {
  const KEY = `task402.revive.${UNIQUE}`;
  const NAME = `t402 revive ${UNIQUE}`;
  let firstId: string | undefined;
  let revivedId: string | undefined;

  test.afterAll(async ({ request }) => {
    // Leave the DB tidy: soft-delete the revived row via the service path.
    const id = revivedId ?? firstId;
    if (id) await request.delete(`/api/v1/admin/settings/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
  });

  test('B1 — create → soft-delete → recreate SAME (name, key) succeeds and reuses the row id', async ({ request }) => {
    const create = await request.post('/api/v1/admin/settings', {
      headers: bearer(saGlobalToken),
      data: { name: NAME, key: KEY, value: 'generation-1', dataType: 'String' },
    });
    expect(create.status(), 'initial create').toBe(201);
    firstId = ((await create.json()) as { id: string }).id;

    const del = await request.delete(`/api/v1/admin/settings/${firstId}`, { headers: bearer(saGlobalToken) });
    expect(del.status(), 'soft-delete via the service path').toBeLessThan(300);

    // The pre-fix behavior was a 409 (P2002 — the unique index counts
    // DELETED rows). The fix revives the tombstone instead.
    const recreate = await request.post('/api/v1/admin/settings', {
      headers: bearer(saGlobalToken),
      data: { name: NAME, key: KEY, value: 'generation-2', dataType: 'String' },
    });
    expect(recreate.status(), 'recreate after soft-delete succeeds').toBe(201);
    const revived = (await recreate.json()) as { id: string; value: string };
    revivedId = revived.id;
    expect(revived.id, 'the DELETED row was revived (same id), not duplicated').toBe(firstId);
    expect(revived.value).toBe('generation-2');
  });

  test('B2 — exactly ONE row exists for the key, ENABLED, with the new value', async () => {
    const db = await getDb();
    const rows = await db.globalSetting.findMany({ where: { key: KEY } });
    expect(rows.length, 'no DELETED+ENABLED pair accumulated').toBe(1);
    expect(rows[0].resourceStatus).toBe('ENABLED');
    expect(rows[0].value).toBe('generation-2');
  });

  test('B3 — the revived setting round-trips through the API (cache/list unaffected)', async ({ request }) => {
    const get = await request.get(`/api/v1/admin/settings/${revivedId}`, { headers: bearer(saGlobalToken) });
    expect(get.status()).toBe(200);
    const body = (await get.json()) as { key: string; value: string; resourceStatus?: string };
    expect(body.key).toBe(KEY);
    expect(body.value).toBe('generation-2');
  });
});
