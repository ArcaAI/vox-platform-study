/**
 * Super-admin tier backend backlog (Group E) backend contract.
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968/api/v1`). Mirrors the
 * harness of users-backend-backlog.spec.ts (seeded `super_admin` bound
 * to `__GLOBAL__` = admin operator WITH tenant context; a second `super_admin`
 * session with NO tenant key = cross-tenant operator; `doctor` = RBAC negative).
 *
 * Coverage (ticket §Items #22–25):
 *   #22 policy CRUD (AUTH-SENSITIVE) · create → patch → soft-delete a throwaway
 *        TENANT policy round-trips; the seeded GLOBAL `system-full-access` /
 *        `rbac-system-manage` policies REFUSE (403) deletion, load-bearing-rule
 *        removal, GLOBAL→TENANT scope change, and DISABLE — the anti-lockout
 *        guard. Negatives target seeded rows but are rejected before any write,
 *        so no seed policy is mutated.
 *   #23 api-key rotate · rotate mints a NEW key + a NEW one-time raw secret; the
 *        old key stays fetchable (24h grace window, not hard-deleted).
 *   #24 global-settings CRUD · create → GET → OCC PATCH (If-Match) → soft-delete
 *        a throwaway setting round-trips at `/admin/settings`.
 *   #25 audit export · csv (default) / xlsx / pdf stream the right content-type +
 *        attachment + magic bytes; a cross-tenant (no-tenant) super-admin export
 *        carries the `tenantId` column.
 *   Every item: a plain `doctor` is 403 on the admin surface.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// Policy DELETE demands break-glass step-up (caller's current
// password + type-the-exact-name). Protected-policy deletes stay 403 with or
// without it (absolute anti-lockout).
const breakGlass = (confirmationName: string) => ({
  password: SEEDED_USERS.superAdmin.password,
  confirmationName,
});

// Seeded protected GLOBAL policies (packages/database/.../seed/01-policy.ts).
const SYSTEM_FULL_ACCESS_ID = '00000000-0000-0000-0001-000000000001';
const RBAC_SYSTEM_MANAGE_ID = '00000000-0000-0000-0001-000000000010';

interface PolicyDto {
  id: string;
  name: string;
  scope: string;
  rules: Array<{ action: string; subject: string }>;
  resourceStatus: string;
}
interface ApiKeyEnvelope {
  apiKey: { id: string };
  rawKey: string;
}
interface SettingDto {
  id: string;
  key: string;
  value: string;
  version: number;
}

let saGlobalToken: string; // super_admin bound to __GLOBAL__ — admin operator WITH tenant context
let saNoTenantToken: string; // super_admin with NO tenant key — cross-tenant operator
let doctorToken: string; // plain clinician — the RBAC negative
const UNIQUE = Date.now();

test.beforeAll(async ({ request }) => {
  const [saG, saX, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  expect(saX, 'super_admin (cross-tenant) login failed').toBeTruthy();
  expect(doc, 'doctor login failed').toBeTruthy();
  saGlobalToken = saG!.token;
  saNoTenantToken = saX!.token;
  doctorToken = doc!.token;
});

// =============================================================================
// #22 — CASL policy-rules editing (AUTH-SENSITIVE) + anti-lockout guard
// =============================================================================
test.describe.serial('#22 — policy CRUD + system-lockout guard', () => {
  let throwawayId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (throwawayId) {
      await request
        .delete(`/api/v1/admin/rbac/policies/${throwawayId}`, {
          headers: bearer(saGlobalToken),
          data: breakGlass(`t390-throwaway-${UNIQUE}`), // break-glass step-up
        })
        .catch(() => undefined);
    }
  });

  test('#22 create → patch → soft-delete a throwaway TENANT policy round-trips', async ({ request }) => {
    const create = await request.post('/api/v1/admin/rbac/policies', {
      headers: bearer(saGlobalToken),
      data: {
        name: `t390-throwaway-${UNIQUE}`,
        description: 'TASK-390 e2e throwaway policy',
        scope: 'TENANT',
        rules: [{ action: 'read', subject: 'Consultation' }],
      },
    });
    expect(create.status(), 'create policy').toBe(201);
    const created = (await create.json()) as PolicyDto;
    throwawayId = created.id;
    expect(created.name).toBe(`t390-throwaway-${UNIQUE}`);

    const patch = await request.patch(`/api/v1/admin/rbac/policies/${throwawayId}`, {
      headers: bearer(saGlobalToken),
      data: {
        rules: [
          { action: 'read', subject: 'Consultation' },
          { action: 'create', subject: 'Consultation' },
        ],
      },
    });
    expect(patch.status(), 'patch policy rules').toBe(200);
    expect(((await patch.json()) as PolicyDto).rules.length).toBe(2);

    // Deletes require break-glass step-up confirmation.
    const del = await request.delete(`/api/v1/admin/rbac/policies/${throwawayId}`, {
      headers: bearer(saGlobalToken),
      data: breakGlass(`t390-throwaway-${UNIQUE}`),
    });
    expect(del.status(), 'soft-delete policy → 204').toBe(204);
    throwawayId = undefined;
  });

  test('#22 GUARD: the seeded `system-full-access` policy cannot be deleted (403)', async ({ request }) => {
    const del = await request.delete(`/api/v1/admin/rbac/policies/${SYSTEM_FULL_ACCESS_ID}`, { headers: bearer(saGlobalToken) });
    expect(del.status(), 'delete of protected policy is refused').toBe(403);

    // Still intact + still carries manage:all — no lockout.
    const after = await request.get(`/api/v1/admin/rbac/policies/${SYSTEM_FULL_ACCESS_ID}`, { headers: bearer(saGlobalToken) });
    expect(after.status()).toBe(200);
    const policy = (await after.json()) as PolicyDto;
    expect(policy.rules.some((r) => r.action === 'manage' && r.subject === 'all')).toBe(true);
  });

  test('#22 GUARD: removing the load-bearing `manage:all` rule from `system-full-access` is 403', async ({ request }) => {
    const res = await request.patch(`/api/v1/admin/rbac/policies/${SYSTEM_FULL_ACCESS_ID}`, {
      headers: bearer(saGlobalToken),
      data: { rules: [{ action: 'read', subject: 'User' }] },
    });
    expect(res.status()).toBe(403);
  });

  test('#22 GUARD: disabling / re-scoping `system-full-access` is 403', async ({ request }) => {
    const disable = await request.patch(`/api/v1/admin/rbac/policies/${SYSTEM_FULL_ACCESS_ID}`, {
      headers: bearer(saGlobalToken),
      data: { resourceStatus: 'DISABLED' },
    });
    expect(disable.status(), 'cannot disable a protected policy').toBe(403);

    const rescope = await request.patch(`/api/v1/admin/rbac/policies/${SYSTEM_FULL_ACCESS_ID}`, {
      headers: bearer(saGlobalToken),
      data: { scope: 'TENANT' },
    });
    expect(rescope.status(), 'cannot re-scope a protected GLOBAL policy').toBe(403);
  });

  test('#22 GUARD: dropping `manage:Policy` from `rbac-system-manage` is 403', async ({ request }) => {
    const res = await request.patch(`/api/v1/admin/rbac/policies/${RBAC_SYSTEM_MANAGE_ID}`, {
      headers: bearer(saGlobalToken),
      // keeps Role + RolePolicy but drops the required manage:Policy → refused
      data: {
        rules: [
          { action: 'manage', subject: 'Role' },
          { action: 'manage', subject: 'RolePolicy' },
        ],
      },
    });
    expect(res.status()).toBe(403);
  });

  test('#22 RBAC: a plain doctor cannot create a policy (403)', async ({ request }) => {
    const res = await request.post('/api/v1/admin/rbac/policies', {
      headers: bearer(doctorToken),
      data: { name: `t390-doc-${UNIQUE}`, scope: 'TENANT', rules: [{ action: 'read', subject: 'Consultation' }] },
    });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// #23 — API-key rotate (grace-window semantics)
// =============================================================================
test.describe.serial('#23 — api-key rotate', () => {
  let oldId: string | undefined;
  let newId: string | undefined;
  let oldRawKey: string;

  test.afterAll(async ({ request }) => {
    for (const id of [oldId, newId]) {
      if (id) await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
    }
  });

  test('#23 rotate mints a NEW key + new one-time secret; the old key survives (grace window)', async ({ request }) => {
    const create = await request.post('/api/v1/admin/api-keys', {
      headers: bearer(saGlobalToken),
      data: { keyName: `t390 rotate ${UNIQUE}`, scopes: ['stt:transcription:read'] },
    });
    expect(create.status(), 'create api key').toBeLessThan(300);
    const created = (await create.json()) as ApiKeyEnvelope;
    oldId = created.apiKey.id;
    oldRawKey = created.rawKey;
    expect(oldRawKey, 'create returns a one-time raw key').toBeTruthy();

    const rotate = await request.post(`/api/v1/admin/api-keys/${oldId}/rotate`, { headers: bearer(saGlobalToken) });
    expect(rotate.status(), 'rotate → 2xx').toBeLessThan(300);
    const rotated = (await rotate.json()) as ApiKeyEnvelope;
    newId = rotated.apiKey.id;

    expect(newId, 'rotate returns a distinct new key id').not.toBe(oldId);
    expect(rotated.rawKey, 'rotate returns a NEW one-time raw key').toBeTruthy();
    expect(rotated.rawKey).not.toBe(oldRawKey);

    // Grace window: the old key is NOT hard-deleted — it stays fetchable.
    const oldStillThere = await request.get(`/api/v1/admin/api-keys/${oldId}`, { headers: bearer(saGlobalToken) });
    expect(oldStillThere.status(), 'old key survives the rotation (grace window)').toBe(200);

    const newExists = await request.get(`/api/v1/admin/api-keys/${newId}`, { headers: bearer(saGlobalToken) });
    expect(newExists.status()).toBe(200);
  });

  // NOTE (auth posture — RESOLVED, see README §3.2): the shared by-id gate
  // enforces OWNER-scope on top of tenant isolation, so an
  // owner-only clinician can rotate/revoke/delete/fetch only their OWN keys;
  // GLOBAL_ADMIN and tenant-admins keep their broader scope. The full
  // owner/tenant-admin/super-admin/cross-tenant matrix lives in
  // `api-key-owner-scope.spec.ts`. Here we only assert the tenant
  // boundary: an id never resolvable in scope → 404.
  test('#23 rotating a key id that does not exist in scope is 404', async ({ request }) => {
    const res = await request.post('/api/v1/admin/api-keys/00000000-0000-0000-0000-0000000390ff/rotate', {
      headers: bearer(saGlobalToken),
    });
    expect(res.status()).toBe(404);
  });
});

// =============================================================================
// #24 — Global-settings CRUD (/admin/settings) with OCC
// =============================================================================
test.describe.serial('#24 — global-settings CRUD', () => {
  let settingId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (settingId) {
      await request.delete(`/api/v1/admin/settings/${settingId}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
    }
  });

  test('#24 create → GET → OCC PATCH → soft-delete round-trips', async ({ request }) => {
    const create = await request.post('/api/v1/admin/settings', {
      headers: bearer(saGlobalToken),
      data: { name: `t390 setting ${UNIQUE}`, key: `t390.setting.${UNIQUE}`, value: 'initial', dataType: 'String' },
    });
    expect(create.status(), 'create global setting').toBe(201);
    const created = (await create.json()) as SettingDto;
    settingId = created.id;
    expect(created.value).toBe('initial');

    const get = await request.get(`/api/v1/admin/settings/${settingId}`, { headers: bearer(saGlobalToken) });
    expect(get.status()).toBe(200);
    const etag = get.headers()['etag'];
    expect(etag, 'single-object GET emits an ETag for OCC').toBeTruthy();

    const patch = await request.patch(`/api/v1/admin/settings/${settingId}`, {
      headers: { ...bearer(saGlobalToken), 'If-Match': etag },
      data: { value: 'updated' },
    });
    expect(patch.status(), 'OCC PATCH with If-Match').toBe(200);
    expect(((await patch.json()) as SettingDto).value).toBe('updated');

    const del = await request.delete(`/api/v1/admin/settings/${settingId}`, { headers: bearer(saGlobalToken) });
    expect(del.status(), 'soft-delete setting').toBeLessThan(300);
    settingId = undefined;
  });

  test('#24 PATCH without an If-Match header is 428 (OCC precondition required)', async ({ request }) => {
    const create = await request.post('/api/v1/admin/settings', {
      headers: bearer(saGlobalToken),
      data: { name: `t390 occ ${UNIQUE}`, key: `t390.occ.${UNIQUE}`, value: 'x', dataType: 'String' },
    });
    expect(create.status()).toBe(201);
    const id = ((await create.json()) as SettingDto).id;

    const res = await request.patch(`/api/v1/admin/settings/${id}`, { headers: bearer(saGlobalToken), data: { value: 'y' } });
    expect(res.status(), 'missing If-Match → 428').toBe(428);

    await request.delete(`/api/v1/admin/settings/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
  });

  test('#24 RBAC: a plain doctor cannot create a global setting (403)', async ({ request }) => {
    const res = await request.post('/api/v1/admin/settings', {
      headers: bearer(doctorToken),
      data: { name: `t390 doc ${UNIQUE}`, key: `t390.doc.${UNIQUE}`, value: 'x', dataType: 'String' },
    });
    expect(res.status()).toBe(403);
  });
});

// =============================================================================
// #25 — Audit-trail Excel/PDF export (shared table-export util)
// =============================================================================
test.describe('#25 — audit-log export formats', () => {
  test('#25 csv (default) streams text/csv with an attachment disposition', async ({ request }) => {
    const res = await request.get('/api/v1/admin/audit-logs/export', { headers: bearer(saGlobalToken) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toContain('audit-logs.csv');
    const body = await res.text();
    expect(body.split('\n')[0], 'CSV header row present').toContain('action');
  });

  test('#25 xlsx streams a spreadsheet with the PK zip magic bytes', async ({ request }) => {
    const res = await request.get('/api/v1/admin/audit-logs/export?format=xlsx', { headers: bearer(saGlobalToken) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers()['content-disposition']).toContain('audit-logs.xlsx');
    const buf = await res.body();
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });

  test('#25 pdf streams application/pdf with the %PDF magic bytes', async ({ request }) => {
    const res = await request.get('/api/v1/admin/audit-logs/export?format=pdf', { headers: bearer(saGlobalToken) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    expect(res.headers()['content-disposition']).toContain('audit-logs.pdf');
    const buf = await res.body();
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  test('#25 a cross-tenant (no-tenant) super-admin export carries the tenantId column', async ({ request }) => {
    const res = await request.get('/api/v1/admin/audit-logs/export', { headers: bearer(saNoTenantToken) });
    expect(res.status()).toBe(200);
    const header = (await res.text()).split('\n')[0];
    expect(header, 'OB-07: cross-tenant export includes tenantId').toContain('tenantId');
  });

  test('#25 RBAC: a plain doctor cannot export the audit log (403)', async ({ request }) => {
    const res = await request.get('/api/v1/admin/audit-logs/export', { headers: bearer(doctorToken) });
    expect(res.status()).toBe(403);
  });
});
