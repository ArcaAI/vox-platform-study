/**
 * Policy break-glass + `isProtected` hardening: live API contract.
 *
 * Real HTTP round-trips against the live dev stack
 * (`SKIP_DB_PRECHECK=true API_URL=http://localhost:8968/api/v1`). Harness
 * mirrors (seeded `super_admin` bound to `__GLOBAL__`; `doctor` as the
 * RBAC negative). All mutable fixtures are THROWAWAY policies/roles created by
 * this spec and soft-deleted through the API afterwards — seeded rows are only
 * ever targeted by guard NEGATIVES (rejected before any write).
 *
 * Coverage:
 *   A. `isProtected` hardening — the two seeded system policies surface
 *      `isProtected: true`; throwaways default false; the column is read-only
 *      through the API (explicit write attempts → 400, both PATCH and PUT).
 *   B. Policy DELETE break-glass matrix — missing → 428, wrong password → 401,
 *      wrong confirmation name → 400, correct password + exact name → 204.
 *   C. Rule-edit gating — a policy attached to >1 role refuses bare rule
 *      PATCHes (428) but accepts them with step-up; attached to ≤1 role edits
 *      freely; non-rule PATCHes (description) stay confirmation-free.
 *   D. Detach-from-role matrix — 428 / 401 / 400 / 204, same contract.
 *   E. Role DELETE break-glass matrix (module has role deletion) — 428/401/400/204.
 *   F. ABSOLUTES — the two protected policies refuse deletion and detach even
 *      WITH a fully correct break-glass confirmation (403, standing decision),
 *      and a plain doctor is 403 regardless of credentials.
 *   G. Forced audit rows — confirmed mutations AND rejected
 *      attempts land `RBAC_BREAK_GLASS` rows (actor, target, operation,
 *      outcome; never the password).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const UNIQUE = Date.now();

// Seeded protected GLOBAL policies (packages/database/.../seed/01-policy.ts).
const SYSTEM_FULL_ACCESS_ID = '00000000-0000-0000-0001-000000000001';
const RBAC_SYSTEM_MANAGE_ID = '00000000-0000-0000-0001-000000000010';

const GOOD_PASSWORD = SEEDED_USERS.superAdmin.password;

interface PolicyDto {
  id: string;
  name: string;
  scope: string;
  rules: Array<{ action: string; subject: string }>;
  resourceStatus: string;
  isProtected: boolean;
}
interface RoleDto {
  id: string;
  name: string;
  policies?: Array<{ id: string; name?: string }>;
}
interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  responsibleUserId: string | null;
  tenantId: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

let saToken: string;
let saUserId: string;
let doctorToken: string;

/** Poll the (async, queue-backed) audit log until `predicate` matches a row. */
async function pollAuditRows(
  request: APIRequestContext,
  query: Record<string, string>,
  predicate: (row: AuditRow) => boolean,
  timeoutMs = 20_000,
): Promise<AuditRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ limit: '50', sort: 'createdAt:desc', ...query }).toString();
    const res = await request.get(`/api/v1/admin/audit-logs?${params}`, { headers: bearer(saToken) });
    if (res.status() === 200) {
      const rows = asArray<AuditRow>(await res.json());
      const hit = rows.find(predicate);
      if (hit) return hit;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function createPolicy(request: APIRequestContext, name: string): Promise<PolicyDto> {
  const res = await request.post('/api/v1/admin/rbac/policies', {
    headers: bearer(saToken),
    data: { name, description: 'TASK-409 e2e throwaway', scope: 'TENANT', rules: [{ action: 'read', subject: 'Consultation' }] },
  });
  expect(res.status(), `create policy ${name}`).toBe(201);
  return (await res.json()) as PolicyDto;
}

async function createRole(request: APIRequestContext, name: string): Promise<RoleDto> {
  const res = await request.post('/api/v1/admin/rbac/roles', {
    headers: bearer(saToken),
    data: { name, description: 'TASK-409 e2e throwaway' },
  });
  expect(res.status(), `create role ${name}`).toBe(201);
  return (await res.json()) as RoleDto;
}

async function attach(request: APIRequestContext, roleId: string, policyId: string): Promise<void> {
  const res = await request.post(`/api/v1/admin/rbac/roles/${roleId}/policies/${policyId}`, {
    headers: bearer(saToken),
    data: { priority: 0 },
  });
  expect([200, 201], 'attach policy to role').toContain(res.status());
}

const deletePolicy = (request: APIRequestContext, id: string, data?: Record<string, unknown>, token = saToken) =>
  request.delete(`/api/v1/admin/rbac/policies/${id}`, { headers: bearer(token), ...(data ? { data } : {}) });
const deleteRole = (request: APIRequestContext, id: string, data?: Record<string, unknown>, token = saToken) =>
  request.delete(`/api/v1/admin/rbac/roles/${id}`, { headers: bearer(token), ...(data ? { data } : {}) });
const detach = (request: APIRequestContext, roleId: string, policyId: string, data?: Record<string, unknown>, token = saToken) =>
  request.delete(`/api/v1/admin/rbac/roles/${roleId}/policies/${policyId}`, { headers: bearer(token), ...(data ? { data } : {}) });

test.beforeAll(async ({ request }) => {
  const [sa, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login failed').toBeTruthy();
  saToken = sa!.token;
  saUserId = sa!.user.id;
  doctorToken = doc!.token;
});

// =============================================================================
// A — `isProtected` hardening
// =============================================================================
test.describe.serial('A — isProtected marker', () => {
  let throwawayId: string | undefined;
  const NAME = `t409-a-marker-${UNIQUE}`;

  test.afterAll(async ({ request }) => {
    if (throwawayId) {
      await deletePolicy(request, throwawayId, { password: GOOD_PASSWORD, confirmationName: NAME }).catch(() => undefined);
    }
  });

  test('A1 — the two seeded system policies surface isProtected: true; a fresh policy defaults false', async ({ request }) => {
    for (const id of [SYSTEM_FULL_ACCESS_ID, RBAC_SYSTEM_MANAGE_ID]) {
      const res = await request.get(`/api/v1/admin/rbac/policies/${id}`, { headers: bearer(saToken) });
      expect(res.status(), `GET seeded policy ${id}`).toBe(200);
      expect(((await res.json()) as PolicyDto).isProtected, `${id} carries isProtected: true`).toBe(true);
    }

    const created = await createPolicy(request, NAME);
    throwawayId = created.id;
    expect(created.isProtected, 'throwaway policy defaults to isProtected: false').toBe(false);
  });

  test('A2 — isProtected is read-only through the API (explicit write → 400, PATCH and PUT)', async ({ request }) => {
    expect(throwawayId, 'A1 created the fixture').toBeTruthy();

    const viaPatch = await request.patch(`/api/v1/admin/rbac/policies/${throwawayId}`, {
      headers: bearer(saToken),
      data: { isProtected: true },
    });
    expect(viaPatch.status(), 'PATCH isProtected → 400').toBe(400);

    const viaPut = await request.put(`/api/v1/admin/rbac/policies/${throwawayId}`, {
      headers: bearer(saToken),
      data: { name: NAME, rules: [{ action: 'read', subject: 'Consultation' }], isProtected: true },
    });
    expect(viaPut.status(), 'PUT isProtected → 400').toBe(400);

    // Unsetting on a protected policy is equally rejected — before the guard even runs.
    const unset = await request.patch(`/api/v1/admin/rbac/policies/${SYSTEM_FULL_ACCESS_ID}`, {
      headers: bearer(saToken),
      data: { isProtected: false },
    });
    expect(unset.status(), 'PATCH isProtected: false on a protected policy → 400').toBe(400);

    const after = await request.get(`/api/v1/admin/rbac/policies/${throwawayId}`, { headers: bearer(saToken) });
    expect(((await after.json()) as PolicyDto).isProtected, 'marker unchanged').toBe(false);
  });
});

// =============================================================================
// B — policy DELETE break-glass matrix
// =============================================================================
test.describe.serial('B — policy delete matrix', () => {
  let policyId: string | undefined;
  const NAME = `t409-b-delete-${UNIQUE}`;

  test.afterAll(async ({ request }) => {
    if (policyId) {
      await deletePolicy(request, policyId, { password: GOOD_PASSWORD, confirmationName: NAME }).catch(() => undefined);
    }
  });

  test('B1 — missing confirmation → 428; wrong password → 401; wrong name → 400; correct → 204', async ({ request }) => {
    const created = await createPolicy(request, NAME);
    policyId = created.id;

    const missing = await deletePolicy(request, policyId);
    expect(missing.status(), 'DELETE without break-glass → 428').toBe(428);

    const wrongPassword = await deletePolicy(request, policyId, { password: 'not-the-password', confirmationName: NAME });
    expect(wrongPassword.status(), 'wrong password → 401').toBe(401);

    const wrongName = await deletePolicy(request, policyId, { password: GOOD_PASSWORD, confirmationName: `${NAME}-typo` });
    expect(wrongName.status(), 'wrong confirmation name → 400').toBe(400);

    // Three rejections later the policy is still intact.
    const still = await request.get(`/api/v1/admin/rbac/policies/${policyId}`, { headers: bearer(saToken) });
    expect(still.status(), 'policy survives every rejected attempt').toBe(200);

    const confirmed = await deletePolicy(request, policyId, { password: GOOD_PASSWORD, confirmationName: NAME });
    expect(confirmed.status(), 'correct password + exact name → 204').toBe(204);
    policyId = undefined;
  });
});

// =============================================================================
// C — rule-edit gating by blast radius (>1 role)
// =============================================================================
test.describe.serial('C — multi-role rule-edit gating', () => {
  const POLICY_NAME = `t409-c-shared-${UNIQUE}`;
  const SINGLE_NAME = `t409-c-single-${UNIQUE}`;
  let sharedId: string | undefined;
  let singleId: string | undefined;
  let roleAId: string | undefined;
  let roleBId: string | undefined;

  test.afterAll(async ({ request }) => {
    // Detach + soft-delete every throwaway via the public API (break-glass supplied).
    for (const [roleId, policyId] of [
      [roleAId, sharedId],
      [roleBId, sharedId],
      [roleAId, singleId],
    ] as const) {
      if (roleId && policyId) {
        await detach(request, roleId, policyId, {
          password: GOOD_PASSWORD,
          confirmationName: policyId === sharedId ? POLICY_NAME : SINGLE_NAME,
        }).catch(() => undefined);
      }
    }
    if (sharedId) await deletePolicy(request, sharedId, { password: GOOD_PASSWORD, confirmationName: POLICY_NAME }).catch(() => undefined);
    if (singleId) await deletePolicy(request, singleId, { password: GOOD_PASSWORD, confirmationName: SINGLE_NAME }).catch(() => undefined);
    for (const [roleId, roleName] of [
      [roleAId, `t409-c-role-a-${UNIQUE}`],
      [roleBId, `t409-c-role-b-${UNIQUE}`],
    ] as const) {
      if (roleId) await deleteRole(request, roleId, { password: GOOD_PASSWORD, confirmationName: roleName as string }).catch(() => undefined);
    }
  });

  test('C1 — a policy attached to TWO roles refuses bare rule edits (428) but accepts step-up', async ({ request }) => {
    const shared = await createPolicy(request, POLICY_NAME);
    sharedId = shared.id;
    const roleA = await createRole(request, `t409-c-role-a-${UNIQUE}`);
    roleAId = roleA.id;
    const roleB = await createRole(request, `t409-c-role-b-${UNIQUE}`);
    roleBId = roleB.id;
    await attach(request, roleAId, sharedId);
    await attach(request, roleBId, sharedId);

    const newRules = [
      { action: 'read', subject: 'Consultation' },
      { action: 'create', subject: 'Consultation' },
    ];

    const bare = await request.patch(`/api/v1/admin/rbac/policies/${sharedId}`, {
      headers: bearer(saToken),
      data: { rules: newRules },
    });
    expect(bare.status(), 'bare rule edit of a 2-role policy → 428').toBe(428);

    const wrongPassword = await request.patch(`/api/v1/admin/rbac/policies/${sharedId}`, {
      headers: bearer(saToken),
      data: { rules: newRules, breakGlass: { password: 'not-the-password', confirmationName: POLICY_NAME } },
    });
    expect(wrongPassword.status(), 'wrong password → 401').toBe(401);

    const wrongName = await request.patch(`/api/v1/admin/rbac/policies/${sharedId}`, {
      headers: bearer(saToken),
      data: { rules: newRules, breakGlass: { password: GOOD_PASSWORD, confirmationName: 'wrong-name' } },
    });
    expect(wrongName.status(), 'wrong confirmation name → 400').toBe(400);

    const confirmed = await request.patch(`/api/v1/admin/rbac/policies/${sharedId}`, {
      headers: bearer(saToken),
      data: { rules: newRules, breakGlass: { password: GOOD_PASSWORD, confirmationName: POLICY_NAME } },
    });
    expect(confirmed.status(), 'step-up rule edit → 200').toBe(200);
    expect(((await confirmed.json()) as PolicyDto).rules.length).toBe(2);
  });

  test('C2 — a policy attached to ONE role edits rules without confirmation; description edits are always free', async ({ request }) => {
    const single = await createPolicy(request, SINGLE_NAME);
    singleId = single.id;
    expect(roleAId, 'C1 created role A').toBeTruthy();
    await attach(request, roleAId!, singleId);

    const ruleEdit = await request.patch(`/api/v1/admin/rbac/policies/${singleId}`, {
      headers: bearer(saToken),
      data: { rules: [{ action: 'read', subject: 'User' }] },
    });
    expect(ruleEdit.status(), 'rule edit of a 1-role policy needs no break-glass').toBe(200);

    expect(sharedId, 'C1 created the shared policy').toBeTruthy();
    const descriptionEdit = await request.patch(`/api/v1/admin/rbac/policies/${sharedId}`, {
      headers: bearer(saToken),
      data: { description: 'TASK-409 metadata-only edit (no rules touched)' },
    });
    expect(descriptionEdit.status(), 'metadata-only edit of a 2-role policy needs no break-glass').toBe(200);
  });

  // =========================================================================
  // D — detach matrix (reuses the C fixtures: shared policy on role A + B)
  // =========================================================================
  test('D1 — detach: missing → 428, wrong password → 401, wrong name → 400, correct → 204', async ({ request }) => {
    expect(sharedId && roleBId, 'C1 fixtures exist').toBeTruthy();

    const missing = await detach(request, roleBId!, sharedId!);
    expect(missing.status(), 'bare detach → 428').toBe(428);

    const wrongPassword = await detach(request, roleBId!, sharedId!, { password: 'not-the-password', confirmationName: POLICY_NAME });
    expect(wrongPassword.status(), 'wrong password → 401').toBe(401);

    const wrongName = await detach(request, roleBId!, sharedId!, { password: GOOD_PASSWORD, confirmationName: 'wrong-name' });
    expect(wrongName.status(), 'wrong confirmation name → 400').toBe(400);

    const confirmed = await detach(request, roleBId!, sharedId!, { password: GOOD_PASSWORD, confirmationName: POLICY_NAME });
    expect([200, 204], 'confirmed detach succeeds').toContain(confirmed.status());
  });

  // =========================================================================
  // E — role DELETE matrix (reuses throwaway role B, now policy-free)
  // =========================================================================
  test('E1 — role delete: missing → 428, wrong password → 401, wrong name → 400, correct → 204', async ({ request }) => {
    expect(roleBId, 'C1 created role B').toBeTruthy();
    const ROLE_NAME = `t409-c-role-b-${UNIQUE}`;

    const missing = await deleteRole(request, roleBId!);
    expect(missing.status(), 'bare role delete → 428').toBe(428);

    const wrongPassword = await deleteRole(request, roleBId!, { password: 'not-the-password', confirmationName: ROLE_NAME });
    expect(wrongPassword.status(), 'wrong password → 401').toBe(401);

    const wrongName = await deleteRole(request, roleBId!, { password: GOOD_PASSWORD, confirmationName: 'wrong-role-name' });
    expect(wrongName.status(), 'wrong confirmation name → 400').toBe(400);

    const confirmed = await deleteRole(request, roleBId!, { password: GOOD_PASSWORD, confirmationName: ROLE_NAME });
    expect([200, 204], 'confirmed role delete succeeds').toContain(confirmed.status());
    roleBId = undefined;
  });
});

// =============================================================================
// F — ABSOLUTES: protected policies ignore break-glass; RBAC negative
// =============================================================================
test.describe.serial('F — protected absolutes', () => {
  test('F1 — deleting a protected policy is 403 even WITH a fully correct confirmation', async ({ request }) => {
    for (const [id, name] of [
      [SYSTEM_FULL_ACCESS_ID, 'system-full-access'],
      [RBAC_SYSTEM_MANAGE_ID, 'rbac-system-manage'],
    ] as const) {
      const res = await deletePolicy(request, id, { password: GOOD_PASSWORD, confirmationName: name });
      expect(res.status(), `${name} delete with correct break-glass still → 403`).toBe(403);

      const still = await request.get(`/api/v1/admin/rbac/policies/${id}`, { headers: bearer(saToken) });
      expect(still.status(), `${name} intact`).toBe(200);
    }
  });

  test('F2 — detaching a protected policy from its seeded role is 403 even WITH correct confirmation', async ({ request }) => {
    // Find a seeded role that carries rbac-system-manage.
    const rolesRes = await request.get('/api/v1/admin/rbac/roles', { headers: bearer(saToken) });
    expect(rolesRes.status()).toBe(200);
    const roles = asArray<RoleDto>(await rolesRes.json());
    const holder = roles.find((r) => (r.policies ?? []).some((p) => p.id === RBAC_SYSTEM_MANAGE_ID));
    expect(holder, 'a seeded role carries rbac-system-manage').toBeTruthy();

    const res = await detach(request, holder!.id, RBAC_SYSTEM_MANAGE_ID, {
      password: GOOD_PASSWORD,
      confirmationName: 'rbac-system-manage',
    });
    expect(res.status(), 'protected detach with correct break-glass still → 403').toBe(403);

    // The seeded attachment survives.
    const after = await request.get(`/api/v1/admin/rbac/roles/${holder!.id}`, { headers: bearer(saToken) });
    expect(after.status()).toBe(200);
    expect(
      (((await after.json()) as RoleDto).policies ?? []).some((p) => p.id === RBAC_SYSTEM_MANAGE_ID),
      'seeded attachment intact',
    ).toBe(true);
  });

  test('F3 — a plain doctor is 403 on the break-glass surface regardless of credentials', async ({ request }) => {
    const res = await deletePolicy(
      request,
      SYSTEM_FULL_ACCESS_ID,
      { password: SEEDED_USERS.doctor.password, confirmationName: 'system-full-access' },
      doctorToken,
    );
    expect(res.status(), 'doctor RBAC 403 precedes everything').toBe(403);
  });
});

// =============================================================================
// G — forced audit rows (confirmed AND rejected attempts; never the password)
// =============================================================================
test.describe.serial('G — forced audit rows', () => {
  const NAME = `t409-g-audit-${UNIQUE}`;
  let policyId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (policyId) {
      await deletePolicy(request, policyId, { password: GOOD_PASSWORD, confirmationName: NAME }).catch(() => undefined);
    }
  });

  test('G1 — a rejected attempt and a confirmed delete each land an RBAC_BREAK_GLASS row', async ({ request }) => {
    const created = await createPolicy(request, NAME);
    policyId = created.id;

    // One rejected attempt (missing credentials → 428) …
    const rejected = await deletePolicy(request, policyId);
    expect(rejected.status()).toBe(428);

    const rejectedRow = await pollAuditRows(
      request,
      { resourceType: 'Permission', action: 'READ' },
      (r) =>
        r.data?.action === 'RBAC_BREAK_GLASS' &&
        r.data?.targetName === NAME &&
        r.data?.operation === 'policy-delete' &&
        r.data?.outcome === 'rejected-missing-credentials',
    );
    expect(rejectedRow, 'forced audit row for the REJECTED attempt').toBeTruthy();
    expect(rejectedRow!.responsibleUserId, 'actor recorded').toBe(saUserId);
    expect(JSON.stringify(rejectedRow!.data), 'password never logged').not.toContain(GOOD_PASSWORD);

    // … then the confirmed mutation.
    const confirmed = await deletePolicy(request, policyId, { password: GOOD_PASSWORD, confirmationName: NAME });
    expect(confirmed.status()).toBe(204);
    policyId = undefined;

    const confirmedRow = await pollAuditRows(
      request,
      { resourceType: 'Permission', action: 'READ' },
      (r) =>
        r.data?.action === 'RBAC_BREAK_GLASS' &&
        r.data?.targetName === NAME &&
        r.data?.operation === 'policy-delete' &&
        r.data?.outcome === 'confirmed',
    );
    expect(confirmedRow, 'forced audit row for the CONFIRMED mutation').toBeTruthy();
    expect(confirmedRow!.responsibleUserId, 'actor recorded').toBe(saUserId);
    expect(JSON.stringify(confirmedRow!.data), 'password never logged').not.toContain(GOOD_PASSWORD);
  });
});
