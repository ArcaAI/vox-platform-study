/**
 * Tenant checkpoints — hand-written depth (the authz matrix covers per-route credential-class
 * conformance; this file covers what a matrix cannot express).
 *
 *   - a tenant admin is pinned to its own tenant: 404 on a foreign `:tenantId`
 *   - Clinical data is a platform-admin-only restore category (403, not 404)
 *   - break-glass: 428 missing / 401 wrong password / 400 wrong name
 *   - an archive uploaded for tenant A into tenant B ends FAILED / WRONG_TENANT
 *   - while a restore runs, mutations answer 423 and the GET status routes stay 200
 *
 * Needs a live gateway AND the checkpoint worker (`pnpm checkpoint:dev`); a test that needs a READY
 * checkpoint skips with a reason when none appears, rather than failing on a missing worker.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const base = (tenantId: string) => `/api/v1/admin/tenants/${tenantId}/checkpoints`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Checkpoint {
  id: string;
  status: string;
  failureReason: string | null;
  sizeBytes: number | null;
}

async function waitForStatus(request: APIRequestContext, token: string, tenantId: string, id: string, done: (s: string) => boolean, timeoutMs = 120_000): Promise<Checkpoint> {
  const deadline = Date.now() + timeoutMs;
  let last: Checkpoint | undefined;
  while (Date.now() < deadline) {
    const response = await request.get(`${base(tenantId)}/${id}`, { headers: auth(token) });
    expect(response.status()).toBe(200);
    last = (await response.json()) as Checkpoint;
    if (done(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return last as Checkpoint;
}

test.describe('Tenant checkpoints — depth', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let tenantName: string;
  const created: { tenantId: string; id: string }[] = [];

  /** A READY checkpoint of the Global tenant, or a skip when no worker produced one. */
  async function readyCheckpoint(request: APIRequestContext, tenantId = GLOBAL_TENANT_ID): Promise<Checkpoint> {
    const response = await request.post(base(tenantId), {
      headers: auth(superAdminToken),
      data: { label: `e2e depth ${Date.now()}`, includesMedia: false },
    });
    expect(response.status()).toBe(202);
    const row = (await response.json()) as Checkpoint;
    created.push({ tenantId, id: row.id });
    const settled = await waitForStatus(request, superAdminToken, tenantId, row.id, (s) => s === 'READY' || s === 'FAILED' || s === 'CANCELLED');
    test.skip(settled.status !== 'READY', `no READY checkpoint (status ${settled.status}) — is the checkpoint worker running?`);
    return settled;
  }

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed').toBeTruthy();
    superAdminToken = sa!.token;
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed').toBeTruthy();
    tenantAdminToken = ta!.token;

    const tenant = await request.get(`/api/v1/admin/tenants/${GLOBAL_TENANT_ID}`, { headers: auth(superAdminToken) });
    expect(tenant.status()).toBe(200);
    tenantName = ((await tenant.json()) as { name: string }).name;
  });

  test.afterAll(async ({ request }) => {
    for (const { tenantId, id } of created) {
      await request.post(`${base(tenantId)}/${id}/cancel`, { headers: auth(superAdminToken) }).catch(() => undefined);
      await request.delete(`${base(tenantId)}/${id}`, { headers: auth(superAdminToken) }).catch(() => undefined);
    }
  });

  test.describe('credential classes and tenant pinning', () => {
    test('no token → 401; an API key → 403 (these routes are human sessions only)', async ({ request }) => {
      expect((await request.get(base(GLOBAL_TENANT_ID))).status()).toBe(401);
      const withKey = await request.get(base(GLOBAL_TENANT_ID), { headers: { 'X-API-Key': SEEDED_API_KEY } });
      expect(withKey.status()).toBe(403);
    });

    test("a tenant admin gets 404 on another tenant's list, create and uploads", async ({ request }) => {
      const list = await request.get(base(ARCAAI_TENANT_ID), { headers: auth(tenantAdminToken) });
      expect(list.status()).toBe(404);
      const create = await request.post(base(ARCAAI_TENANT_ID), { headers: auth(tenantAdminToken), data: { label: 'x', includesMedia: false } });
      expect(create.status()).toBe(404);
      const upload = await request.post(`${base(ARCAAI_TENANT_ID)}/uploads`, { headers: auth(tenantAdminToken), data: { filename: 'a.hcp', sizeBytes: 10 } });
      expect(upload.status()).toBe(404);
    });

    test('the SYSTEM tenant is refused (403 SYSTEM_TENANT_NOT_CHECKPOINTABLE), even for a super admin', async ({ request }) => {
      const response = await request.get(base(SYSTEM_TENANT_ID), { headers: auth(superAdminToken) });
      expect(response.status()).toBe(403);
      const body = (await response.json()) as { code?: string; message?: { code?: string } };
      expect(body.code ?? body.message?.code).toBe('SYSTEM_TENANT_NOT_CHECKPOINTABLE');
    });
  });

  test.describe('restore authorization order', () => {
    const restoreBody = (overrides: Record<string, unknown> = {}) => ({
      categories: ['CONFIG_CONTENT'],
      reason: 'e2e restore authorization probe',
      password: SEEDED_USERS.admin.password,
      confirmationName: tenantName,
      ...overrides,
    });

    test('break-glass: 428 missing password, 401 wrong password, 400 wrong tenant name', async ({ request }) => {
      test.setTimeout(180_000);
      const checkpoint = await readyCheckpoint(request);
      const url = `${base(GLOBAL_TENANT_ID)}/${checkpoint.id}/restore`;

      const missing = await request.post(url, { headers: auth(tenantAdminToken), data: restoreBody({ password: undefined }) });
      expect(missing.status()).toBe(428);
      const wrongPassword = await request.post(url, { headers: auth(tenantAdminToken), data: restoreBody({ password: 'definitely-not-it' }) });
      expect(wrongPassword.status()).toBe(401);
      const wrongName = await request.post(url, { headers: auth(tenantAdminToken), data: restoreBody({ confirmationName: `${tenantName} (typo)` }) });
      expect(wrongName.status()).toBe(400);
    });

    test('a tenant admin asking for CLINICAL → 403 CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN (a privilege failure, not a 404)', async ({ request }) => {
      test.setTimeout(180_000);
      const checkpoint = await readyCheckpoint(request);
      const response = await request.post(`${base(GLOBAL_TENANT_ID)}/${checkpoint.id}/restore`, {
        headers: auth(tenantAdminToken),
        data: restoreBody({ categories: ['CONFIG_CONTENT', 'CLINICAL'] }),
      });
      expect(response.status()).toBe(403);
      const body = (await response.json()) as { code?: string; message?: { code?: string } };
      expect(body.code ?? body.message?.code).toBe('CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN');
    });

    test('a wrong password outranks the CLINICAL 403 (the checks run in order)', async ({ request }) => {
      test.setTimeout(180_000);
      const checkpoint = await readyCheckpoint(request);
      const response = await request.post(`${base(GLOBAL_TENANT_ID)}/${checkpoint.id}/restore`, {
        headers: auth(tenantAdminToken),
        data: restoreBody({ categories: ['CLINICAL'], password: 'definitely-not-it' }),
      });
      expect(response.status()).toBe(401);
    });
  });

  test.describe('a foreign archive', () => {
    test("an archive made for tenant A and uploaded into tenant B ends FAILED / WRONG_TENANT", async ({ request }) => {
      test.setTimeout(300_000);
      const source = await readyCheckpoint(request, GLOBAL_TENANT_ID);

      const urlResponse = await request.post(`${base(GLOBAL_TENANT_ID)}/${source.id}/download-url`, { headers: auth(superAdminToken) });
      expect(urlResponse.status()).toBe(200);
      const { url } = (await urlResponse.json()) as { url: string };
      const download = await request.get(url);
      test.skip(!download.ok(), `the presigned download URL is not reachable from the test runner (${download.status()})`);
      const archive = await download.body();

      const init = await request.post(`${base(ARCAAI_TENANT_ID)}/uploads`, {
        headers: auth(superAdminToken),
        data: { filename: 'foreign.hcp', sizeBytes: archive.length },
      });
      expect(init.status()).toBe(201);
      const { checkpoint, uploadId, partSizeBytes, parts } = (await init.json()) as {
        checkpoint: Checkpoint;
        uploadId: string;
        partSizeBytes: number;
        parts: { partNumber: number; url: string }[];
      };
      created.push({ tenantId: ARCAAI_TENANT_ID, id: checkpoint.id });

      const etags: { partNumber: number; etag: string }[] = [];
      for (const part of parts) {
        const slice = archive.subarray((part.partNumber - 1) * partSizeBytes, part.partNumber * partSizeBytes);
        const put = await request.put(part.url, { data: slice });
        expect(put.ok(), `part ${part.partNumber} upload`).toBeTruthy();
        const etag = put.headers().etag;
        expect(etag, 'MinIO CORS must expose ETag').toBeTruthy();
        etags.push({ partNumber: part.partNumber, etag });
      }

      const complete = await request.post(`${base(ARCAAI_TENANT_ID)}/uploads/${uploadId}/complete`, { headers: auth(superAdminToken), data: { parts: etags } });
      expect(complete.status()).toBe(202);

      const settled = await waitForStatus(request, superAdminToken, ARCAAI_TENANT_ID, checkpoint.id, (s) => s === 'READY' || s === 'FAILED');
      expect(settled.status).toBe('FAILED');
      expect(settled.failureReason).toBe('WRONG_TENANT');
    });

    test('completing an upload with an out-of-order part list → 400 UPLOAD_PARTS_INVALID', async ({ request }) => {
      const init = await request.post(`${base(GLOBAL_TENANT_ID)}/uploads`, { headers: auth(superAdminToken), data: { filename: 'bad-parts.hcp', sizeBytes: 10 } });
      expect(init.status()).toBe(201);
      const { checkpoint, uploadId } = (await init.json()) as { checkpoint: Checkpoint; uploadId: string };
      created.push({ tenantId: GLOBAL_TENANT_ID, id: checkpoint.id });

      const complete = await request.post(`${base(GLOBAL_TENANT_ID)}/uploads/${uploadId}/complete`, {
        headers: auth(superAdminToken),
        data: { parts: [{ partNumber: 2, etag: '"nope"' }] },
      });
      expect(complete.status()).toBe(400);

      const abort = await request.post(`${base(GLOBAL_TENANT_ID)}/uploads/${uploadId}/abort`, { headers: auth(superAdminToken) });
      expect(abort.status()).toBe(202);
      expect(((await abort.json()) as Checkpoint).status).toBe('CANCELLED');
    });
  });

  test.describe('the tenant lock', () => {
    test('while a restore runs: a mutation answers 423 TENANT_RESTORE_IN_PROGRESS and the GET status routes stay 200', async ({ request }) => {
      test.setTimeout(300_000);
      const checkpoint = await readyCheckpoint(request);

      const restore = await request.post(`${base(GLOBAL_TENANT_ID)}/${checkpoint.id}/restore`, {
        headers: auth(tenantAdminToken),
        data: {
          categories: ['CONFIG_CONTENT'],
          reason: 'e2e tenant lock probe',
          password: SEEDED_USERS.admin.password,
          confirmationName: tenantName,
        },
      });
      expect(restore.status()).toBe(202);
      const { id: restoreId } = (await restore.json()) as { id: string };

      let observedLocked = false;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const status = await request.get(`${base(GLOBAL_TENANT_ID)}/restores/${restoreId}`, { headers: auth(tenantAdminToken) });
        expect(status.status(), 'status stays readable').toBe(200);
        const list = await request.get(`${base(GLOBAL_TENANT_ID)}/restores`, { headers: auth(tenantAdminToken) });
        expect(list.status(), 'restore list stays readable').toBe(200);
        const listed = await request.get(base(GLOBAL_TENANT_ID), { headers: auth(tenantAdminToken) });
        expect(listed.status(), 'checkpoint list stays readable').toBe(200);

        const mutation = await request.post(base(GLOBAL_TENANT_ID), { headers: auth(tenantAdminToken), data: { label: 'during restore', includesMedia: false } });
        if (mutation.status() === 423) {
          const body = (await mutation.json()) as { code?: string; restoreId?: string; message?: { code?: string; restoreId?: string } };
          expect(body.code ?? body.message?.code).toBe('TENANT_RESTORE_IN_PROGRESS');
          expect(body.restoreId ?? body.message?.restoreId).toBe(restoreId);
          observedLocked = true;
        } else if (mutation.status() === 202) {
          created.push({ tenantId: GLOBAL_TENANT_ID, id: ((await mutation.json()) as Checkpoint).id });
        }
        const state = ((await status.json()) as { status: string }).status;
        if (['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(state)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(observedLocked, 'a mutation was refused with 423 while the restore ran').toBe(true);
    });
  });
});
