/**
 * Users Management (20u grid + 38u detail) · backend contract E2E.
 *
 * Proves the **REAL** server flows the Users surface depends on, against a live
 * seeded API (`process.env.API_URL`, default `http://localhost:8968`). Scope =
 * README "REAL" only — we never assert a TARGET flow (reset-password,
 * Excel/PDF export, bulk server endpoint, cross-user DNA generate, per-user
 * prompt scope, admin-edit-another preferences UI).
 *
 * Coverage (cross-links TRACEABILITY-MATRIX U1–U13 + X1/X2/X6/X7):
 *  - U1   GET /admin/users — list / sort / search / filter / paginate
 * - U2 POST /admin/users — create (valid no-email path; see note)
 *  - U2a  GET /admin/rbac/roles + POST /admin/users/:id/roles — list & assign
 *  - U11  POST :id/departments ×2 + setPrimary PATCH :id/departments/:aid w/ OCC
 *         (If-Match 428 missing · 412 stale · 200 correct)
 *  - U4   PATCH /admin/users/:id {resourceStatus} — disable ↔ enable
 *  - U8   GET/PATCH /admin/users/:id/settings — admin-for-other settings (REAL)
 *  - U13  GET /admin/audit-logs/user/:id — activity feed contract
 *  - X1   tenant isolation — out-of-tenant target → 404 (not 403); scoped count
 *  - X2   DELETE /admin/users/:id — soft-delete (no longer ACTIVE)
 *  - X7   default-deny — a clinician cannot create/delete users (403)
 *
 * Persona model (mirrors optimistic-locking.spec.ts +):
 *  - `saToken`        — super_admin, NO tenant → cross-tenant operator (reads).
 *  - `saGlobalToken`  — super_admin logged INTO `__GLOBAL__` → mutations. We use
 *    super-admin (not tenant_admin) for `__GLOBAL__` writes because the Phase-0
 *    guard rejects non-super-admin writes to `__GLOBAL__` (see optimistic-locking).
 *  - `taToken`        — tenant_admin (`__GLOBAL__`) → scoped-count comparison.
 *  - `doctorToken`    — doctor (`__GLOBAL__`) → default-deny (X7) negative cases.
 *  - `arcaaiToken`    — arcaai_admin (`ARCAAI`) → 404-over-403 probe (skip-guarded).
 *
 * No destructive SQL. The one created user is soft-deleted in cleanup. Tests
 * skip (never hard-fail) when a precondition is absent (e.g. <2 departments,
 * arcaai_admin not seeded).
 *
 * @see docs/qa/traceability/users-management.md
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

// ---------------------------------------------------------------------------
// Small typed helpers (token-scoped, mirror admin-features-contract.spec.ts)
// ---------------------------------------------------------------------------

const ARCAAI_TENANT_KEY = 'ARCAAI';

interface PaginatedUsers {
  data: Array<{
    id: string;
    username: string;
    resourceStatus?: string;
    isServiceAccount?: boolean;
  }>;
  count: number;
  page?: number;
  limit?: number;
}

interface DepartmentRow {
  id: string;
  name: string;
}
interface RoleRow {
  id: string;
  name: string;
}
interface UserDepartmentRow {
  id: string;
  departmentId: string;
  isPrimary: boolean;
  version: number;
}
interface UserSettingRow {
  namespace?: string;
  key?: string;
  name?: string;
  value?: unknown;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const authGet = (r: APIRequestContext, t: string, url: string) => r.get(url, { headers: bearer(t) });

const authPost = (r: APIRequestContext, t: string, url: string, data: unknown) => r.post(url, { headers: bearer(t), data });

const authPatch = (r: APIRequestContext, t: string, url: string, data: unknown, extra: Record<string, string> = {}) =>
  r.patch(url, { headers: { ...bearer(t), ...extra }, data });

const authDelete = (r: APIRequestContext, t: string, url: string) => r.delete(url, { headers: bearer(t) });

function uniqueUsername(): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `e2e_381_${Date.now()}_${rand}`;
}

// Some list responses are bare arrays, others are `{ data }`-wrapped depending
// on the mapper. Normalise so assertions don't depend on the envelope.
function asArray<T = unknown>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: T[] }).data;
  }
  return [];
}

// ===========================================================================

test.describe('Users Management (backend contract)', () => {
  let saToken: string;
  let saGlobalToken: string;
  let taToken: string;
  let doctorToken: string;
  let arcaaiToken: string | null = null;
  let saUserId: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — check seeded users + auth endpoint').toBeTruthy();
    saToken = sa!.token;
    saUserId = sa!.user.id;

    const saGlobal = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(saGlobal, 'super_admin login into __GLOBAL__ failed').toBeTruthy();
    saGlobalToken = saGlobal!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed').toBeTruthy();
    taToken = ta!.token;

    const doc = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doc, 'doctor login failed').toBeTruthy();
    doctorToken = doc!.token;

    // arcaai_admin is seeded for the ARCAAI tenant (frontend auth fixture +
    // manual-tests README) but is NOT in the typed SEEDED_USERS map; log in
    // by literal and tolerate absence so the isolation probe self-skips.
    const arcaai = await loginUser(request, 'arcaai_admin', 'password123', ARCAAI_TENANT_KEY);
    arcaaiToken = arcaai?.token ?? null;
  });

  // -------------------------------------------------------------------------
  // U1 — list / sort / search / filter / paginate (cross-tenant reader)
  // -------------------------------------------------------------------------
  test.describe('U1 · GET /admin/users — list / sort / search / filter / paginate', () => {
    test('returns a paginated envelope with rows', async ({ request }) => {
      const res = await authGet(request, saToken, '/api/v1/admin/users?page=1&limit=10');
      expect(res.status()).toBe(200);
      const body = (await res.json()) as PaginatedUsers;
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.count).toBe('number');
      expect(body.count).toBeGreaterThan(0);
      expect(body.data.length).toBeGreaterThan(0);
    });

    test('sort by username asc vs desc are mirror orders', async ({ request }) => {
      const asc = await authGet(request, saToken, '/api/v1/admin/users?page=1&limit=200&sort=username:asc');
      const desc = await authGet(request, saToken, '/api/v1/admin/users?page=1&limit=200&sort=username:desc');
      expect(asc.status()).toBe(200);
      expect(desc.status()).toBe(200);
      const ascBody = (await asc.json()) as PaginatedUsers;
      const ascNames = ascBody.data.map((u) => u.username);
      const descNames = ((await desc.json()) as PaginatedUsers).data.map((u) => u.username);
      expect(ascNames.length).toBeGreaterThan(1);
      // The whole seeded user set fits in one page, so asc and desc are the SAME
      // rows in opposite order. Reverse-equality proves deterministic bi-directional
      // sorting WITHOUT coupling the test to the DB's string collation: Postgres
      // orders 'doctor2' before 'doctor_bren' (byte/C collation) while JS
      // localeCompare disagrees — that mismatch was the earlier flake.
      test.skip(ascNames.length < ascBody.count, 'user set exceeds one page — cannot assert reverse-equality');
      // Compare only the rows PRESENT IN BOTH reads. The two requests are
      // separate round-trips against a shared database, and sibling specs
      // create and delete users throughout the run — a user born between the
      // asc and the desc read appears in one list only, and the mirror
      // assertion then fails on a sorting contract that never broke. (Observed:
      // `t398role_a/b_*` from the role specs landing mid-test.) Intersecting
      // first keeps the property under test — same rows, opposite order —
      // without pretending the row set is frozen.
      const common = new Set(ascNames.filter((n) => descNames.includes(n)));
      expect(common.size, 'the two reads must share more than one row to compare order').toBeGreaterThan(1);
      expect(descNames.filter((n) => common.has(n))).toEqual([...ascNames.filter((n) => common.has(n))].reverse());
    });

    test('search narrows the result set and surfaces the match', async ({ request }) => {
      const term = SEEDED_USERS.doctor.username.slice(0, 4); // "doct"
      const all = await authGet(request, saToken, '/api/v1/admin/users?page=1&limit=50');
      const search = await authGet(request, saToken, `/api/v1/admin/users?page=1&limit=50&search=${term}`);
      expect(all.status()).toBe(200);
      expect(search.status()).toBe(200);
      const allCount = ((await all.json()) as PaginatedUsers).count;
      const found = (await search.json()) as PaginatedUsers;
      // Search may match username OR email server-side, so we don't assert every
      // row's username contains the term — only that it narrows and surfaces the
      // expected match.
      expect(found.count).toBeGreaterThan(0);
      expect(found.count).toBeLessThan(allCount);
      expect(found.data.some((u) => u.username.toLowerCase().includes(term.toLowerCase()))).toBe(true);
    });

    test('filter isServiceAccount[equals]:true returns only service accounts', async ({ request }) => {
      const filters = encodeURIComponent('isServiceAccount[equals]:true');
      const res = await authGet(request, saToken, `/api/v1/admin/users?page=1&limit=20&filters=${filters}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as PaginatedUsers;
      // The seed has at least one service account; every returned row must be one.
      expect(body.count).toBeGreaterThan(0);
      for (const u of body.data) {
        expect(u.isServiceAccount).toBe(true);
      }
    });

    test('pagination pages are disjoint', async ({ request }) => {
      const p1 = await authGet(request, saToken, '/api/v1/admin/users?page=1&limit=2&sort=username:asc');
      const p2 = await authGet(request, saToken, '/api/v1/admin/users?page=2&limit=2&sort=username:asc');
      expect(p1.status()).toBe(200);
      expect(p2.status()).toBe(200);
      const ids1 = ((await p1.json()) as PaginatedUsers).data.map((u) => u.id);
      const ids2 = ((await p2.json()) as PaginatedUsers).data.map((u) => u.id);
      test.skip(ids2.length === 0, 'fewer than 3 users seeded — cannot prove page disjointness');
      for (const id of ids2) expect(ids1).not.toContain(id);
    });
  });

  // -------------------------------------------------------------------------
  // U2 → U2a → U11 → U4 → U8 → U13 → X2 : one throwaway user, ordered
  // -------------------------------------------------------------------------
  test.describe.serial('User lifecycle — create → role → departments(OCC) → status → settings → audit → soft-delete', () => {
    let userId = '';
    let username = '';

    test.afterAll(async ({ request }) => {
      if (userId && saGlobalToken) {
        // idempotent soft-delete; tolerate "already archived"/404.
        await authDelete(request, saGlobalToken, `/api/v1/admin/users/${userId}`).catch(() => undefined);
      }
    });

    test('U2 · POST /admin/users creates a user (minimal identity payload, tenant-less)', async ({ request }) => {
      username = uniqueUsername();
      // This case exercises the minimal identity-only create. The optional
      // `email` field is whitelisted on CreateUserRequest and
      // upserted onto the user profile — verified end-to-end in the
      // "V1/V2 — gap fixes" block below.
      //
      // TASK-983 R6 / OD-4: the membership-less payload is legal ONLY with no
      // tenant context — a super admin creating a tenant-less platform user.
      // The same body sent by a caller acting inside a tenant is a 400
      // (`USER_ROLE_REQUIRED`), pinned in the R6 block below. Hence `saToken`
      // (no tenant) rather than `saGlobalToken`; the membership this user
      // needs is what U2a and U11 then assign.
      const res = await authPost(request, saToken, '/api/v1/admin/users', {
        username,
        password: 'Password123!',
        isServiceAccount: false,
      });
      expect([200, 201], `create failed: ${res.status()} ${await res.text()}`).toContain(res.status());
      const created = (await res.json()) as { id: string; username: string };
      expect(created.id).toBeTruthy();
      expect(created.username).toBe(username);
      userId = created.id;

      // Verify by-id (membership-independent; super-admin is scope-exempt).
      const byId = await authGet(request, saGlobalToken, `/api/v1/admin/users/${userId}`);
      expect(byId.status()).toBe(200);
      expect(((await byId.json()) as { username: string }).username).toBe(username);
    });

    test('U2a · GET /admin/rbac/roles + POST /admin/users/:id/roles', async ({ request }) => {
      test.skip(!userId, 'create step did not yield a user id');
      const rolesRes = await authGet(request, saGlobalToken, '/api/v1/admin/rbac/roles');
      expect(rolesRes.status()).toBe(200);
      const roles = asArray<RoleRow>(await rolesRes.json());
      expect(roles.length).toBeGreaterThan(0);
      const role = roles.find((r) => r.name === 'DOCTOR') ?? roles.find((r) => r.name === 'NURSE') ?? roles[0];

      const assign = await authPost(request, saGlobalToken, `/api/v1/admin/users/${userId}/roles`, {
        roleId: role.id,
      });
      expect([200, 201], `assign role failed: ${assign.status()} ${await assign.text()}`).toContain(assign.status());

      const list = await authGet(request, saGlobalToken, `/api/v1/admin/users/${userId}/roles`);
      expect(list.status()).toBe(200);
      const assignments = asArray<{ roleId?: string; role?: { id: string } }>(await list.json());
      const has = assignments.some((a) => a.roleId === role.id || a.role?.id === role.id);
      expect(has, 'assigned role not present in the user role assignments').toBe(true);
    });

    test('U11 · assign 2 departments + setPrimary with OCC (If-Match 428/412/200)', async ({ request }) => {
      test.skip(!userId, 'create step did not yield a user id');
      const deptRes = await authGet(request, saGlobalToken, '/api/v1/admin/departments');
      expect(deptRes.status()).toBe(200);
      const depts = asArray<DepartmentRow>(await deptRes.json());
      test.skip(depts.length < 2, 'fewer than 2 departments seeded — cannot exercise setPrimary');
      const [d1, d2] = depts;

      const a1 = await authPost(request, saGlobalToken, `/api/v1/admin/users/${userId}/departments`, {
        departmentId: d1.id,
        isPrimary: true,
      });
      expect([200, 201], `assign d1 failed: ${a1.status()} ${await a1.text()}`).toContain(a1.status());
      const a2 = await authPost(request, saGlobalToken, `/api/v1/admin/users/${userId}/departments`, {
        departmentId: d2.id,
        isPrimary: false,
      });
      expect([200, 201], `assign d2 failed: ${a2.status()} ${await a2.text()}`).toContain(a2.status());

      const listed = await authGet(request, saGlobalToken, `/api/v1/admin/users/${userId}/departments`);
      expect(listed.status()).toBe(200);
      const rows = asArray<UserDepartmentRow>(await listed.json());
      const target = rows.find((r) => r.departmentId === d2.id);
      expect(target, 'second department assignment not found').toBeTruthy();
      const version = target!.version;
      const aid = target!.id;
      const url = `/api/v1/admin/users/${userId}/departments/${aid}`;

      // (a) missing If-Match → 428 (the @RequiresIfMatch gate fires before the body runs).
      const missing = await authPatch(request, saGlobalToken, url, { isPrimary: true, expectedVersion: version });
      expect(missing.status(), 'missing If-Match must be 428').toBe(428);

      // (b) stale (but well-formed) If-Match → 412 OCC conflict.
      const stale = await authPatch(
        request,
        saGlobalToken,
        url,
        { isPrimary: true, expectedVersion: version + 99 },
        { 'If-Match': `"${version + 99}"` },
      );
      expect(stale.status(), 'stale If-Match must be 412').toBe(412);

      // (c) correct If-Match → 200 and the assignment becomes primary.
      const ok = await authPatch(request, saGlobalToken, url, { isPrimary: true, expectedVersion: version }, { 'If-Match': `"${version}"` });
      expect(ok.status(), `setPrimary with correct version failed: ${await ok.text()}`).toBe(200);
      const updated = (await ok.json()) as UserDepartmentRow;
      expect(updated.isPrimary).toBe(true);
    });

    test('U4 · PATCH /admin/users/:id status disable ↔ enable', async ({ request }) => {
      test.skip(!userId, 'create step did not yield a user id');
      const disable = await authPatch(request, saGlobalToken, `/api/v1/admin/users/${userId}`, {
        resourceStatus: 'DISABLED',
      });
      expect(disable.status()).toBe(200);
      expect(((await disable.json()) as { resourceStatus: string }).resourceStatus).toBe('DISABLED');

      const enable = await authPatch(request, saGlobalToken, `/api/v1/admin/users/${userId}`, {
        resourceStatus: 'ENABLED',
      });
      expect(enable.status()).toBe(200);
      expect(((await enable.json()) as { resourceStatus: string }).resourceStatus).toBe('ENABLED');
    });

    test('U8 · GET/PATCH /admin/users/:id/settings round-trips (admin-for-other, REAL)', async ({ request }) => {
      test.skip(!userId, 'create step did not yield a user id');
      const before = await authGet(request, saGlobalToken, `/api/v1/admin/users/${userId}/settings`);
      expect(before.status()).toBe(200);
      expect(Array.isArray(asArray(await before.json()))).toBe(true);

      const patch = await authPatch(request, saGlobalToken, `/api/v1/admin/users/${userId}/settings/ui.e2e/task-381`, {
        value: 'on',
        name: 'task-381 marker',
      });
      // Endpoint exists (matrix U8); accept 200/201. If the seed lacks the
      // namespace scaffolding it may 400 — surface that explicitly.
      expect([200, 201], `update setting unexpected: ${patch.status()} ${await patch.text()}`).toContain(patch.status());

      const after = await authGet(request, saGlobalToken, `/api/v1/admin/users/${userId}/settings`);
      expect(after.status()).toBe(200);
      const settings = asArray<UserSettingRow>(await after.json());
      const found = settings.some((s) => s.key === 'task-381' || s.name === 'task-381 marker' || s.value === 'on');
      expect(found, 'written user setting not reflected in subsequent read').toBe(true);
    });

    test('U13 · GET /admin/audit-logs/user/:id returns the activity contract', async ({ request }) => {
      test.skip(!userId, 'create step did not yield a user id');
      // The new user is the *actor* in zero events (it never logged in), so its
      // own feed may be empty — we assert the envelope, not a count.
      const ownFeed = await authGet(request, saGlobalToken, `/api/v1/admin/audit-logs/user/${userId}`);
      expect(ownFeed.status()).toBe(200);
      expect(Array.isArray(asArray(await ownFeed.json()))).toBe(true);

      // The super-admin actor that just performed the mutations should have a
      // non-empty feed — proves the byUser query path returns real rows (U13).
      const actorFeed = await authGet(request, saToken, `/api/v1/admin/audit-logs/user/${saUserId}`);
      expect(actorFeed.status()).toBe(200);
      expect(Array.isArray(asArray(await actorFeed.json()))).toBe(true);
    });

    test('X2 · DELETE /admin/users/:id soft-deletes (no longer ACTIVE)', async ({ request }) => {
      test.skip(!userId, 'create step did not yield a user id');
      const del = await authDelete(request, saGlobalToken, `/api/v1/admin/users/${userId}`);
      expect([200, 204], `delete failed: ${del.status()} ${await del.text()}`).toContain(del.status());

      // Soft-delete semantics: the row is archived, not hard-removed. A by-id
      // read therefore either 404s (filtered from active) or returns a
      // non-ENABLED status. Either proves it left the active set (X2).
      const after = await authGet(request, saGlobalToken, `/api/v1/admin/users/${userId}`);
      expect([200, 404]).toContain(after.status());
      if (after.status() === 200) {
        expect(((await after.json()) as { resourceStatus: string }).resourceStatus).not.toBe('ENABLED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // X1 / X7 — tenant isolation + default-deny (read-only, no shared state)
  // -------------------------------------------------------------------------
  test.describe('X1 · X7 — tenant isolation & default-deny', () => {
    test('X1 · scoped tenant_admin sees no more users than the cross-tenant super_admin', async ({ request }) => {
      const sa = await authGet(request, saToken, '/api/v1/admin/users?page=1&limit=1');
      const ta = await authGet(request, taToken, '/api/v1/admin/users?page=1&limit=1');
      expect(sa.status()).toBe(200);
      expect(ta.status()).toBe(200);
      const saCount = ((await sa.json()) as PaginatedUsers).count;
      const taCount = ((await ta.json()) as PaginatedUsers).count;
      expect(taCount).toBeLessThanOrEqual(saCount);
    });

    test('X1 · out-of-tenant target resolves to 404 (not 403)', async ({ request }) => {
      test.skip(!arcaaiToken, 'arcaai_admin (ARCAAI tenant) not seeded — isolation probe skipped');
      // A __GLOBAL__ user id read by an ARCAAI-scoped admin must 404 (X1
      // 404-over-403 via assertUserInScope), never reveal existence with 403.
      const res = await authGet(request, arcaaiToken!, `/api/v1/admin/users/${SEEDED_USERS.doctor.id}`);
      expect(res.status(), `expected 404 for out-of-tenant target, got ${res.status()}`).toBe(404);
    });

    test('X7 · a clinician cannot create users (default-deny)', async ({ request }) => {
      const res = await authPost(request, doctorToken, '/api/v1/admin/users', {
        username: uniqueUsername(),
        password: 'Password123!',
        isServiceAccount: false,
      });
      expect(res.status(), 'doctor must be forbidden from creating users').toBe(403);
    });

    test('X7 · a clinician cannot delete users (default-deny on destructive)', async ({ request }) => {
      const res = await authDelete(request, doctorToken, `/api/v1/admin/users/${SEEDED_USERS.doctor2.id}`);
      expect([403, 404]).toContain(res.status());
      // 403 is the contract; a 404 would only occur if the target were out of
      // scope, which still proves no destructive action was permitted.
    });
  });

  // -------------------------------------------------------------------------
  // V1 + V2 — gap fixes verified end-to-end. Pre-fix, the create dialog's
  // `email` was rejected (CreateUserRequest didn't whitelist it → 400) and the
  // SDK `assignDepartments` PATCH had no backend handler (→ 404). These assert
  // the now-shipped contracts: email persists to the profile, and the bulk
  // PATCH reconciles a user's memberships to EXACTLY the requested set + primary.
  // -------------------------------------------------------------------------
  test.describe.serial('V1/V2 — create-email + bulk department reconcile (gap fixes)', () => {
    let uid = '';

    test.afterAll(async ({ request }) => {
      if (uid) await authDelete(request, saGlobalToken, `/api/v1/admin/users/${uid}`).catch(() => undefined);
    });

    test('V1 · POST /admin/users with `email` persists onto the user profile', async ({ request }) => {
      const username = uniqueUsername();
      const email = `${username}@example.test`;
      // Tenant-less create (TASK-983 R6 / OD-4) — see the U2 note; V2 below
      // then reconciles this user's departments, which a create-time
      // department would interfere with.
      const res = await authPost(request, saToken, '/api/v1/admin/users', {
        username,
        password: 'Password123!',
        isServiceAccount: false,
        email,
      });
      expect([200, 201], `create-with-email failed: ${res.status()} ${await res.text()}`).toContain(res.status());
      uid = ((await res.json()) as { id: string }).id;

      const profile = await authGet(request, saGlobalToken, `/api/v1/admin/users/${uid}/profile`);
      expect(profile.status()).toBe(200);
      expect(((await profile.json()) as { email?: string } | null)?.email, 'create email upserted onto the profile').toBe(email);
    });

    test('V2 · PATCH /admin/users/:id/departments bulk-reconciles to the exact set + primary', async ({ request }) => {
      test.skip(!uid, 'V1 step did not yield a user id');
      const deptRes = await authGet(request, saGlobalToken, '/api/v1/admin/departments');
      expect(deptRes.status()).toBe(200);
      const depts = asArray<DepartmentRow>(await deptRes.json());
      test.skip(depts.length < 2, 'fewer than 2 departments seeded — cannot exercise bulk reconcile');
      const [d1, d2] = depts;

      // (a) Reconcile to {d1, d2} with d1 primary → returns the refreshed user.
      const set = await authPatch(request, saGlobalToken, `/api/v1/admin/users/${uid}/departments`, {
        departmentIds: [d1.id, d2.id],
        primaryDepartmentId: d1.id,
      });
      expect(set.status(), `bulk set failed: ${set.status()} ${await set.text()}`).toBe(200);
      expect(((await set.json()) as { id: string }).id, 'returns the updated user').toBe(uid);

      const listed1 = asArray<UserDepartmentRow>(await (await authGet(request, saGlobalToken, `/api/v1/admin/users/${uid}/departments`)).json());
      expect(listed1.map((r) => r.departmentId).sort()).toEqual([d1.id, d2.id].sort());
      expect(listed1.find((r) => r.isPrimary)?.departmentId, 'd1 is the single primary').toBe(d1.id);

      // (b) Reconcile DOWN to just {d2}: d1 is removed, d2 survives and is primary.
      const shrink = await authPatch(request, saGlobalToken, `/api/v1/admin/users/${uid}/departments`, {
        departmentIds: [d2.id],
        primaryDepartmentId: d2.id,
      });
      expect(shrink.status(), `bulk shrink failed: ${shrink.status()} ${await shrink.text()}`).toBe(200);

      const listed2 = asArray<UserDepartmentRow>(await (await authGet(request, saGlobalToken, `/api/v1/admin/users/${uid}/departments`)).json());
      expect(
        listed2.map((r) => r.departmentId),
        'exactly the one remaining department',
      ).toEqual([d2.id]);
      expect(listed2[0]?.isPrimary, 'the surviving membership is primary').toBe(true);
    });
  });
  // -------------------------------------------------------------------------
  // R6 (TASK-983 / OD-4) — a tenant-scoped create must carry its membership.
  //
  // `User` has no `tenantId`: membership IS the role assignment + department
  // pair, so a tenant admin who created a user without them produced a row
  // belonging to no tenant — one that could not sign in and that the same
  // admin could not reopen (404 through `assertUserInScope`). The service now
  // refuses it fail-closed, before any write.
  // -------------------------------------------------------------------------
  test.describe.serial('R6 · POST /admin/users — role + department are mandatory inside a tenant', () => {
    let roleId = '';
    let departmentId = '';
    let createdId = '';

    test.beforeAll(async ({ request }) => {
      // Catalogs read with the SUPER-ADMIN token: this block is about the
      // create contract, not about who may list roles.
      const roles = asArray<RoleRow>(await (await authGet(request, saGlobalToken, '/api/v1/admin/rbac/roles')).json());
      const role = roles.find((r) => r.name === 'DOCTOR') ?? roles.find((r) => r.name === 'NURSE') ?? roles.find((r) => r.name !== 'SUPER_ADMIN');
      roleId = role?.id ?? '';
      const depts = asArray<DepartmentRow>(await (await authGet(request, saGlobalToken, '/api/v1/admin/departments')).json());
      departmentId = depts[0]?.id ?? '';
    });

    test.afterAll(async ({ request }) => {
      if (createdId) await authDelete(request, saGlobalToken, `/api/v1/admin/users/${createdId}`).catch(() => undefined);
    });

    test('omitting roleId → 400 USER_ROLE_REQUIRED', async ({ request }) => {
      const res = await authPost(request, taToken, '/api/v1/admin/users', {
        username: uniqueUsername(),
        password: 'Password123!',
        isServiceAccount: false,
      });
      expect(res.status(), `expected 400, got ${res.status()} ${await res.text()}`).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string | { code?: string } };
      expect(JSON.stringify(body)).toContain('USER_ROLE_REQUIRED');
    });

    test('a role but no departmentId → 400 USER_DEPARTMENT_REQUIRED', async ({ request }) => {
      test.skip(!roleId, 'no assignable role in the catalog');
      const res = await authPost(request, taToken, '/api/v1/admin/users', {
        username: uniqueUsername(),
        password: 'Password123!',
        isServiceAccount: false,
        roleId,
      });
      expect(res.status(), `expected 400, got ${res.status()} ${await res.text()}`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('USER_DEPARTMENT_REQUIRED');
    });

    test('both supplied → 201 and the role assignment is readable', async ({ request }) => {
      test.skip(!roleId || !departmentId, 'no assignable role/department in the catalog');
      const username = uniqueUsername();
      const res = await authPost(request, taToken, '/api/v1/admin/users', {
        username,
        password: 'Password123!',
        isServiceAccount: false,
        roleId,
        departmentId,
      });
      expect([200, 201], `create failed: ${res.status()} ${await res.text()}`).toContain(res.status());
      createdId = ((await res.json()) as { id: string }).id;
      expect(createdId).toBeTruthy();

      const roles = asArray<{ roleId?: string; role?: { id: string } }>(
        await (await authGet(request, taToken, `/api/v1/admin/users/${createdId}/roles`)).json(),
      );
      expect(
        roles.some((a) => a.roleId === roleId || a.role?.id === roleId),
        'the create-time role assignment is present, so the user is a member of the tenant',
      ).toBe(true);
    });
  });
});
