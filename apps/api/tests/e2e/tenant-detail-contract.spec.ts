/**
 * Page-based Tenant Detail + App-Shell — backend contract verification.
 *
 * Exercises the REAL server side of every data flow the page-based Tenant Detail
 * surface drives, against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968`). Each flow is a real
 * HTTP round-trip with the seeded users (`tests/helpers`).
 *
 * Traceability (see ../../../../docs/qa/traceability/tenant-detail.md):
 *   F1  list tenants .................. GET    /admin/tenants
 *   F2  get one tenant ................ GET    /admin/tenants/:id
 *   F3  create tenant ................. POST   /admin/tenants            (super-admin only)
 *   F4  edit tenant (OCC) ............. PATCH  /admin/tenants/:id         (If-Match REQUIRED)
 *   F5  enable / disable .............. PATCH  /admin/tenants/:id {resourceStatus}
 *   F8  working tenant ................ GET    /tenant/me
 *   C1  config OCC .................... GET/PATCH /admin/tenants/configs/:identifier
 *                                       GET    /admin/tenant-frontend-config
 *   S1  storage buckets ............... GET    /admin/tenants/storage/buckets
 *   D1  departments CRUD .............. GET/POST/PATCH /admin/departments (PATCH If-Match)
 *   D4  member assignment ............. POST/GET/DELETE /admin/users/:id/departments
 *   X1  tenant isolation .............. 404-over-403 on a cross-tenant config read
 *
 * TARGET flows (tenant tags, SUSPENDED/ARCHIVED archive, storage quota/usage
 * roll-ups) are intentionally NOT asserted — they have no backend and are drawn
 * disabled/em-dash in the UI (README §4.6). Nothing here fabricates them.
 *
 * Non-destructive: the create/update/enable/disable lifecycle runs on a THROWAWAY
 * tenant that is deleted in afterAll; the department flow runs on a throwaway
 * department (soft-deleted) and re-uses the seeded `doctor`. The OCC-conflict
 * assertions deliberately fail the Compare-And-Set, so no row is mutated.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

// --- wire shapes (only the fields this spec reads) ---------------------------
interface Tenant {
  id: string;
  name: string;
  key: string;
  description?: string;
  resourceStatus?: string;
  version: number;
}
interface Paginated<T> {
  data: T[];
  count: number;
}
interface TenantConfig {
  id: string;
  key: string;
  value: string;
  version: number;
}
interface Department {
  id: string;
  name?: string;
  code?: string;
  resourceStatus?: string;
  version: number;
}
interface UserDepartment {
  id: string;
  departmentId: string;
  isPrimary?: boolean;
}

// --- auth + verb helpers -----------------------------------------------------
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const ifMatch = (v: number) => ({ 'If-Match': `"${v}"` });

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: bearer(token), params });
const authPost = (request: APIRequestContext, path: string, token: string, data?: unknown, headers?: Record<string, string>) =>
  request.post(path, { headers: { ...bearer(token), ...headers }, data });
const authPatch = (request: APIRequestContext, path: string, token: string, data?: unknown, headers?: Record<string, string>) =>
  request.patch(path, { headers: { ...bearer(token), ...headers }, data });
const authDelete = (request: APIRequestContext, path: string, token: string, headers?: Record<string, string>) =>
  request.delete(path, { headers: { ...bearer(token), ...headers } });

// --- shared sessions / fixtures (resolved once) ------------------------------
let superToken: string; // super_admin WITHOUT a tenantKey — cross-tenant operator
let superInTenantToken: string; // super_admin bound to __GLOBAL__ — for tenant-scoped writes
let tenantAdminToken: string; // tenant_admin pinned to __GLOBAL__
let doctorToken: string; // a plain member in __GLOBAL__
let globalTenantId: string; // __GLOBAL__ tenant uuid
let foreignTenantId: string | undefined; // a non-__GLOBAL__ tenant uuid (e.g. ARCAAI) for isolation

const UNIQUE = Date.now();

test.beforeAll(async ({ request }) => {
  const [op, opInTenant, admin, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(op, 'super_admin (operator) login failed — is the stack seeded?').toBeTruthy();
  expect(opInTenant, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  expect(admin, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
  superToken = op!.token;
  superInTenantToken = opInTenant!.token;
  tenantAdminToken = admin!.token;
  doctorToken = doc!.token;

  // Resolve the __GLOBAL__ id + a foreign tenant id from the operator fleet view.
  const res = await authGet(request, '/api/v1/admin/tenants', superToken, { limit: '200' });
  expect(res.status(), 'operator can list the fleet').toBe(200);
  const fleet = (await res.json()) as Paginated<Tenant>;
  globalTenantId = fleet.data.find((t) => t.key === DEFAULT_TENANT_KEY)!.id;
  foreignTenantId = fleet.data.find((t) => t.key !== DEFAULT_TENANT_KEY)?.id;
  expect(globalTenantId, 'seed ships the __GLOBAL__ tenant').toBeTruthy();
});

// =============================================================================
// F1 / F2 — tenant fleet list & detail read
// =============================================================================
test.describe('tenant fleet list & detail (F1/F2)', () => {
  test('F1: GET /admin/tenants requires authentication (401)', async ({ request }) => {
    const res = await request.get('/api/v1/admin/tenants');
    expect(res.status()).toBe(401);
  });

  test('F1: super-admin lists the fleet with a paginated envelope', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants', superToken, { limit: '50' });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<Tenant>;
    expect(Array.isArray(body.data), 'fleet is a data[] envelope').toBe(true);
    expect(body.count, 'seed ships at least the __GLOBAL__ tenant').toBeGreaterThanOrEqual(1);
    expect(
      body.data.every((t) => typeof t.version === 'number'),
      'every row carries an OCC version (for the edit dialog)',
    ).toBe(true);
  });

  test('F2: GET /admin/tenants/:id round-trips the detail row', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/tenants/${globalTenantId}`, superToken);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Tenant;
    expect(body.id).toBe(globalTenantId);
    expect(body.key).toBe(DEFAULT_TENANT_KEY);
    expect(typeof body.version, 'detail read returns the OCC version the edit dialog echoes back').toBe('number');
  });
});

// =============================================================================
// F3 / F4 / F5 — create → edit (OCC) → enable/disable lifecycle (throwaway tenant)
// =============================================================================
test.describe.serial('tenant create / edit (If-Match) / enable / disable (F3/F4/F5)', () => {
  let tenantId: string;

  const getVersion = async (request: APIRequestContext): Promise<number> => {
    const res = await authGet(request, `/api/v1/admin/tenants/${tenantId}`, superToken);
    expect(res.status()).toBe(200);
    return ((await res.json()) as Tenant).version;
  };

  test.afterAll(async ({ request }) => {
    // Cleanup — delete the throwaway tenant (super-admin only). Best-effort.
    if (tenantId) {
      await authDelete(request, `/api/v1/admin/tenants/${tenantId}`, superToken);
    }
  });

  test('F3: super-admin creates a tenant', async ({ request }) => {
    const res = await authPost(request, '/api/v1/admin/tenants', superToken, {
      name: `E2E-379 Throwaway ${UNIQUE}`,
      key: `E2E379T${UNIQUE}`,
      description: 'task-379 backend contract — safe to delete',
    });
    expect([200, 201], 'tenant create succeeds').toContain(res.status());
    const body = (await res.json()) as Tenant;
    tenantId = body.id;
    expect(tenantId).toBeTruthy();
    expect(body.key).toBe(`E2E379T${UNIQUE}`);
    // BaseEntity rows start at _version = 1.
    expect(body.version).toBeGreaterThanOrEqual(1);
  });

  test('F3: a non-super-admin create is forbidden (403, action-permission gate)', async ({ request }) => {
    // POST /admin/tenants is @CanManage('Tenant') — strictly super-admin. A
    // 403 (not 404) is correct: this is an action the doctor lacks, not a
    // resource whose existence we must hide.
    const res = await authPost(request, '/api/v1/admin/tenants', doctorToken, {
      name: 'should-not-create',
      key: `NOPE${UNIQUE}`,
    });
    expect(res.status()).toBe(403);
  });

  test('F4: PATCH without If-Match is rejected (428 Precondition Required)', async ({ request }) => {
    const version = await getVersion(request);
    // A fully-valid body (incl. expectedVersion) so the ONLY thing missing is
    // the RFC 7232 header — proves the @RequiresIfMatch() 428 contract.
    const res = await authPatch(request, `/api/v1/admin/tenants/${tenantId}`, superToken, {
      name: 'no-if-match',
      expectedVersion: version,
    });
    expect(res.status()).toBe(428);
  });

  test('F4: PATCH with a stale If-Match conflicts (412 Precondition Failed)', async ({ request }) => {
    const version = await getVersion(request);
    const stale = version + 999; // a version that cannot match the stored _version → CAS fails, no write
    const res = await authPatch(
      request,
      `/api/v1/admin/tenants/${tenantId}`,
      superToken,
      { name: 'stale-version', expectedVersion: stale },
      ifMatch(stale),
    );
    expect(res.status()).toBe(412);
  });

  test('F4: PATCH with the current If-Match updates the name (OCC happy path)', async ({ request }) => {
    const version = await getVersion(request);
    const newName = `E2E-379 Renamed ${UNIQUE}`;
    const res = await authPatch(
      request,
      `/api/v1/admin/tenants/${tenantId}`,
      superToken,
      { name: newName, expectedVersion: version },
      ifMatch(version),
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Tenant;
    expect(body.name).toBe(newName);
    expect(body.version, 'a successful write bumps the OCC version').toBeGreaterThan(version);
  });

  test('F5: disable then re-enable the tenant (resourceStatus, OCC)', async ({ request }) => {
    // Disable
    let version = await getVersion(request);
    const disabled = await authPatch(
      request,
      `/api/v1/admin/tenants/${tenantId}`,
      superToken,
      { resourceStatus: 'DISABLED', expectedVersion: version },
      ifMatch(version),
    );
    expect(disabled.status()).toBe(200);
    expect(((await disabled.json()) as Tenant).resourceStatus).toBe('DISABLED');

    // Re-enable (read the freshly-bumped version first)
    version = await getVersion(request);
    const enabled = await authPatch(
      request,
      `/api/v1/admin/tenants/${tenantId}`,
      superToken,
      { resourceStatus: 'ENABLED', expectedVersion: version },
      ifMatch(version),
    );
    expect(enabled.status()).toBe(200);
    expect(((await enabled.json()) as Tenant).resourceStatus).toBe('ENABLED');
  });
});

// =============================================================================
// C1 — tenant configuration read + OCC
// =============================================================================
test.describe('tenant configuration OCC (C1)', () => {
  test('C1: GET /admin/tenant-frontend-config returns 200 (config or null)', async ({ request }) => {
    // The Configuration page's data source. A global-admin operator targets a
    // tenant via ?tenantId=. Body may be null when not yet configured.
    const res = await authGet(request, '/api/v1/admin/tenant-frontend-config', superToken, { tenantId: globalTenantId });
    expect(res.status()).toBe(200);
  });

  test('C1: tenant KV configs carry an OCC version token', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/tenants/configs/${globalTenantId}`, superToken, { limit: '50' });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<TenantConfig>;
    expect(Array.isArray(body.data)).toBe(true);
    for (const row of body.data) {
      expect(typeof row.version, `config "${row.key}" exposes a version for OCC`).toBe('number');
    }
  });

  test('C1: a stale expectedVersion is rejected (412, no write)', async ({ request }) => {
    // Prefer a non-system tenant (less likely to hold locked rows); fall back
    // to __GLOBAL__. The CAS fails on the bumped version, so nothing is written.
    const target = foreignTenantId ?? globalTenantId;
    const list = await authGet(request, `/api/v1/admin/tenants/configs/${target}`, superToken, { limit: '50' });
    expect(list.status()).toBe(200);
    const rows = ((await list.json()) as Paginated<TenantConfig>).data;
    test.skip(rows.length === 0, 'no tenant config rows seeded to exercise OCC conflict');

    const row = rows[0];
    const res = await authPatch(request, `/api/v1/admin/tenants/configs/${target}`, superToken, [
      { id: row.id, value: row.value, expectedVersion: row.version + 999 },
    ]);
    expect(res.status(), 'stale expectedVersion → 412 Precondition Failed').toBe(412);
  });
});

// =============================================================================
// S1 — storage buckets (list only; quota/objects/size are TARGET, not asserted)
// =============================================================================
test.describe('tenant storage buckets (S1)', () => {
  test('S1: GET /admin/tenants/storage/buckets requires authentication (401)', async ({ request }) => {
    const res = await request.get('/api/v1/admin/tenants/storage/buckets');
    expect(res.status()).toBe(401);
  });

  test('S1: lists buckets for the working tenant (array envelope)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants/storage/buckets', superInTenantToken);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), 'buckets are returned as an array (objects/size/quota are TARGET, not asserted)').toBe(true);
  });
});

// =============================================================================
// D1 / D4 — departments CRUD + member assignment (throwaway department)
// =============================================================================
test.describe.serial('departments CRUD (D1) + member assignment (D4)', () => {
  let departmentId: string;
  const doctorId = SEEDED_USERS.doctor.id;

  const getDeptVersion = async (request: APIRequestContext): Promise<number> => {
    const res = await authGet(request, `/api/v1/admin/departments/${departmentId}`, superInTenantToken);
    expect(res.status()).toBe(200);
    return ((await res.json()) as Department).version;
  };

  test.afterAll(async ({ request }) => {
    if (departmentId) {
      await authDelete(request, `/api/v1/admin/departments/${departmentId}`, superInTenantToken);
    }
  });

  test('D1: lists departments (tenant-scoped array)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/departments', superInTenantToken);
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('D1: creates a department', async ({ request }) => {
    const res = await authPost(request, '/api/v1/admin/departments', superInTenantToken, {
      name: `E2E-379 Dept ${UNIQUE}`,
      code: `E379D${String(UNIQUE).slice(-8)}`,
      description: 'task-379 backend contract — safe to delete',
    });
    expect([200, 201]).toContain(res.status());
    const body = (await res.json()) as Department;
    departmentId = body.id;
    expect(departmentId).toBeTruthy();
    expect(body.version).toBeGreaterThanOrEqual(1);
  });

  test('D2: gets the department by id', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/departments/${departmentId}`, superInTenantToken);
    expect(res.status()).toBe(200);
    expect(((await res.json()) as Department).id).toBe(departmentId);
  });

  test('D1: PATCH without If-Match is rejected (428)', async ({ request }) => {
    const version = await getDeptVersion(request);
    const res = await authPatch(request, `/api/v1/admin/departments/${departmentId}`, superInTenantToken, {
      name: 'no-if-match',
      expectedVersion: version,
    });
    expect(res.status()).toBe(428);
  });

  test('D1: updates the department with a valid If-Match', async ({ request }) => {
    const version = await getDeptVersion(request);
    const newName = `E2E-379 Dept Renamed ${UNIQUE}`;
    const res = await authPatch(
      request,
      `/api/v1/admin/departments/${departmentId}`,
      superInTenantToken,
      { name: newName, expectedVersion: version },
      ifMatch(version),
    );
    expect(res.status()).toBe(200);
    expect(((await res.json()) as Department).name).toBe(newName);
  });

  test('D4: assigns the seeded doctor, lists the assignment, then unassigns', async ({ request }) => {
    // Assign
    const assign = await authPost(request, `/api/v1/admin/users/${doctorId}/departments`, superInTenantToken, {
      departmentId,
    });
    expect([200, 201], 'doctor assigned to the new department').toContain(assign.status());

    // List → the assignment is present
    const listed = await authGet(request, `/api/v1/admin/users/${doctorId}/departments`, superInTenantToken);
    expect(listed.status()).toBe(200);
    const assignments = (await listed.json()) as UserDepartment[];
    const mine = assignments.find((a) => a.departmentId === departmentId);
    expect(mine, 'the new assignment shows up in the user-department list').toBeTruthy();

    // Unassign (soft delete) → 204
    const removed = await authDelete(request, `/api/v1/admin/users/${doctorId}/departments/${mine!.id}`, superInTenantToken);
    expect(removed.status()).toBe(204);
  });
});

// =============================================================================
// F8 — working-tenant context (/tenant/me)
// =============================================================================
test.describe('working-tenant context /tenant/me (F8)', () => {
  test('F8: a cross-tenant operator with no working tenant gets 400 (no silent fallback)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/tenant/me', superToken);
    expect(res.status(), 'super-admin operator must pick a tenant — no global fallback').toBe(400);
  });

  test('F8: a tenant-admin resolves their working tenant', async ({ request }) => {
    const res = await authGet(request, '/api/v1/tenant/me', tenantAdminToken);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Tenant;
    expect(body.key).toBe(DEFAULT_TENANT_KEY);
  });
});

// =============================================================================
// X1 — tenant isolation (404-over-403)
// =============================================================================
test.describe('tenant isolation (X1, 404-over-403)', () => {
  test('X1: a tenant-admin fleet view is scoped to their own tenant', async ({ request }) => {
    const opRes = await authGet(request, '/api/v1/admin/tenants', superToken, { limit: '200' });
    const taRes = await authGet(request, '/api/v1/admin/tenants', tenantAdminToken, { limit: '200' });
    expect(opRes.status()).toBe(200);
    expect(taRes.status()).toBe(200);
    const opCount = ((await opRes.json()) as Paginated<Tenant>).count;
    const ta = (await taRes.json()) as Paginated<Tenant>;
    expect(ta.count, 'tenant-admin sees their own tenant only').toBeGreaterThanOrEqual(1);
    expect(
      ta.data.every((t) => t.key === DEFAULT_TENANT_KEY),
      'every visible row is the admin\u2019s own tenant',
    ).toBe(true);
    expect(ta.count, 'the operator (cross-tenant) sees strictly more than the scoped admin').toBeLessThan(opCount);
  });

  test('X1: a cross-tenant config read resolves 404, not 403 (no existence leak)', async ({ request }) => {
    test.skip(!foreignTenantId, 'only the __GLOBAL__ tenant is seeded — no foreign tenant to probe');
    // The tenant-admin is pinned to __GLOBAL__; reading a DIFFERENT tenant's
    // configs by uuid hits assertConfigInScope, which throws NotFoundException
    // (404) rather than ForbiddenException (403) so existence never leaks.
    const res = await authGet(request, `/api/v1/admin/tenants/configs/${foreignTenantId}`, tenantAdminToken);
    expect(res.status(), '404-over-403 — cross-tenant resource reads must not reveal existence').toBe(404);
  });
});
