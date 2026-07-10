/**
 * TASK-390 follow-up (§3.2) — api-key OWNER-SCOPE enforcement (backend contract).
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8868/api/v1`).
 *
 * Background: the api-key admin surface's by-id operations (fetch / update /
 * delete / revoke / rotate) originally reused the tenant-scoped
 * `assertTenantOwnership` only. That did NOT enforce the per-user `userId`
 * condition carried by the seeded `api-key-own-manage` policy, so a same-tenant
 * clinician could act on ANOTHER user's key. This suite pins the corrected
 * posture:
 *   - OWNER (clinician, `api-key-own-manage`)  → may act ONLY on their OWN keys.
 *   - a same-tenant NON-admin targeting a PEER's key → 404 (existence hidden).
 *   - TENANT-ADMIN (`manage:ApiKey`)            → retains tenant-scope.
 *   - GLOBAL_ADMIN (`manage:all`)                → retains broad scope.
 *   - an id not resolvable in scope             → 404 (tenant boundary).
 *
 * Personas mirror the seed (packages/database/.../seed): `doctor` + `doctor2`
 * are two owner-only clinicians in the SAME tenant; `tenant_admin` is the
 * tenant admin; `super_admin` (with tenant context) is the platform operator.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface ApiKeyEnvelope {
  apiKey: { id: string };
  rawKey: string;
}

let doctorToken: string; // owner-only clinician (api-key-own-manage)
let doctor2Token: string; // a DIFFERENT owner-only clinician in the SAME tenant
let tenantAdminToken: string; // tenant admin (manage:ApiKey, tenant-scoped)
let saGlobalToken: string; // super_admin WITH tenant context (manage:all)
const UNIQUE = Date.now();

// Every key minted here (incl. rotation offspring) is deleted by the super-admin
// (bypasses owner-scope) in afterAll.
const createdKeyIds: string[] = [];

async function createKey(request: APIRequestContext, token: string, keyName: string): Promise<{ id: string; rawKey: string }> {
  const res = await request.post('/api/v1/admin/api-keys', {
    headers: bearer(token),
    data: { keyName, scopes: ['stt:transcription:read'] },
  });
  expect(res.status(), `create api key "${keyName}"`).toBe(201);
  const body = (await res.json()) as ApiKeyEnvelope;
  createdKeyIds.push(body.apiKey.id);
  return { id: body.apiKey.id, rawKey: body.rawKey };
}

test.describe.serial('TASK-390b — api-key owner-scope enforcement', () => {
  test.beforeAll(async ({ request }) => {
    const [doc, doc2, admin, saG] = await Promise.all([
      loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    ]);
    expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
    expect(doc2, 'doctor2 login failed').toBeTruthy();
    expect(admin, 'tenant_admin login failed').toBeTruthy();
    expect(saG, 'super_admin (__GLOBAL__) login failed').toBeTruthy();
    doctorToken = doc!.token;
    doctor2Token = doc2!.token;
    tenantAdminToken = admin!.token;
    saGlobalToken = saG!.token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
    }
  });

  test('owner (clinician) can fetch / rotate / revoke / delete their OWN keys', async ({ request }) => {
    const forFetch = await createKey(request, doctorToken, `t390b own fetch ${UNIQUE}`);
    const getOwn = await request.get(`/api/v1/admin/api-keys/${forFetch.id}`, { headers: bearer(doctorToken) });
    expect(getOwn.status(), 'owner fetch own key').toBe(200);

    const forRotate = await createKey(request, doctorToken, `t390b own rotate ${UNIQUE}`);
    const rotate = await request.post(`/api/v1/admin/api-keys/${forRotate.id}/rotate`, { headers: bearer(doctorToken) });
    expect(rotate.status(), 'owner rotate own key → 2xx').toBeLessThan(300);
    const rotated = (await rotate.json()) as ApiKeyEnvelope;
    expect(rotated.rawKey, 'rotate returns a new one-time raw key').toBeTruthy();
    createdKeyIds.push(rotated.apiKey.id);

    const forRevoke = await createKey(request, doctorToken, `t390b own revoke ${UNIQUE}`);
    const revoke = await request.post(`/api/v1/admin/api-keys/${forRevoke.id}/revoke`, { headers: bearer(doctorToken) });
    expect(revoke.status(), 'owner revoke own key → 2xx').toBeLessThan(300);

    const forDelete = await createKey(request, doctorToken, `t390b own delete ${UNIQUE}`);
    const del = await request.delete(`/api/v1/admin/api-keys/${forDelete.id}`, { headers: bearer(doctorToken) });
    expect(del.status(), 'owner delete own key → 2xx').toBeLessThan(300);
  });

  test("a same-tenant non-admin (doctor2) CANNOT fetch / rotate / revoke / delete another user's key → 404", async ({ request }) => {
    // Owned by `doctor`; `doctor2` is a peer clinician in the SAME tenant.
    const victim = await createKey(request, doctorToken, `t390b victim ${UNIQUE}`);

    const get = await request.get(`/api/v1/admin/api-keys/${victim.id}`, { headers: bearer(doctor2Token) });
    expect(get.status(), 'cross-user fetch → 404').toBe(404);

    const rotate = await request.post(`/api/v1/admin/api-keys/${victim.id}/rotate`, { headers: bearer(doctor2Token) });
    expect(rotate.status(), 'cross-user rotate → 404').toBe(404);

    const revoke = await request.post(`/api/v1/admin/api-keys/${victim.id}/revoke`, { headers: bearer(doctor2Token) });
    expect(revoke.status(), 'cross-user revoke → 404').toBe(404);

    const del = await request.delete(`/api/v1/admin/api-keys/${victim.id}`, { headers: bearer(doctor2Token) });
    expect(del.status(), 'cross-user delete → 404').toBe(404);

    // The peer's denied attempts left the key untouched: the real owner still
    // sees it, ACTIVE (not revoked, not soft-deleted).
    const stillThere = await request.get(`/api/v1/admin/api-keys/${victim.id}`, { headers: bearer(doctorToken) });
    expect(stillThere.status(), 'victim key survives the denied attempts').toBe(200);
    expect((await stillThere.json()).keyStatus, 'victim key not revoked').toBe('ACTIVE');
  });

  test("a tenant-admin retains tenant-scope: can fetch + rotate another user's key in-tenant", async ({ request }) => {
    const target = await createKey(request, doctorToken, `t390b admin-scope ${UNIQUE}`);

    const get = await request.get(`/api/v1/admin/api-keys/${target.id}`, { headers: bearer(tenantAdminToken) });
    expect(get.status(), "tenant-admin fetch another user's key").toBe(200);

    const rotate = await request.post(`/api/v1/admin/api-keys/${target.id}/rotate`, { headers: bearer(tenantAdminToken) });
    expect(rotate.status(), "tenant-admin rotate another user's key → 2xx").toBeLessThan(300);
    createdKeyIds.push(((await rotate.json()) as ApiKeyEnvelope).apiKey.id);
  });

  test("a super-admin retains broad scope: can fetch another user's key", async ({ request }) => {
    const target = await createKey(request, doctorToken, `t390b sa-scope ${UNIQUE}`);
    const get = await request.get(`/api/v1/admin/api-keys/${target.id}`, { headers: bearer(saGlobalToken) });
    expect(get.status(), "super-admin fetch another user's key").toBe(200);
  });

  test('an owner-only caller acting on an id not resolvable in scope is 404 (tenant boundary)', async ({ request }) => {
    const res = await request.post('/api/v1/admin/api-keys/00000000-0000-0000-0000-0000000390fe/rotate', {
      headers: bearer(doctorToken),
    });
    expect(res.status()).toBe(404);
  });
});
