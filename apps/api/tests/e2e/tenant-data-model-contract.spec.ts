/**
 * Tenant data-model + department backlog (Group B) backend contract.
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968`). Mirrors the harness of
 * tenant-detail-contract.spec.ts (seeded `super_admin` = cross-tenant operator;
 * a second `super_admin` session bound to `__GLOBAL__` for tenant-scoped writes;
 * `tenant_admin`/`doctor` pinned to `__GLOBAL__`).
 *
 * Coverage (ticket §Items):
 *   #3 plan   · create surfaces `plan`; fetch reflects it; PATCH updates it (OCC).
 *   #2 tags   · PUT /admin/tenants/:id/tags replaces the set; GET reads it back.
 *   #1 F6     · POST suspend/archive/restore transitions `resourceStatus`.
 *   #1 ADM-002· suspend/archive/DELETE on the `__GLOBAL__` system tenant → 403.
 *   #1 RBAC   · lifecycle transitions are super-admin-only (tenant_admin/doctor 403).
 *   #6 D2     · GET /admin/departments/:id/users → paginated; 404 unknown; doctor 403.
 *   #7 D3     · PATCH prompt-config `dnaWritingStylePromptId` (OCC) round-trips.
 *
 * All mutations target throwaway rows (a fresh tenant + a fresh department) and are
 * cleaned up in afterAll — no seed rows are mutated destructively.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface Paginated<T> {
  data: T[];
  count: number;
  limit?: number;
  page?: number;
}
interface TenantDto {
  id: string;
  name: string;
  key: string;
  plan?: string | null;
  tags?: string[];
  resourceStatus?: string;
  version: number;
}
interface DepartmentDto {
  id: string;
  name?: string;
  dnaWritingStylePromptId?: string | null;
  resourceStatus?: string;
  version: number;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const ifMatch = (v: number) => ({ 'If-Match': `"${v}"` });
const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: bearer(token), params });

/** Department list is a bare `DepartmentResponse[]`; normalise just in case. */
function _asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

let superToken: string; // super_admin, NO tenant key — cross-tenant operator
let superInTenantToken: string; // super_admin bound to __GLOBAL__ — tenant-scoped writes
let tenantAdminToken: string; // tenant_admin pinned to __GLOBAL__
let doctorToken: string; // plain member in __GLOBAL__
let globalTenantId: string; // __GLOBAL__ tenant uuid (the system tenant)

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

  const res = await authGet(request, '/api/v1/admin/tenants', superToken, { limit: '200' });
  expect(res.status(), 'operator can list the fleet').toBe(200);
  const fleet = (await res.json()) as Paginated<TenantDto>;
  globalTenantId = fleet.data.find((t) => (t.key || '').toUpperCase() === '__GLOBAL__')!.id;
  expect(globalTenantId, 'seed ships the __GLOBAL__ system tenant').toBeTruthy();
});

// =============================================================================
// #3 plan · #2 tags · #1 lifecycle — on a throwaway tenant
// =============================================================================
test.describe.serial('tenant plan / tags / lifecycle (#1/#2/#3)', () => {
  let tenantId: string;

  const _getVersion = async (request: APIRequestContext): Promise<number> => {
    const res = await authGet(request, `/api/v1/admin/tenants/${tenantId}`, superToken);
    expect(res.status()).toBe(200);
    return ((await res.json()) as TenantDto).version;
  };

  test.beforeAll(async ({ request }) => {
    // #3 + #2 — create carrying plan + tags, and assert they surface on the create response.
    const res = await request.post('/api/v1/admin/tenants', {
      headers: bearer(superToken),
      data: { name: `TASK-387 E2E Tenant ${UNIQUE}`, key: `TASK387E2E${UNIQUE}`, plan: 'TRIAL', tags: ['pilot'] },
    });
    expect(res.status(), 'super_admin creates the throwaway tenant').toBeLessThan(300);
    const body = (await res.json()) as TenantDto;
    tenantId = body.id;
    expect(body.plan, '#3 create response carries the plan').toBe('TRIAL');
    expect(body.tags, '#2 create response carries the tags').toContain('pilot');
  });

  test.afterAll(async ({ request }) => {
    if (tenantId) {
      // Restore (in case a test left it archived) then soft-delete. Best-effort.
      await request.post(`/api/v1/admin/tenants/${tenantId}/restore`, { headers: bearer(superToken) });
      await request.delete(`/api/v1/admin/tenants/${tenantId}`, { headers: bearer(superToken) });
    }
  });

  test('#3 plan: fetch reflects the plan and PATCH updates it (If-Match OCC)', async ({ request }) => {
    const getRes = await authGet(request, `/api/v1/admin/tenants/${tenantId}`, superToken);
    expect(getRes.status()).toBe(200);
    const t = (await getRes.json()) as TenantDto;
    expect(t.plan, 'created plan is surfaced on read').toBe('TRIAL');

    const patch = await request.patch(`/api/v1/admin/tenants/${tenantId}`, {
      headers: { ...bearer(superToken), ...ifMatch(t.version) },
      // `expectedVersion` is required in the body too (OCC belt-and-suspenders
      // with the If-Match header — mirrors task-379's edit contract).
      data: { plan: 'PRO', expectedVersion: t.version },
    });
    expect(patch.status(), 'plan PATCH succeeds').toBe(200);
    expect(((await patch.json()) as TenantDto).plan, 'plan updated TRIAL → PRO').toBe('PRO');
  });

  test('#2 tags: PUT replaces the set; GET reads it back; [] clears it', async ({ request }) => {
    const put = await request.put(`/api/v1/admin/tenants/${tenantId}/tags`, {
      headers: bearer(superToken),
      data: { tags: ['priority', 'vip'] },
    });
    expect(put.status(), 'super_admin sets tags').toBe(200);
    expect(((await put.json()) as TenantDto).tags?.slice().sort()).toEqual(['priority', 'vip']);

    const get = await authGet(request, `/api/v1/admin/tenants/${tenantId}/tags`, superToken);
    expect(get.status()).toBe(200);
    expect(((await get.json()) as { tags: string[] }).tags.slice().sort()).toEqual(['priority', 'vip']);

    const clear = await request.put(`/api/v1/admin/tenants/${tenantId}/tags`, {
      headers: bearer(superToken),
      data: { tags: [] },
    });
    expect(clear.status()).toBe(200);
    expect(((await clear.json()) as TenantDto).tags).toEqual([]);
  });

  test('#1 lifecycle: suspend → archive → restore transitions resourceStatus', async ({ request }) => {
    const suspend = await request.post(`/api/v1/admin/tenants/${tenantId}/suspend`, { headers: bearer(superToken) });
    expect(suspend.status(), 'suspend → 200').toBe(200);
    expect(((await suspend.json()) as TenantDto).resourceStatus).toBe('SUSPENDED');

    const archive = await request.post(`/api/v1/admin/tenants/${tenantId}/archive`, { headers: bearer(superToken) });
    expect(archive.status(), 'archive → 200').toBe(200);
    expect(((await archive.json()) as TenantDto).resourceStatus).toBe('ARCHIVED');

    const restore = await request.post(`/api/v1/admin/tenants/${tenantId}/restore`, { headers: bearer(superToken) });
    expect(restore.status(), 'restore → 200').toBe(200);
    expect(((await restore.json()) as TenantDto).resourceStatus).toBe('ENABLED');
  });

  test('#1 RBAC: lifecycle transitions are super-admin-only (tenant_admin + doctor → 403)', async ({ request }) => {
    for (const token of [tenantAdminToken, doctorToken]) {
      const res = await request.post(`/api/v1/admin/tenants/${tenantId}/suspend`, { headers: bearer(token) });
      expect(res.status(), 'non-super-admin cannot suspend a tenant').toBe(403);
    }
  });

  test('#1 DEF-ADM-002: the __GLOBAL__ system tenant cannot be suspended/archived/deleted', async ({ request }) => {
    const suspend = await request.post(`/api/v1/admin/tenants/${globalTenantId}/suspend`, { headers: bearer(superToken) });
    expect(suspend.status(), 'suspend system tenant is blocked').toBe(403);

    const archive = await request.post(`/api/v1/admin/tenants/${globalTenantId}/archive`, { headers: bearer(superToken) });
    expect(archive.status(), 'archive system tenant is blocked').toBe(403);

    const del = await request.delete(`/api/v1/admin/tenants/${globalTenantId}`, { headers: bearer(superToken) });
    expect(del.status(), 'delete system tenant is blocked').toBe(403);
  });
});

// =============================================================================
// #6 dept→users · #7 per-dept DNA writing-style slot — on a throwaway department
// =============================================================================
test.describe.serial('department users + DNA writing-style slot (#6/#7)', () => {
  let deptId: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/v1/admin/departments', {
      headers: bearer(superInTenantToken),
      data: { name: `TASK-387 E2E Dept ${UNIQUE}`, code: `T387D${String(UNIQUE).slice(-8)}`, description: 'task-387 — safe to delete' },
    });
    expect(res.status(), 'creates the throwaway department').toBeLessThan(300);
    deptId = ((await res.json()) as DepartmentDto).id;
    expect(deptId, 'department id returned').toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (deptId) {
      await request.delete(`/api/v1/admin/departments/${deptId}`, { headers: bearer(superInTenantToken) });
    }
  });

  test('#6 D2: GET /admin/departments/:id/users returns the paginated house envelope', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/departments/${deptId}/users`, superInTenantToken, { page: '1', limit: '10' });
    expect(res.status(), 'dept users listing → 200').toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(Array.isArray(body.data), 'paginated data[] envelope').toBe(true);
    expect(typeof body.count, 'count is numeric').toBe('number');
    // A freshly-created department has no members yet.
    expect(body.count, 'fresh department has zero members').toBe(0);
  });

  test('#6 D2: unknown department id → 404', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/departments/00000000-0000-0000-0000-0000000387ff/users', superInTenantToken);
    expect(res.status(), 'unknown department → 404').toBe(404);
  });

  test('#6 D2: a plain doctor is not a Department manager → 403', async ({ request }) => {
    const res = await authGet(request, `/api/v1/admin/departments/${deptId}/users`, doctorToken);
    expect(res.status(), 'doctor forbidden (manage:Department)').toBe(403);
  });

  test('#7 D3: PATCH prompt-config sets dnaWritingStylePromptId (OCC) and it round-trips', async ({ request }) => {
    const getRes = await authGet(request, `/api/v1/admin/departments/${deptId}`, superInTenantToken);
    expect(getRes.status()).toBe(200);
    const version = ((await getRes.json()) as DepartmentDto).version;

    const dnaPromptId = `task387-dna-${UNIQUE}`;
    const patch = await request.patch(`/api/v1/admin/departments/${deptId}/prompt-config`, {
      headers: { ...bearer(superInTenantToken), ...ifMatch(version) },
      data: { dnaWritingStylePromptId: dnaPromptId, expectedVersion: version },
    });
    expect(patch.status(), 'prompt-config PATCH succeeds').toBe(200);
    expect(((await patch.json()) as DepartmentDto).dnaWritingStylePromptId, 'DNA slot echoed on write').toBe(dnaPromptId);

    const verify = await authGet(request, `/api/v1/admin/departments/${deptId}`, superInTenantToken);
    expect(verify.status()).toBe(200);
    expect(((await verify.json()) as DepartmentDto).dnaWritingStylePromptId, 'DNA slot persisted').toBe(dnaPromptId);
  });
});
