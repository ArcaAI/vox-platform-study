/**
 * Users cluster completion (P1-6 bulk assign-role, P1-7 export enrichment).
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968/api/v1`). Harness mirrors
 * users-backend-backlog.spec.ts (seeded `super_admin` bound to `__GLOBAL__`
 * for tenant-scoped writes; `tenant_admin`/`doctor` pinned to `__GLOBAL__`).
 *
 * Coverage:
 *   P1-6 · POST /admin/users/bulk-actions `assign-role` assigns a role to every id
 *          (per-item envelope, verified via GET :id/roles). Missing roleId → 400.
 *          A plain doctor → 403. TENANT_ADMIN assigning SUPER_ADMIN → per-item
 *          failure carrying the tier-guard message (mirrors POST :id/roles).
 *   P1-7 · /admin/users/export now renders human-readable email + department NAMES
 *          in every format: csv text, xlsx (parsed with exceljs), pdf (FlateDecode
 *          streams inflated and text-scanned). Spot-checks the seeded `doctor` row
 *          (doctor.smith@example.com · General Practice).
 *
 * All mutations target throwaway users (created + soft-deleted in the block) — no
 * seed rows are mutated destructively.
 */
import zlib from 'node:zlib';
import { test, expect, type APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

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

let saGlobalToken: string; // super_admin bound to __GLOBAL__ — cross-tier admin operator
let tenantAdminToken: string; // TENANT_ADMIN in __GLOBAL__ — has manage:UserRoleAssignment, NOT super
let doctorToken: string; // plain clinician — the RBAC negative

const UNIQUE = Date.now();

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

async function createUser(request: APIRequestContext, username: string): Promise<CreatedUser> {
  const res = await request.post('/api/v1/admin/users', {
    headers: bearer(saGlobalToken),
    data: { username, password: 'Password123!' },
  });
  expect(res.status(), `create throwaway user ${username}`).toBeLessThan(300);
  return (await res.json()) as CreatedUser;
}

async function deleteUser(request: APIRequestContext, id: string | undefined): Promise<void> {
  if (!id) return;
  await request.delete(`/api/v1/admin/users/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
}

/** Resolve a seeded role id by name via the rbac listing. */
async function findRoleId(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get('/api/v1/admin/rbac/roles', { headers: bearer(saGlobalToken) });
  expect(res.status(), 'list rbac roles').toBe(200);
  const role = asArray<{ id: string; name: string }>(await res.json()).find((r) => r.name === name);
  expect(role, `seeded role ${name} exists`).toBeTruthy();
  return role!.id;
}

test.beforeAll(async ({ request }) => {
  const [saG, ta, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  expect(ta, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
  saGlobalToken = saG!.token;
  tenantAdminToken = ta!.token;
  doctorToken = doc!.token;
});

// =============================================================================
// P1-6 — bulk assign-role
// =============================================================================
test.describe.serial('P1-6 — bulk assign-role', () => {
  const BULK_URL = '/api/v1/admin/users/bulk-actions';
  let u1: CreatedUser;
  let u2: CreatedUser;
  let nurseRoleId: string;
  let superAdminRoleId: string;

  test.beforeAll(async ({ request }) => {
    [u1, u2] = await Promise.all([createUser(request, `t398role_a_${UNIQUE}`), createUser(request, `t398role_b_${UNIQUE}`)]);
    nurseRoleId = await findRoleId(request, 'NURSE');
    superAdminRoleId = await findRoleId(request, 'SUPER_ADMIN');
  });
  test.afterAll(async ({ request }) => {
    await Promise.all([deleteUser(request, u1?.id), deleteUser(request, u2?.id)]);
  });

  test('P1-6 happy: assigns the role to every id and reports a per-item envelope', async ({ request }) => {
    const res = await request.post(BULK_URL, {
      headers: bearer(saGlobalToken),
      data: { action: 'assign-role', ids: [u1.id, u2.id], roleId: nurseRoleId },
    });
    expect(res.status(), 'bulk assign-role → 200').toBe(200);
    const body = (await res.json()) as BulkResult;
    expect(body).toMatchObject({ action: 'assign-role', total: 2, succeeded: 2, failed: 0 });
    expect(body.results).toContainEqual({ id: u1.id, success: true });
    expect(body.results).toContainEqual({ id: u2.id, success: true });

    // The assignment is real — the single-user roles listing shows it.
    const rolesRes = await request.get(`/api/v1/admin/users/${u1.id}/roles`, { headers: bearer(saGlobalToken) });
    expect(rolesRes.status()).toBe(200);
    const assignments = asArray<{ roleId: string }>(await rolesRes.json());
    expect(
      assignments.map((a) => a.roleId),
      'u1 carries the bulk-assigned role',
    ).toContain(nurseRoleId);
  });

  test('P1-6 validation: missing roleId → 400 before any mutation', async ({ request }) => {
    const res = await request.post(BULK_URL, {
      headers: bearer(saGlobalToken),
      data: { action: 'assign-role', ids: [u1.id] },
    });
    expect(res.status(), 'assign-role without roleId → 400').toBe(400);
  });

  test('P1-6 AC-02 tier guard: TENANT_ADMIN assigning SUPER_ADMIN fails per item (not silently)', async ({ request }) => {
    const res = await request.post(BULK_URL, {
      headers: bearer(tenantAdminToken),
      data: { action: 'assign-role', ids: [u1.id], roleId: superAdminRoleId },
    });
    // The imperative manage:UserRoleAssignment gate passes (TENANT_ADMIN holds
    // rbac-tenant-manage); the service-level tier guard then rejects the item —
    // exactly the POST :id/roles semantics fanned out.
    expect(res.status(), 'envelope still 200 (per-item failure semantics)').toBe(200);
    const body = (await res.json()) as BulkResult;
    expect(body).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
    expect(body.results[0]?.error ?? '', 'tier-guard message surfaces on the item').toContain('SUPER_ADMIN');

    const rolesRes = await request.get(`/api/v1/admin/users/${u1.id}/roles`, { headers: bearer(saGlobalToken) });
    const assignments = asArray<{ roleId: string }>(await rolesRes.json());
    expect(
      assignments.map((a) => a.roleId),
      'no SUPER_ADMIN assignment was created',
    ).not.toContain(superAdminRoleId);
  });

  test('P1-6 RBAC: a plain doctor cannot bulk assign-role (403)', async ({ request }) => {
    const res = await request.post(BULK_URL, {
      headers: bearer(doctorToken),
      data: { action: 'assign-role', ids: [u1.id], roleId: nurseRoleId },
    });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// P1-7 — export enrichment (email + department NAMES in csv/xlsx/pdf)
// =============================================================================
test.describe('P1-7 — export email + department-name enrichment', () => {
  const exportUrl = (fmt: string) => `/api/v1/admin/users/export?format=${fmt}`;
  const DOCTOR_EMAIL = SEEDED_USERS.doctor.email; // doctor.smith@example.com
  // Seeded primary department of `doctor` — the Global tenant's catalog is the
  // platform-generic CARE-SETTING roster (`DEFAULT_DEPARTMENTS` in
  // packages/database/src/prisma/db_main/seed/04-department.ts), not the
  // specialty roster that owner ruling OD-8 confined to ArcaAI. Was
  // 'General Practice' (the retired GEN row) before TASK-763.
  const DOCTOR_DEPT = 'General Outpatient';

  test('P1-7 csv carries a real email and department NAME (not ids)', async ({ request }) => {
    const res = await request.get(exportUrl('csv'), { headers: bearer(saGlobalToken) });
    expect(res.status(), 'csv export → 200').toBe(200);
    expect(res.headers()['content-type']).toContain('csv');
    const text = (await res.body()).toString('utf8');
    expect(text, 'header row').toContain('Username,Email,Type,Status,Departments,ID');
    expect(text, 'seeded doctor email is rendered').toContain(DOCTOR_EMAIL);
    expect(text, 'department NAME (not id) is rendered').toContain(DOCTOR_DEPT);
  });

  test('P1-7 xlsx sheet renders the enriched cells (parsed via exceljs)', async ({ request }) => {
    const res = await request.get(exportUrl('xlsx'), { headers: bearer(saGlobalToken) });
    expect(res.status(), 'xlsx export → 200').toBe(200);
    expect(res.headers()['content-type']).toContain('spreadsheet');
    const buf = await res.body();
    expect(buf.subarray(0, 2).toString('latin1'), 'xlsx is a zip (PK magic)').toBe('PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Users');
    expect(sheet, 'Users worksheet exists').toBeTruthy();

    const rows: string[][] = [];
    sheet!.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? '')));
      rows.push(cells);
    });
    expect(rows[0], 'header row').toEqual(['Username', 'Email', 'Type', 'Status', 'Departments', 'ID']);

    const doctorRow = rows.find((cells) => cells[0] === SEEDED_USERS.doctor.username);
    expect(doctorRow, 'seeded doctor row present in the sheet').toBeTruthy();
    expect(doctorRow![1], 'email cell').toBe(DOCTOR_EMAIL);
    expect(doctorRow![4], 'departments cell carries the NAME').toContain(DOCTOR_DEPT);
  });

  test('P1-7 pdf body contains the enriched text (FlateDecode streams inflated)', async ({ request }) => {
    const res = await request.get(exportUrl('pdf'), { headers: bearer(saGlobalToken) });
    expect(res.status(), 'pdf export → 200').toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
    const buf = await res.body();
    expect(buf.subarray(0, 4).toString('latin1'), 'pdf magic bytes').toBe('%PDF');

    // pdfkit deflates page content streams and writes text as HEX strings
    // inside `TJ` arrays (`[<646f63746f72> 50 <2e736d697468…>] TJ`, kern
    // numbers between fragments). Inflate every stream…endstream block,
    // decode every <hex> token in order, and join — split literals rejoin.
    let inflated = '';
    const raw = buf.toString('latin1');
    const streamRe = /stream\r?\n/g;
    let match: RegExpExecArray | null;
    while ((match = streamRe.exec(raw)) !== null) {
      const start = match.index + match[0].length;
      const end = raw.indexOf('endstream', start);
      if (end < 0) continue;
      const chunk = buf.subarray(start, end);
      try {
        inflated += zlib.inflateSync(chunk).toString('latin1');
      } catch {
        inflated += chunk.toString('latin1'); // uncompressed stream
      }
    }
    const joined = [...inflated.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
    expect(joined, 'pdf text carries the seeded email').toContain(DOCTOR_EMAIL);
    expect(joined, 'pdf text carries the department NAME').toContain(DOCTOR_DEPT);
  });
});
