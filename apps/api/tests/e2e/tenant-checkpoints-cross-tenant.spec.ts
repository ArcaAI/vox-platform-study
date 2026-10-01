/**
 * Cross-tenant probes against TenantCheckpointController.
 *
 * Every route of `admin/tenants/:tenantId/checkpoints` is probed by a tenant admin of Global
 * against the ARCAAI tenant two ways:
 *   (a) ARCAAI's `:tenantId` in the path  → the controller's tenant pin answers 404;
 *   (b) Global's own `:tenantId` with an ARCAAI row id → the service's row pin answers 404.
 * A 403 or 200 here would let any tenant admin enumerate or restore another tenant's archives.
 * The 404 body stays generic (it must not name tenants) and ARCAAI's checkpoint is untouched.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';
const SYNTHETIC_ID = '018f0000-0000-7100-8000-000000000000';

const base = (tenantId: string) => `/api/v1/admin/tenants/${tenantId}/checkpoints`;

const IDLE_TIMEOUT_MS = 180_000;
const TERMINAL_RESTORE = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'];

/** What keeps a tenant busy: an in-flight checkpoint, or a restore that has not reached a terminal state. */
async function tenantState(request: APIRequestContext, headers: Record<string, string>, tenantId: string) {
  const list = await request.get(base(tenantId), { headers });
  expect(list.status()).toBe(200);
  const checkpoints = ((await list.json()) as { data: { id: string; status: string }[] }).data;
  const restores = await request.get(`${base(tenantId)}/restores`, { headers });
  expect(restores.status()).toBe(200);
  const activeRestore = ((await restores.json()) as { data: { status: string }[] }).data.some((r) => !TERMINAL_RESTORE.includes(r.status));
  const inFlight = checkpoints.filter((c) => ['PENDING', 'RUNNING', 'UPLOADING'].includes(c.status));
  return {
    checkpoints,
    busy: inFlight.length > 0 || activeRestore,
    description: `${inFlight.map((c) => c.status).join(',') || 'no export'}; restore ${activeRestore ? 'active' : 'idle'}`,
  };
}

/**
 * The ONE way setup obtains a checkpoint. Concurrent workers and the sibling spec file create in the
 * same tenants, and the service refuses a create (409 TENANT_CHECKPOINT_BUSY) while an export or restore
 * is in flight; on that 409 this waits for the tenant to go idle, then reuses a READY row or creates.
 * Returns undefined (and the caller skips) when the tenant never goes idle.
 */
async function obtainCheckpoint(
  request: APIRequestContext,
  headers: Record<string, string>,
  tenantId: string,
  label: string,
): Promise<{ id: string; created: boolean } | { skipReason: string }> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  let observed = '';
  while (Date.now() < deadline) {
    const state = await tenantState(request, headers, tenantId);
    const ready = state.checkpoints.find((c) => c.status === 'READY');
    if (ready) return { id: ready.id, created: false };
    const response = await request.post(base(tenantId), { headers, data: { label: `${label} ${Date.now()}`, includesMedia: false } });
    if (response.status() === 202) return { id: ((await response.json()) as { id: string }).id, created: true };
    expect(response.status(), 'only TENANT_CHECKPOINT_BUSY is an acceptable refusal').toBe(409);
    observed = state.description;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { skipReason: `tenant ${tenantId} never went idle (${observed})` };
}

type Probe = (request: APIRequestContext, headers: Record<string, string>, tenantId: string, id: string) => ReturnType<APIRequestContext['get']>;

const BY_ID_ROUTES: Record<string, Probe> = {
  'GET :id': (r, h, t, id) => r.get(`${base(t)}/${id}`, { headers: h }),
  'POST :id/cancel': (r, h, t, id) => r.post(`${base(t)}/${id}/cancel`, { headers: h }),
  'POST :id/download-url': (r, h, t, id) => r.post(`${base(t)}/${id}/download-url`, { headers: h }),
  'DELETE :id': (r, h, t, id) => r.delete(`${base(t)}/${id}`, { headers: h }),
  'POST :id/restore': (r, h, t, id) =>
    r.post(`${base(t)}/${id}/restore`, {
      headers: h,
      data: { categories: ['CONFIG_CONTENT'], reason: 'cross-tenant probe', password: SEEDED_USERS.admin.password, confirmationName: 'anything' },
    }),
  'POST uploads/:id/complete': (r, h, t, id) =>
    r.post(`${base(t)}/uploads/${id}/complete`, { headers: h, data: { parts: [{ partNumber: 1, etag: '"e"' }] } }),
  'POST uploads/:id/abort': (r, h, t, id) => r.post(`${base(t)}/uploads/${id}/abort`, { headers: h }),
  'GET restores/:restoreId': (r, h, t, id) => r.get(`${base(t)}/restores/${id}`, { headers: h }),
};

const TENANT_LEVEL_ROUTES: Record<string, (r: APIRequestContext, h: Record<string, string>, t: string) => ReturnType<APIRequestContext['get']>> = {
  'GET list': (r, h, t) => r.get(base(t), { headers: h }),
  'POST create': (r, h, t) => r.post(base(t), { headers: h, data: { label: 'probe', includesMedia: false } }),
  'POST uploads': (r, h, t) => r.post(`${base(t)}/uploads`, { headers: h, data: { filename: 'a.hcp', sizeBytes: 10 } }),
  'GET restores': (r, h, t) => r.get(`${base(t)}/restores`, { headers: h }),
};

test.describe('Tenant checkpoints — cross-tenant ownership', () => {
  test.describe.configure({ mode: 'serial' });
  let superHeaders: Record<string, string>;
  let adminHeaders: Record<string, string>;
  let arcaaiCheckpointId: string;
  let createdByUs = false;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed').toBeTruthy();
    superHeaders = { Authorization: `Bearer ${sa!.token}` };
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login (__GLOBAL__) failed').toBeTruthy();
    adminHeaders = { Authorization: `Bearer ${ta!.token}` };

    // A real ARCAAI row, obtained through the shared idle-aware helper (reuse READY, else create).
    const got = await obtainCheckpoint(request, superHeaders, ARCAAI_TENANT_ID, 'cross-tenant probe');
    test.skip('skipReason' in got, 'skipReason' in got ? got.skipReason : '');
    if ('skipReason' in got) return;
    arcaaiCheckpointId = got.id;
    createdByUs = got.created;
  });

  test.afterAll(async ({ request }) => {
    if (!createdByUs) return; // never delete a row this file did not create
    await request.post(`${base(ARCAAI_TENANT_ID)}/${arcaaiCheckpointId}/cancel`, { headers: superHeaders }).catch(() => undefined);
    await request.delete(`${base(ARCAAI_TENANT_ID)}/${arcaaiCheckpointId}`, { headers: superHeaders }).catch(() => undefined);
  });

  for (const [name, probe] of Object.entries(BY_ID_ROUTES)) {
    test(`${name}: ARCAAI's tenantId in the path → 404`, async ({ request }) => {
      const response = await probe(request, adminHeaders, ARCAAI_TENANT_ID, arcaaiCheckpointId);
      expect(response.status()).toBe(404);
      expect(String(((await response.json()) as { message?: string }).message ?? '')).not.toMatch(/tenant/i);
    });

    test(`${name}: own tenantId with an ARCAAI row id → 404`, async ({ request }) => {
      const response = await probe(request, adminHeaders, GLOBAL_TENANT_ID, arcaaiCheckpointId);
      expect(response.status()).toBe(404);
      expect(String(((await response.json()) as { message?: string }).message ?? '')).not.toMatch(/tenant/i);
    });

    test(`${name}: a synthetic id answers the same 404 as a foreign one`, async ({ request }) => {
      const response = await probe(request, adminHeaders, GLOBAL_TENANT_ID, SYNTHETIC_ID);
      expect(response.status()).toBe(404);
    });
  }

  for (const [name, probe] of Object.entries(TENANT_LEVEL_ROUTES)) {
    test(`${name}: ARCAAI's tenantId in the path → 404`, async ({ request }) => {
      const response = await probe(request, adminHeaders, ARCAAI_TENANT_ID);
      expect(response.status()).toBe(404);
      expect(String(((await response.json()) as { message?: string }).message ?? '')).not.toMatch(/tenant/i);
    });
  }

  test("the probes left ARCAAI's checkpoint intact", async ({ request }) => {
    const response = await request.get(`${base(ARCAAI_TENANT_ID)}/${arcaaiCheckpointId}`, { headers: superHeaders });
    expect(response.status()).toBe(200);
    expect(((await response.json()) as { status: string }).status).not.toBe('DELETED');
  });
});
