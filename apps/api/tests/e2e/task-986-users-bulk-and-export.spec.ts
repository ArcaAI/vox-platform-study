/**
 * TASK-986 · R5 + R6 — bulk delete over the REAL route, and selection-scoped export.
 *
 * Real HTTP round-trips against the live API (`pnpm test:up:api` then
 * `pnpm test:e2e`). This file exists because the defects it pins are invisible
 * to every layer above HTTP:
 *
 *   R5 · `DELETE /admin/users/bulk` was captured by the `/:id` delete route,
 *        which was declared first (Express registers in class-declaration
 *        order and `:id` matches any literal segment). Every caller of every
 *        credential class got `404 {"message":"User not found"}` and the
 *        `bulkDelete` handler was unreachable. The whole unit suite stayed
 *        green because it calls `controller.bulkDelete(...)` as a METHOD,
 *        which never touches the router. Only a real request proves the fix,
 *        which is why these tests assert the SHAPE of the bulk response body
 *        rather than just a non-404 status: a 200 from the shadowing route is
 *        still possible in principle, a `{ succeeded, failed }` envelope is not.
 *
 *   R6 · `GET /admin/users/export?ids=…` must NARROW the caller's tenant-scoped
 *        set, never reach outside it. The cross-tenant case is the point: a
 *        tenant admin naming an ArcaAI user id must get a file that does not
 *        contain that row.
 *
 * Every mutation targets throwaway users created inside the block; no seed row
 * is destroyed. Harness mirrors `users-bulk-role-export.spec.ts`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, SEEDED_ARCAAI_DOCTOR_ID, DEFAULT_TENANT_KEY, loginUser, generateUniqueSuffix } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface CreatedUser {
  id: string;
  username: string;
}

interface BulkDeleteResult {
  succeeded: Array<{ id: string }>;
  failed: Array<{ id: string; reason: string }>;
}

let saToken: string; // super_admin with NO tenant — cross-tenant reads only
let saGlobalToken: string; // super_admin logged INTO __GLOBAL__
let tenantAdminToken: string; // TENANT_ADMIN in __GLOBAL__ — the reported caller
let roleId: string;
let departmentId: string;

// `User.username` is globally unique and this is module scope (evaluated once
// per WORKER), so a bare Date.now() collides across parallel workers.
const UNIQUE = generateUniqueSuffix('_');

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

/**
 * Throwaway user created BY THE TENANT ADMIN, inside `__GLOBAL__`.
 *
 * Membership is not optional here: `User` carries no `tenantId`, so a
 * tenant-scoped create must name a role AND a department (400
 * `USER_ROLE_REQUIRED` / `USER_DEPARTMENT_REQUIRED` otherwise) — and without a
 * membership the tenant admin's own `assertUserInScope` would 404 on the row
 * it just made, which would make the delete assertions below meaningless.
 */
async function createUser(request: APIRequestContext, username: string): Promise<CreatedUser> {
  const res = await request.post('/api/v1/admin/users', {
    headers: bearer(tenantAdminToken),
    data: { username, password: 'Password123!', isServiceAccount: false, roleId, departmentId },
  });
  expect(res.status(), `create throwaway user ${username}: ${await res.text()}`).toBeLessThan(300);
  return (await res.json()) as CreatedUser;
}

async function deleteUser(request: APIRequestContext, id: string | undefined): Promise<void> {
  if (!id) return;
  await request.delete(`/api/v1/admin/users/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
}

test.beforeAll(async ({ request }) => {
  const [sa, saG, ta] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
  ]);
  expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  expect(ta, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
  saToken = sa!.token;
  saGlobalToken = saG!.token;
  tenantAdminToken = ta!.token;

  // Catalogues for the tenant-scoped create. NURSE is the lowest tier the
  // tenant admin may assign (`assertAssignableRoleTier`).
  const roles = asArray<{ id: string; name: string }>(
    await (await request.get('/api/v1/admin/rbac/roles', { headers: bearer(saGlobalToken) })).json(),
  );
  roleId = (roles.find((r) => r.name === 'NURSE') ?? roles.find((r) => r.name === 'DOCTOR'))?.id ?? '';
  expect(roleId, 'a seeded assignable role (NURSE/DOCTOR) must exist').toBeTruthy();
  const depts = asArray<{ id: string }>(await (await request.get('/api/v1/admin/departments', { headers: bearer(tenantAdminToken) })).json());
  departmentId = depts[0]?.id ?? '';
  expect(departmentId, 'the tenant must have at least one department').toBeTruthy();
});

// =============================================================================
// R5 — DELETE /admin/users/bulk reaches bulkDelete (route-shadowing regression)
// =============================================================================
test.describe.serial('TASK-986 R5 — DELETE /admin/users/bulk is not shadowed by /:id', () => {
  const BULK_URL = '/api/v1/admin/users/bulk';

  test('R5 regression: an EMPTY id list answers the bulk ENVELOPE, not the 404 of the :id route', async ({ request }) => {
    // Deletes nothing by construction — the narrowest possible probe of which
    // HANDLER the router picked. Before the fix this was
    // `404 {"message":"User not found","code":"HTTP.NOT_FOUND"}` because
    // `delete(id = 'bulk')` claimed the path.
    const res = await request.delete(BULK_URL, { headers: bearer(saGlobalToken), data: { ids: [] } });

    expect(res.status(), 'DELETE /admin/users/bulk must reach bulkDelete').toBe(200);
    const body = (await res.json()) as BulkDeleteResult;
    expect(body).toEqual({ succeeded: [], failed: [] });
  });

  test('R5 happy: a TENANT_ADMIN deletes several selected users in one call', async ({ request }) => {
    const [a, b] = await Promise.all([createUser(request, `t986bulk_a_${UNIQUE}`), createUser(request, `t986bulk_b_${UNIQUE}`)]);

    const res = await request.delete(BULK_URL, { headers: bearer(tenantAdminToken), data: { ids: [a.id, b.id] } });

    expect(res.status(), 'tenant admin bulk delete → 200').toBe(200);
    const body = (await res.json()) as BulkDeleteResult;
    expect(body.failed, JSON.stringify(body.failed)).toEqual([]);
    expect(body.succeeded.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());

    // Soft-deleted rows are filtered out of the by-id read.
    for (const id of [a.id, b.id]) {
      const after = await request.get(`/api/v1/admin/users/${id}`, { headers: bearer(saGlobalToken) });
      expect(after.status(), `user ${id} is gone after the bulk delete`).toBe(404);
    }
  });

  test('R5 partial failure: a CROSS-TENANT id lands under `failed` and is never deleted', async ({ request }) => {
    const mine = await createUser(request, `t986bulk_c_${UNIQUE}`);

    const res = await request.delete(BULK_URL, {
      headers: bearer(tenantAdminToken),
      data: { ids: [mine.id, SEEDED_ARCAAI_DOCTOR_ID] },
    });

    expect(res.status()).toBe(200);
    const body = (await res.json()) as BulkDeleteResult;
    expect(body.succeeded.map((row) => row.id)).toEqual([mine.id]);
    expect(body.failed.map((row) => row.id)).toEqual([SEEDED_ARCAAI_DOCTOR_ID]);

    // The foreign row survived (404-over-403 for the tenant admin; the
    // super-admin read proves it is still there).
    const survivor = await request.get(`/api/v1/admin/users/${SEEDED_ARCAAI_DOCTOR_ID}`, { headers: bearer(saToken) });
    expect(survivor.status(), 'the ArcaAI clinician must NOT have been deleted').toBe(200);
  });

  test('R5 sibling: the by-id delete still works (the reorder did not shadow it in reverse)', async ({ request }) => {
    const solo = await createUser(request, `t986bulk_d_${UNIQUE}`);

    const res = await request.delete(`/api/v1/admin/users/${solo.id}`, { headers: bearer(tenantAdminToken) });

    expect(res.status(), 'DELETE /admin/users/:id → 200').toBe(200);
    expect((await res.json()).id).toBe(solo.id);
  });
});

// =============================================================================
// R6 — GET /admin/users/export?ids=… exports the SELECTION, tenant-guarded
// =============================================================================
test.describe.serial('TASK-986 R6 — selection-scoped user export', () => {
  const EXPORT_URL = '/api/v1/admin/users/export';
  let u1: CreatedUser;
  let u2: CreatedUser;
  let u3: CreatedUser;

  test.beforeAll(async ({ request }) => {
    [u1, u2, u3] = await Promise.all([
      createUser(request, `t986exp_a_${UNIQUE}`),
      createUser(request, `t986exp_b_${UNIQUE}`),
      createUser(request, `t986exp_c_${UNIQUE}`),
    ]);
  });
  test.afterAll(async ({ request }) => {
    await Promise.all([deleteUser(request, u1?.id), deleteUser(request, u2?.id), deleteUser(request, u3?.id)]);
  });

  test('R6 happy: `ids` exports exactly the named rows and nothing else', async ({ request }) => {
    const res = await request.get(`${EXPORT_URL}?format=csv&ids=${u1.id},${u2.id}`, { headers: bearer(tenantAdminToken) });

    expect(res.status(), 'selection export → 200').toBe(200);
    const csv = await res.text();
    expect(csv).toContain(u1.username);
    expect(csv).toContain(u2.username);
    // The third throwaway is in the same tenant and matches the same filters —
    // it is excluded ONLY because it was not selected. That is the defect: the
    // export used to answer the whole view whatever was checked.
    expect(csv).not.toContain(u3.username);
  });

  test('R6 baseline: the SAME request without `ids` still exports the whole view', async ({ request }) => {
    const res = await request.get(`${EXPORT_URL}?format=csv`, { headers: bearer(tenantAdminToken) });

    expect(res.status()).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(u1.username);
    expect(csv).toContain(u3.username);
  });

  test('R6 security: naming a CROSS-TENANT id cannot pull that row into the file', async ({ request }) => {
    // The ArcaAI clinician is real and exists — it is simply not in the
    // tenant admin's scope. The id narrows the caller's OWN tenant-scoped
    // query, so the row is absent rather than fetched.
    const res = await request.get(`${EXPORT_URL}?format=csv&ids=${u1.id},${SEEDED_ARCAAI_DOCTOR_ID}`, {
      headers: bearer(tenantAdminToken),
    });

    expect(res.status(), 'a foreign id is not an error — the export is a set read').toBe(200);
    const csv = await res.text();
    expect(csv).toContain(u1.username);
    expect(csv, 'the cross-tenant row must NEVER appear in the file').not.toContain(SEEDED_ARCAAI_DOCTOR_ID);
    // …by id AND by username (`91-user.ts`), so a column-shape change cannot
    // quietly turn this into a vacuous assertion.
    expect(csv).not.toContain('arcaai_doctor');

    // And the SAME id read by a SUPER_ADMIN with no working tenant does
    // resolve — proving the row exists and the tenant admin's exclusion was
    // the scope, not a bad id.
    const asSuper = await request.get(`/api/v1/admin/users/${SEEDED_ARCAAI_DOCTOR_ID}`, { headers: bearer(saToken) });
    expect(asSuper.status()).toBe(200);
  });

  test('R6 validation: a non-UUID id is rejected (the id set is composed into a filter token)', async ({ request }) => {
    const res = await request.get(`${EXPORT_URL}?format=csv&ids=${encodeURIComponent('not-a-uuid;resourceStatus[equals]:DELETED')}`, {
      headers: bearer(tenantAdminToken),
    });

    expect(res.status(), 'a forged filter token must never reach the grammar').toBe(400);
  });

  test('R6: `ids` composes with the caller own filters rather than replacing them', async ({ request }) => {
    const res = await request.get(`${EXPORT_URL}?format=csv&ids=${u1.id},${u2.id}&filters=${encodeURIComponent('username[icontains]:t986exp_a')}`, {
      headers: bearer(tenantAdminToken),
    });

    expect(res.status()).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(u1.username);
    // ANDed, not replaced: u2 is selected but fails the username filter.
    expect(csv).not.toContain(u2.username);
  });
});
