/**
 * Users backend backlog (Group C) backend contract.
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968/api/v1`). Mirrors the harness of
 * tenant-data-model-contract.spec.ts (seeded `super_admin` = cross-tenant operator;
 * a second `super_admin` session bound to `__GLOBAL__` for tenant-scoped writes;
 * `tenant_admin`/`doctor` pinned to `__GLOBAL__`).
 *
 * Coverage (ticket §Items #8–13):
 *   #8  reset-password · temporary-password flow logs in; emailed-link flow mints a
 *                        single-use token → public completion → new password logs in →
 *                        replay is 400. Non-admin (doctor) is 403.
 *   #9  bulk actions   · enable/disable/assign-departments return a per-item envelope;
 *                        an out-of-scope id is reported failed without aborting the batch.
 *                        Non-admin (doctor) is 403.
 *   #10 export         · csv (default) / xlsx / pdf stream the right content-type +
 *                        attachment disposition + magic bytes. Non-admin (doctor) is 403.
 *   #11 admin-for-other· admin GET/PATCH of ANOTHER user's settings round-trips (the
 *                        backend the SDK now targets). Non-admin (doctor) is 403.
 *   #12 prompt scope   · admin creates a USER_PERSONAL prompt for a target owner + filters
 *                        by scope/owner; a clinician creates/lists/deletes their OWN personal.
 *   #13 cross-user DNA · admin may list/read/generate DNA for a target doctor (tenant-scoped,
 *                        PHI-gated). A plain doctor is 403 on every admin cross-user surface.
 *
 * All mutations target throwaway users (created + soft-deleted in the block) — no seed
 * rows are mutated destructively.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Paginated<T> {
  data: T[];
  count: number;
}
interface CreatedUser {
  id: string;
  username: string;
}
interface BulkResult {
  action: string;
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: string; success: boolean; error?: string }>;
}
interface PromptDto {
  id: string;
  scope?: string;
}

let saGlobalToken: string; // super_admin bound to __GLOBAL__ — admin operator with tenant context
let doctorToken: string; // plain clinician in __GLOBAL__ — the RBAC negative

const UNIQUE = Date.now();
const CREATED_PW = 'Password123!';

/** Create a throwaway user in __GLOBAL__ (mirrors task-381 U2). */
async function createUser(request: APIRequestContext, username: string): Promise<CreatedUser> {
  const res = await request.post('/api/v1/admin/users', {
    headers: bearer(saGlobalToken),
    data: { username, password: CREATED_PW },
  });
  expect(res.status(), `create throwaway user ${username}`).toBeLessThan(300);
  return (await res.json()) as CreatedUser;
}

/** Best-effort soft-delete of a throwaway user. */
async function deleteUser(request: APIRequestContext, id: string | undefined): Promise<void> {
  if (!id) return;
  await request.delete(`/api/v1/admin/users/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
}

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

/**
 * Create a throwaway user that can actually AUTHENTICATE into __GLOBAL__. Login
 * (non-super-admin) requires an active role AND an active department in the
 * tenant (auth.controller), so we mirror task-381 U2a/U11:
 * create → assign a role → assign a department. Used by #8 so the reset flows
 * can be proven by a real login without mutating any seeded account.
 */
async function createLoginableUser(request: APIRequestContext, username: string): Promise<CreatedUser> {
  const u = await createUser(request, username);

  const rolesRes = await request.get('/api/v1/admin/rbac/roles', { headers: bearer(saGlobalToken) });
  expect(rolesRes.status(), 'list roles for loginable-user setup').toBe(200);
  const roles = asArray<{ id: string; name: string }>(await rolesRes.json());
  const role = roles.find((r) => r.name === 'DOCTOR') ?? roles.find((r) => r.name === 'NURSE') ?? roles[0];
  expect(role, 'a seeded role exists to assign').toBeTruthy();
  const assignRole = await request.post(`/api/v1/admin/users/${u.id}/roles`, { headers: bearer(saGlobalToken), data: { roleId: role.id } });
  expect([200, 201], 'assign role to throwaway user').toContain(assignRole.status());

  const deptRes = await request.get('/api/v1/admin/departments', { headers: bearer(saGlobalToken) });
  expect(deptRes.status(), 'list departments for loginable-user setup').toBe(200);
  const depts = asArray<{ id: string }>(await deptRes.json());
  expect(depts.length, 'seed ships at least one department for tenant membership').toBeGreaterThan(0);
  const assignDept = await request.post(`/api/v1/admin/users/${u.id}/departments`, {
    headers: bearer(saGlobalToken),
    data: { departmentId: depts[0].id, isPrimary: true },
  });
  expect([200, 201], 'assign department to throwaway user').toContain(assignDept.status());

  return u;
}

test.beforeAll(async ({ request }) => {
  const [saG, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
  saGlobalToken = saG!.token;
  doctorToken = doc!.token;
});

// =============================================================================
// #8 — admin reset-password (temporary + emailed link)
// =============================================================================
test.describe.serial('#8 — admin reset-password', () => {
  let userId: string;
  let username: string;

  test.beforeAll(async ({ request }) => {
    username = `t388reset_${UNIQUE}`;
    const u = await createLoginableUser(request, username);
    userId = u.id;
  });
  test.afterAll(async ({ request }) => deleteUser(request, userId));

  test('#8 temporary mode sets a login-compatible password and returns the plaintext', async ({ request }) => {
    const res = await request.post(`/api/v1/admin/users/${userId}/reset-password`, {
      headers: bearer(saGlobalToken),
      data: { mode: 'temporary' },
    });
    expect(res.status(), 'temporary reset → 200').toBe(200);
    const body = (await res.json()) as { mode: string; temporaryPassword: string };
    expect(body.mode).toBe('temporary');
    expect(typeof body.temporaryPassword).toBe('string');
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(8);

    const relog = await loginUser(request, username, body.temporaryPassword, DEFAULT_TENANT_KEY);
    expect(relog, 'the temporary password authenticates').toBeTruthy();
  });

  test('#8 link mode mints a single-use token → public completion → replay 400', async ({ request }) => {
    const res = await request.post(`/api/v1/admin/users/${userId}/reset-password`, {
      headers: bearer(saGlobalToken),
      data: { mode: 'link' },
    });
    expect(res.status(), 'link reset → 200').toBe(200);
    const body = (await res.json()) as { mode: string; token: string; resetPath: string; expiresInSeconds: number; emailSent: boolean };
    expect(body.mode).toBe('link');
    expect(typeof body.token).toBe('string');
    expect(body.resetPath, 'reset path carries the token').toContain(body.token);
    expect(body.expiresInSeconds).toBeGreaterThan(0);
    expect(typeof body.emailSent, 'emailSent is a boolean (degrades gracefully when unconfigured)').toBe('boolean');

    const newPassword = `Reset${UNIQUE}!a`;
    const complete = await request.post('/api/v1/users/password-reset/complete', {
      data: { token: body.token, newPassword },
    });
    expect(complete.status(), 'public completion → 200').toBe(200);
    expect(((await complete.json()) as { success: boolean }).success).toBe(true);

    const relog = await loginUser(request, username, newPassword, DEFAULT_TENANT_KEY);
    expect(relog, 'the newly-set password authenticates').toBeTruthy();

    const replay = await request.post('/api/v1/users/password-reset/complete', {
      data: { token: body.token, newPassword: `${newPassword}b` },
    });
    expect(replay.status(), 'a spent token cannot be reused').toBe(400);
  });

  test('#8 RBAC: a plain doctor cannot reset another user password (403)', async ({ request }) => {
    const res = await request.post(`/api/v1/admin/users/${userId}/reset-password`, {
      headers: bearer(doctorToken),
      data: { mode: 'temporary' },
    });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// #9 — server-side bulk user actions
// =============================================================================
test.describe.serial('#9 — server-side bulk user actions', () => {
  let a: CreatedUser;
  let b: CreatedUser;

  const bulk = (request: APIRequestContext, token: string, data: unknown) =>
    request.post('/api/v1/admin/users/bulk-actions', { headers: bearer(token), data });

  test.beforeAll(async ({ request }) => {
    a = await createUser(request, `t388bulkA_${UNIQUE}`);
    b = await createUser(request, `t388bulkB_${UNIQUE}`);
  });
  test.afterAll(async ({ request }) => {
    await deleteUser(request, a?.id);
    await deleteUser(request, b?.id);
  });

  test('#9 disable → enable returns a per-item success envelope for every id', async ({ request }) => {
    const dis = await bulk(request, saGlobalToken, { action: 'disable', ids: [a.id, b.id] });
    expect(dis.status(), 'bulk disable → 200').toBe(200);
    const body = (await dis.json()) as BulkResult;
    expect(body.action).toBe('disable');
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results.every((r) => r.success)).toBe(true);

    const en = await bulk(request, saGlobalToken, { action: 'enable', ids: [a.id, b.id] });
    expect(((await en.json()) as BulkResult).succeeded).toBe(2);
  });

  test('#9 an out-of-scope id is reported failed without aborting the batch', async ({ request }) => {
    const bogus = '00000000-0000-0000-0000-0000000388ff';
    const res = await bulk(request, saGlobalToken, { action: 'disable', ids: [a.id, bogus] });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as BulkResult;
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    const failed = body.results.find((r) => r.id === bogus);
    expect(failed?.success).toBe(false);
    expect(typeof failed?.error).toBe('string');

    await bulk(request, saGlobalToken, { action: 'enable', ids: [a.id] });
  });

  test('#9 assign-departments reconcile (empty set) succeeds', async ({ request }) => {
    const res = await bulk(request, saGlobalToken, { action: 'assign-departments', ids: [a.id], departmentIds: [] });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as BulkResult).succeeded).toBe(1);
  });

  test('#9 RBAC: a plain doctor cannot run bulk actions (403)', async ({ request }) => {
    const res = await bulk(request, doctorToken, { action: 'disable', ids: [a.id] });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// #10 — user export (csv | xlsx | pdf)
// =============================================================================
test.describe('#10 — user export (csv | xlsx | pdf)', () => {
  const exportUrl = (fmt?: string) => `/api/v1/admin/users/export${fmt ? `?format=${fmt}` : ''}`;

  test('#10 csv (default) streams an attachment with a header row', async ({ request }) => {
    const res = await request.get(exportUrl('csv'), { headers: bearer(saGlobalToken) });
    expect(res.status(), 'csv export → 200').toBe(200);
    expect(res.headers()['content-type']).toContain('csv');
    expect(res.headers()['content-disposition']).toContain('attachment');
    const text = (await res.body()).toString('utf8');
    expect(text, 'csv carries the header row').toContain('Username');
  });

  test('#10 xlsx streams a zip-based spreadsheet attachment', async ({ request }) => {
    const res = await request.get(exportUrl('xlsx'), { headers: bearer(saGlobalToken) });
    expect(res.status(), 'xlsx export → 200').toBe(200);
    expect(res.headers()['content-type']).toContain('spreadsheet');
    const buf = await res.body();
    expect(buf.subarray(0, 2).toString('latin1'), 'xlsx is a zip (PK magic)').toBe('PK');
  });

  test('#10 pdf streams a %PDF attachment', async ({ request }) => {
    const res = await request.get(exportUrl('pdf'), { headers: bearer(saGlobalToken) });
    expect(res.status(), 'pdf export → 200').toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
    const buf = await res.body();
    expect(buf.subarray(0, 4).toString('latin1'), 'pdf magic bytes').toBe('%PDF');
  });

  test('#10 RBAC: a plain doctor cannot export users (403)', async ({ request }) => {
    const res = await request.get(exportUrl('csv'), { headers: bearer(doctorToken) });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// #11 — admin edits ANOTHER user's settings (SDK target; backend pre-existing)
// =============================================================================
test.describe.serial('#11 — admin-for-other user settings', () => {
  let userId: string;

  test.beforeAll(async ({ request }) => {
    userId = (await createUser(request, `t388prefs_${UNIQUE}`)).id;
  });
  test.afterAll(async ({ request }) => deleteUser(request, userId));

  test('#11 admin PATCH + GET of a target user setting round-trips', async ({ request }) => {
    const patch = await request.patch(`/api/v1/admin/users/${userId}/settings/ui.e2e/task388`, {
      headers: bearer(saGlobalToken),
      data: { value: 'dark' },
    });
    expect(patch.status(), 'admin upsert another user setting → 200').toBe(200);

    const get = await request.get(`/api/v1/admin/users/${userId}/settings`, { headers: bearer(saGlobalToken) });
    expect(get.status()).toBe(200);
    const settings = (await get.json()) as Array<{ key: string; value: string; namespace?: string }>;
    expect(Array.isArray(settings)).toBe(true);
    expect(settings.some((s) => s.key === 'task388' && s.value === 'dark')).toBe(true);
  });

  test('#11 RBAC: a plain doctor cannot read another user settings (403)', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/users/${userId}/settings`, { headers: bearer(doctorToken) });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// #12 — per-user prompt scope (USER_PERSONAL / ownerUserId)
// =============================================================================
test.describe.serial('#12 — per-user prompt scope', () => {
  let ownerId: string;
  let adminPromptId: string | undefined;
  let personalPromptId: string | undefined;

  test.beforeAll(async ({ request }) => {
    ownerId = (await createUser(request, `t388prompt_${UNIQUE}`)).id;
  });
  test.afterAll(async ({ request }) => {
    if (adminPromptId) {
      await request.delete(`/api/v1/admin/prompt-templates/${adminPromptId}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
    }
    if (personalPromptId) {
      await request.delete(`/api/v1/prompt-templates/${personalPromptId}`, { headers: bearer(doctorToken) }).catch(() => undefined);
    }
    await deleteUser(request, ownerId);
  });

  test('#12 admin creates a USER_PERSONAL prompt for a target owner and filters by scope+owner', async ({ request }) => {
    const create = await request.post('/api/v1/admin/prompt-templates', {
      headers: bearer(saGlobalToken),
      data: {
        name: `t388 personal ${UNIQUE}`,
        content: 'Summarize the encounter for {{patient}}.',
        category: 'CUSTOM',
        scope: 'USER_PERSONAL',
        ownerUserId: ownerId,
        status: 'PUBLISHED',
      },
    });
    expect(create.status(), 'admin create USER_PERSONAL prompt').toBeLessThan(300);
    const created = (await create.json()) as PromptDto;
    adminPromptId = created.id;
    expect(created.scope).toBe('USER_PERSONAL');

    const list = await request.get(`/api/v1/admin/prompt-templates?scope=USER_PERSONAL&ownerUserId=${ownerId}&limit=100`, {
      headers: bearer(saGlobalToken),
    });
    expect(list.status(), 'admin scope+owner filter → 200').toBe(200);
    const body = (await list.json()) as Paginated<PromptDto>;
    expect(
      body.data.some((p) => p.id === adminPromptId),
      'the created prompt is in the filtered set',
    ).toBe(true);
    expect(
      body.data.every((p) => p.scope === 'USER_PERSONAL'),
      'every filtered row is USER_PERSONAL',
    ).toBe(true);
  });

  test('#12 a clinician creates + lists + deletes their OWN personal prompt', async ({ request }) => {
    const create = await request.post('/api/v1/prompt-templates', {
      headers: bearer(doctorToken),
      data: { name: `t388 my prompt ${UNIQUE}`, content: 'Summarize {{note}}.', category: 'CUSTOM' },
    });
    expect(create.status(), 'clinician create personal prompt').toBeLessThan(300);
    const created = (await create.json()) as PromptDto;
    personalPromptId = created.id;
    expect(created.scope).toBe('USER_PERSONAL');

    const avail = await request.get('/api/v1/prompt-templates/available', { headers: bearer(doctorToken) });
    expect(avail.status()).toBe(200);
    const templates = (await avail.json()) as PromptDto[];
    expect(
      templates.some((t) => t.id === personalPromptId),
      "the caller's personal prompt is available to them",
    ).toBe(true);

    const del = await request.delete(`/api/v1/prompt-templates/${personalPromptId}`, { headers: bearer(doctorToken) });
    expect(del.status(), 'owner soft-deletes their personal prompt').toBe(200);
    personalPromptId = undefined;
  });
});

// =============================================================================
// #13 — cross-user DNA (admin read/generate; PHI-gated) — FLAGGED PHI DECISION
// =============================================================================
test.describe('#13 — cross-user DNA (admin; PHI-gated)', () => {
  const doctorId = SEEDED_USERS.doctor.id;
  const otherDoctorId = SEEDED_USERS.doctor2.id;

  test('#13 admin can list a target doctor DNA reports (tenant-scoped)', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/dna-writing-styles?doctorId=${doctorId}&limit=10`, {
      headers: bearer(saGlobalToken),
    });
    expect(res.status(), 'admin cross-user list → 200').toBe(200);
    expect(Array.isArray(((await res.json()) as Paginated<unknown>).data)).toBe(true);
  });

  test('#13 admin read of a doctor latest report is permitted (200 or 404, never 403)', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/dna-writing-styles/doctor/${doctorId}`, { headers: bearer(saGlobalToken) });
    expect([200, 404], 'admin cross-user read is authorized').toContain(res.status());
  });

  test('#13 admin generate for a doctor is authorized (not 403)', async ({ request }) => {
    const res = await request.post(`/api/v1/admin/dna-writing-styles/generate/${doctorId}`, {
      headers: bearer(saGlobalToken),
      data: { textSamples: ['The patient presents with a two-day history of cough and low-grade fever.'] },
    });
    expect(res.status(), 'admin cross-user generate is authorized').not.toBe(403);
  });

  test('#13 PHI gate: a plain doctor cannot use the admin cross-user DNA surface (403)', async ({ request }) => {
    const list = await request.get(`/api/v1/admin/dna-writing-styles?doctorId=${otherDoctorId}`, { headers: bearer(doctorToken) });
    expect(list.status(), 'doctor forbidden on admin list').toBe(403);

    const read = await request.get(`/api/v1/admin/dna-writing-styles/doctor/${otherDoctorId}`, { headers: bearer(doctorToken) });
    expect(read.status(), 'doctor forbidden on admin cross-user read').toBe(403);

    const gen = await request.post(`/api/v1/admin/dna-writing-styles/generate/${otherDoctorId}`, {
      headers: bearer(doctorToken),
      data: { textSamples: ['x'] },
    });
    expect(gen.status(), 'doctor forbidden on admin cross-user generate').toBe(403);
  });
});
