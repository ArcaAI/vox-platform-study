/**
 * Cross-tenant probes against the TASK-531 surfaces (clone + resync).
 *
 * AUTHORED BY TASK-531, EXECUTED BY TASK-534 (program plan §2.2).
 *
 * Every new by-id admin surface needs cross-tenant coverage (rule 05 DoD), and
 * this ticket adds two. The specific hazard TASK-531 introduces is that the
 * lock check answers 403 with a message that NAMES the resource's nature. If
 * that 403 could ever fire before the ownership check, a prober could learn
 * that a given pipeline id exists in another tenant — the exact existence leak
 * the house 404-over-403 posture exists to prevent.
 *
 * So these probes assert not just the status code but that the lock guidance
 * text NEVER appears in a cross-tenant response body.
 *
 * Naming follows the house precedent `task-XXX-*-cross-tenant.spec.ts`.
 * Live-stack requirement: dev stack + seed (`pnpm test:api:up`).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const LOCK_MESSAGE = 'Template copies are read-only';
const TEMPLATE_SLUG = 'production-whisper-large-v3-turbo-gguf';

/** The ArcaAI customer tenant, whose catalog is a sibling of __GLOBAL__'s. */
const FOREIGN_TENANT_KEY = 'ARCAAI';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

test.describe('TASK-531 cross-tenant — clone', () => {
  test("cloning another tenant's locked pipeline is 404 and never leaks the lock message", async ({ request }) => {
    // 1. Resolve a real pipeline id inside the GLOBAL tenant.
    const owner = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(owner).not.toBeNull();

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, {
      headers: auth(owner!.token),
    });
    expect(detail.status()).toBe(200);
    const foreignPipeline = (await detail.json()) as { id: string };

    // 2. Probe it from a token scoped to a DIFFERENT tenant.
    const prober = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);
    expect(prober).not.toBeNull();

    const cloned = await request.post(`/api/v1/admin/audio/pipelines/${foreignPipeline.id}/clone`, {
      headers: auth(prober!.token),
      data: { name: 'Stolen', slug: `task-531-xt-${Date.now()}` },
    });

    expect(cloned.status()).toBe(404);
    // The 403 path must be unreachable across tenants — ownership runs first.
    expect(await cloned.text()).not.toContain(LOCK_MESSAGE);
  });

  test('an unknown id and a cross-tenant id are indistinguishable on the wire', async ({ request }) => {
    const prober = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);
    expect(prober).not.toBeNull();

    const synthetic = await request.post('/api/v1/admin/audio/pipelines/019400aa-0000-7000-8000-00000000dead/clone', {
      headers: auth(prober!.token),
      data: { name: 'Ghost', slug: `task-531-ghost-${Date.now()}` },
    });

    expect(synthetic.status()).toBe(404);
    expect(await synthetic.text()).not.toContain(LOCK_MESSAGE);
  });
});

test.describe('TASK-531 cross-tenant — PATCH/DELETE on a foreign locked copy', () => {
  test('PATCH is 404 (not the 403 a same-tenant caller would see)', async ({ request }) => {
    const owner = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, {
      headers: auth(owner!.token),
    });
    const foreign = (await detail.json()) as { id: string; version: number };

    const prober = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);

    const patch = await request.patch(`/api/v1/admin/audio/pipelines/${foreign.id}`, {
      headers: { ...auth(prober!.token), 'If-Match': `"${foreign.version}"` },
      data: { name: 'Cross-tenant rename' },
    });

    expect(patch.status()).toBe(404);
    expect(await patch.text()).not.toContain(LOCK_MESSAGE);
  });

  test('DELETE is 404 and the foreign row survives', async ({ request }) => {
    const owner = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, {
      headers: auth(owner!.token),
    });
    const foreign = (await detail.json()) as { id: string };

    const prober = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);

    const removed = await request.delete(`/api/v1/admin/audio/pipelines/${foreign.id}`, {
      headers: auth(prober!.token),
    });
    expect(removed.status()).toBe(404);
    expect(await removed.text()).not.toContain(LOCK_MESSAGE);

    // The owner can still see it — the probe neither leaked nor mutated.
    const after = await request.get(`/api/v1/admin/audio/pipelines/${foreign.id}`, {
      headers: auth(owner!.token),
    });
    expect(after.status()).toBe(200);
  });
});

test.describe('TASK-531 cross-tenant — resync', () => {
  test('a tenant admin cannot resync their own tenant, let alone another', async ({ request }) => {
    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(tenantAdmin).not.toBeNull();

    const tenants = await request.get('/api/v1/admin/tenants', { headers: auth(tenantAdmin!.token) });
    // A tenant admin may not even list tenants; when they can, resync must
    // still refuse. Either way the reconciler stays global-admin-only.
    if (tenants.status() === 200) {
      const body = (await tenants.json()) as { data: { id: string }[] };
      const anyTenant = body.data[0];
      if (anyTenant) {
        const denied = await request.post(`/api/v1/admin/tenants/${anyTenant.id}/pipelines/resync`, {
          headers: auth(tenantAdmin!.token),
        });
        expect([401, 403, 404]).toContain(denied.status());
      }
    } else {
      expect([401, 403]).toContain(tenants.status());
    }
  });

  test('resyncing the SYSTEM tenant against itself is rejected', async ({ request }) => {
    const globalAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(globalAdmin).not.toBeNull();

    const rejected = await request.post('/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/pipelines/resync', {
      headers: auth(globalAdmin!.token),
    });
    expect(rejected.status()).toBe(400);
  });
});
