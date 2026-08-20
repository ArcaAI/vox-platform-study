/**
 * Role-members cross-tenant contract
 * (`GET /api/v1/admin/rbac/roles/:id/members` + `memberCount` on the role reads).
 *
 * Mirrors the cross-tenant posture specs: live-stack proof that the
 * members listing is TENANT-SCOPED and that cross-tenant access never leaks
 * (404-over-403; other tenants' member rows are simply absent).
 *
 * Contract under test:
 *   M1. Envelope — `{ data, total, page, pageSize }`; rows carry the
 *       RoleMemberResponse projection (assignmentId, userId, tenantId,
 *       username, displayName, resourceStatus, assignedAt).
 *   M2. Unscoped SUPER_ADMIN (no CLS tenant) sees assignments across ALL
 *       tenants, and the role read's `memberCount` equals the listing total.
 *   M3. A super admin acting AS a tenant (`X-Tenant-Id`) sees ONLY that
 *       tenant's assignments; `memberCount` follows the working tenant and
 *       equals the scoped listing total.
 *   M4. A tenant-bound TENANT_ADMIN sees ONLY their own tenant's assignments
 *       — cross-tenant member rows (incl. SYSTEM-tenant platform admins) are
 *       absent, and the scoped `memberCount` equals the scoped total.
 *   M5. Unknown role id → 404 for every caller; the body never leaks
 *       tenant/ownership hints, and there is NO 403 on the members surface
 *       for a permitted-but-tenant-bound caller (404-over-403 posture).
 *   M6. Pagination — `pageSize` caps the page, `page`/`pageSize` echo back,
 *       and consecutive pages return distinct assignments.
 *
 * Seeded anchors (dev/test seed, `packages/database/src/prisma/db_main/seed/`):
 *   - SUPER_ADMIN role (00000000-…-0003): its holder (`super_admin`)
 *     lives under the SYSTEM tenant 00000000-…-0000, so any
 *     listing scoped to the default tenant 50000000-…-0000 must NOT show them.
 *   - DOCTOR role (00000000-…-0010): many members across more than one
 *     tenant — the tenant-consistency oracle for scoped listings.
 * Role ids are DISCOVERED by name from the roles list (not hardcoded) so the
 * spec survives reseeds; assertions are relational (tenant-consistency,
 * count-equals-total) rather than absolute row counts, because the shared dev
 * stack may gain rows while the suite runs.
 *
 * Login discipline: the shared gateway strict-throttles auth (10 req/60s) and
 * other agents share the window, so each user logs in ONCE per run with a
 * patient 429 backoff, and tokens are reused across tests (serial mode keeps
 * everything in one worker).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

/** Reserved seed UUIDs (00-constants.ts). */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/**
 * Unscoped platform admin. The seeded `super_admin` is SUPER_ADMIN and logs
 * in WITHOUT a tenant key — its JWT carries `tenantId: ''`, i.e. no CLS
 * tenant, the unscoped read posture under test.
 */
const SUPER_ADMIN = { username: 'super_admin', password: 'password123' };

/** uuidv7-shaped id no role has ever had — the 404 shape probe. */
const SYNTHETIC_ROLE_ID = '018f0000-0000-7200-8000-000000000000';

interface MemberRow {
  assignmentId: string;
  userId: string;
  tenantId: string;
  username: string;
  displayName: string;
  email: string | null;
  department: string | null;
  resourceStatus: string;
  userResourceStatus: string;
  assignedAt: string;
}

interface MembersEnvelope {
  data: MemberRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface RoleRow {
  id: string;
  name: string;
  memberCount?: number;
}

/**
 * Login with patient backoff — the auth endpoints sit on the strict throttle
 * tier (10 req/60s) which concurrent agents on the shared dev gateway keep
 * warm; a bare login can 429 through no fault of this spec. One login per
 * user per run, retried across the window, tokens reused everywhere after.
 */
async function loginWithBackoff(request: APIRequestContext, username: string, password: string, tenantKey?: string): Promise<string> {
  let lastError = 'no attempt made';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const login = await loginUser(request, username, password, tenantKey);
    if (login) return login.token;
    lastError = `loginUser returned null on attempt ${attempt} (see [e2e.helper] warning above — usually a 429 from the strict auth throttle)`;
    // Strict tier window is 60s; wait out a healthy slice of it.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new Error(`login failed for ${username}: ${lastError}`);
}

async function fetchMembers(
  request: APIRequestContext,
  token: string,
  roleId: string,
  query = 'page=1&pageSize=50',
  tenantId?: string,
): Promise<MembersEnvelope> {
  const res = await request.get(`/api/v1/admin/rbac/roles/${roleId}/members?${query}`, {
    headers: bearer(token, tenantId),
  });
  expect(res.status(), `GET members for ${roleId} → ${await res.text()}`).toBe(200);
  return (await res.json()) as MembersEnvelope;
}

/**
 * Every member row of a role, across ALL pages — so a tenant-consistency
 * assertion covers the whole result set, not just the first page. (This spec
 * is READ-ONLY: it creates no rows, so there is nothing for it to clean up.)
 */
async function fetchAllMembers(request: APIRequestContext, token: string, roleId: string, tenantId?: string): Promise<MemberRow[]> {
  const pageSize = 100;
  const rows: MemberRow[] = [];
  for (let page = 1; ; page++) {
    const envelope = await fetchMembers(request, token, roleId, `page=${page}&pageSize=${pageSize}`, tenantId);
    rows.push(...envelope.data);
    if (rows.length >= envelope.total || envelope.data.length === 0) return rows;
  }
}

async function fetchRole(request: APIRequestContext, token: string, roleId: string, tenantId?: string): Promise<RoleRow> {
  const res = await request.get(`/api/v1/admin/rbac/roles/${roleId}`, { headers: bearer(token, tenantId) });
  expect(res.status(), `GET role ${roleId} → ${await res.text()}`).toBe(200);
  return (await res.json()) as RoleRow;
}

// Run with ONE worker (`--workers=1`) so beforeAll — and its throttled logins —
// runs once and the tokens are shared. Deliberately NOT `mode: 'serial'`:
// serial aborts the remaining tests on the first failure, and each probe here
// is an independent contract that must report its own verdict.

test.describe('role members — cross-tenant contract', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let superAdminRoleId: string;
  let doctorRoleId: string;

  test.beforeAll(async ({ request }) => {
    // Logins may sit out several 60s throttle windows on the shared gateway.
    test.setTimeout(300_000);

    superAdminToken = await loginWithBackoff(request, SUPER_ADMIN.username, SUPER_ADMIN.password);
    tenantAdminToken = await loginWithBackoff(
      request,
      SEEDED_USERS.admin.username, // tenant_admin — TENANT_ADMIN on the default tenant
      SEEDED_USERS.admin.password,
      DEFAULT_TENANT_KEY,
    );

    // Discover the seeded anchor roles by NAME (ids are seed-stable but
    // discovery keeps the spec honest across reseeds).
    const res = await request.get('/api/v1/admin/rbac/roles?page=1&pageSize=100', {
      headers: bearer(superAdminToken),
    });
    expect(res.status(), `roles list → ${await res.text()}`).toBe(200);
    const roles = ((await res.json()) as { data: RoleRow[] }).data;
    const byName = (name: string) => roles.find((role) => role.name === name);
    const superAdminRole = byName('SUPER_ADMIN');
    const doctorRole = byName('DOCTOR');
    expect(superAdminRole, 'seeded SUPER_ADMIN role present').toBeTruthy();
    expect(doctorRole, 'seeded DOCTOR role present').toBeTruthy();
    superAdminRoleId = superAdminRole!.id;
    doctorRoleId = doctorRole!.id;
  });

  test('M1 — members envelope shape and row projection', async ({ request }) => {
    const envelope = await fetchMembers(request, superAdminToken, doctorRoleId, 'page=1&pageSize=5');
    expect(Array.isArray(envelope.data)).toBe(true);
    expect(typeof envelope.total).toBe('number');
    expect(envelope.page).toBe(1);
    expect(envelope.pageSize).toBe(5);
    expect(envelope.data.length).toBeGreaterThan(0);
    expect(envelope.data.length).toBeLessThanOrEqual(5);
    for (const row of envelope.data) {
      expect(typeof row.assignmentId).toBe('string');
      expect(typeof row.userId).toBe('string');
      expect(typeof row.tenantId).toBe('string');
      expect(typeof row.username).toBe('string');
      expect(typeof row.displayName).toBe('string');
      expect(typeof row.resourceStatus).toBe('string');
      expect(typeof row.assignedAt).toBe('string');
    }
  });

  test('M2 — unscoped super admin sees members across tenants; memberCount matches', async ({ request }) => {
    // SUPER_ADMIN holders live under the SYSTEM tenant — an unscoped
    // platform read must surface them.
    const members = await fetchMembers(request, superAdminToken, superAdminRoleId);
    expect(members.total).toBeGreaterThanOrEqual(1);
    const tenants = new Set(members.data.map((row) => row.tenantId));
    expect(tenants.has(SYSTEM_TENANT_ID), 'SYSTEM-tenant holders visible unscoped').toBe(true);

    // The role read's memberCount is the same unscoped predicate.
    const role = await fetchRole(request, superAdminToken, superAdminRoleId);
    expect(role.memberCount).toBe(members.total);

    // DOCTOR spans more than one tenant in the seed — the unscoped read
    // must not collapse to a single tenant.
    const doctors = await fetchMembers(request, superAdminToken, doctorRoleId);
    const doctorTenants = new Set(doctors.data.map((row) => row.tenantId));
    expect(doctorTenants.size).toBeGreaterThanOrEqual(2);
  });

  test('M3 — X-Tenant-Id scopes the listing AND memberCount to the working tenant', async ({ request }) => {
    // Acting on the default tenant: SYSTEM-tenant SUPER_ADMIN holders
    // must vanish from BOTH the listing and the count.
    const members = await fetchMembers(request, superAdminToken, superAdminRoleId, 'page=1&pageSize=50', DEFAULT_TENANT_ID);
    for (const row of members.data) {
      expect(row.tenantId, `member ${row.username} leaked from tenant ${row.tenantId}`).toBe(DEFAULT_TENANT_ID);
    }

    const role = await fetchRole(request, superAdminToken, superAdminRoleId, DEFAULT_TENANT_ID);
    expect(role.memberCount, 'scoped memberCount equals scoped listing total').toBe(members.total);

    // Same invariant on a role that HAS default-tenant members.
    const doctors = await fetchMembers(request, superAdminToken, doctorRoleId, 'page=1&pageSize=100', DEFAULT_TENANT_ID);
    for (const row of doctors.data) {
      expect(row.tenantId, `member ${row.username} leaked from tenant ${row.tenantId}`).toBe(DEFAULT_TENANT_ID);
    }
    const doctorRole = await fetchRole(request, superAdminToken, doctorRoleId, DEFAULT_TENANT_ID);
    expect(doctorRole.memberCount, 'scoped memberCount equals scoped listing total').toBe(doctors.total);
  });

  test("M4 — tenant-bound tenant admin sees ONLY their tenant's members", async ({ request }) => {
    // The DOCTOR role has members in more than one tenant (asserted in
    // M2), so tenant-consistency here is a genuine cross-tenant probe,
    // not vacuous.
    const doctors = await fetchMembers(request, tenantAdminToken, doctorRoleId, 'page=1&pageSize=100');
    expect(doctors.data.length).toBeGreaterThan(0);
    for (const row of doctors.data) {
      expect(row.tenantId, `member ${row.username} leaked from tenant ${row.tenantId}`).toBe(DEFAULT_TENANT_ID);
    }
    const doctorRole = await fetchRole(request, tenantAdminToken, doctorRoleId);
    expect(doctorRole.memberCount, 'tenant-scoped memberCount equals listing total').toBe(doctors.total);

    // WAS: `members.total === 0` on the SUPER_ADMIN role — a PROXY for "no
    // SYSTEM-tenant platform admin leaks", valid only while nobody had ever
    // granted SUPER_ADMIN inside the default tenant. Other specs do exactly
    // that and never clean up, so the count drifted upward and the test failed
    // on every run after the first — while a REAL leak that coincided with
    // that pollution would still have passed a `> 0` count.
    // NOW: assert the invariant this test is NAMED for — every row returned
    // belongs to the caller's own tenant, and no SYSTEM-tenant platform admin
    // appears. Strictly stronger: it fails on any cross-tenant row regardless
    // of how many legitimate in-tenant rows exist.
    const platformRows = await fetchAllMembers(request, tenantAdminToken, superAdminRoleId);
    for (const row of platformRows) {
      expect(row.tenantId, `member ${row.username} leaked from tenant ${row.tenantId}`).toBe(DEFAULT_TENANT_ID);
    }
    expect(
      platformRows.some((row) => row.tenantId === SYSTEM_TENANT_ID),
      'SYSTEM-tenant platform admins hidden from a tenant admin',
    ).toBe(false);
    // The count follows the same scoped predicate as the listing, so a hidden
    // cross-tenant row cannot survive inside `total` either.
    const scopedTotal = (await fetchMembers(request, tenantAdminToken, superAdminRoleId, 'page=1&pageSize=1')).total;
    expect(platformRows).toHaveLength(scopedTotal);
    const superAdminRoleScoped = await fetchRole(request, tenantAdminToken, superAdminRoleId);
    expect(superAdminRoleScoped.memberCount, 'tenant-scoped memberCount equals listing total').toBe(scopedTotal);
  });

  test('M5 — unknown role id → 404 for every caller; no 403 on the members surface', async ({ request }) => {
    for (const token of [superAdminToken, tenantAdminToken]) {
      const res = await request.get(`/api/v1/admin/rbac/roles/${SYNTHETIC_ROLE_ID}/members`, {
        headers: bearer(token),
      });
      expect(res.status()).toBe(404);
      const body = (await res.json()) as { message?: string };
      // Generic not-found only — no tenant/ownership hint in the shape.
      expect(String(body.message ?? '')).not.toMatch(/tenant|owner|forbidden|denied/i);
    }

    // 404-over-403 posture: a permitted tenant-bound caller reading a role
    // whose members all live elsewhere gets a normal 200/empty — never a
    // 403 revealing that the resource exists but is off-limits.
    const res = await request.get(`/api/v1/admin/rbac/roles/${superAdminRoleId}/members`, {
      headers: bearer(tenantAdminToken),
    });
    expect(res.status()).not.toBe(403);
    expect(res.status()).toBe(200);
  });

  test('M6 — pagination envelope: caps, echoes, and distinct pages', async ({ request }) => {
    const page1 = await fetchMembers(request, superAdminToken, doctorRoleId, 'page=1&pageSize=1');
    expect(page1.data).toHaveLength(1);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(1);
    expect(page1.total).toBeGreaterThan(1);

    const page2 = await fetchMembers(request, superAdminToken, doctorRoleId, 'page=2&pageSize=1');
    expect(page2.data).toHaveLength(1);
    expect(page2.page).toBe(2);
    expect(page2.data[0].assignmentId).not.toBe(page1.data[0].assignmentId);
  });
});
