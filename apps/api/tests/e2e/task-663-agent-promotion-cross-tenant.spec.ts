/**
 * Cross-tenant probes against the agent-promotion surface.
 *
 * Promotion is the first surface in the product that deliberately CROSSES a
 * tenant boundary, so it is also the first place the house 404-over-403 posture
 * could be undone by accident. Two distinct hazards are probed here:
 *
 *  1. The promotion route answers 403 when the actor does not hold manage
 *     rights on both tenants. If that 403 could ever fire AFTER the source
 *     agent is read, the 403/404 difference would itself tell a prober whether
 *     a given agent id exists inside another tenant. So the probes assert that
 *     an unauthorized caller gets the SAME answer for a real foreign agent id
 *     and for a synthetic one.
 *
 *  2. The promotion RECORDS are ordinary tenant-scoped rows owned by the
 *     target. Reading one from a third tenant must be 404, never 403.
 *
 * Naming follows the house precedent `task-XXX-*-cross-tenant.spec.ts`.
 * Live-stack requirement: dev stack + seed (`pnpm test:up:api`).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** The ArcaAI customer tenant, a sibling of __GLOBAL__'s catalog. */
const FOREIGN_TENANT_KEY = 'ARCAAI';
/**
 * The prober must be a TENANT_ADMIN bound to ARCAAI — a caller that manages
 * NEITHER side of the promotions probed below.
 *
 * `SEEDED_USERS.admin` (`tenant_admin`) is NOT that user: it is seeded into
 * `__GLOBAL__` and holds no ARCAAI membership, so logging it in with
 * `tenantKey: 'ARCAAI'` yields 401 ("User does not have access to the specified
 * tenant") and `loginUser` returns null — every assertion below would then die
 * on the login rather than on the wire. The ARCAAI-scoped admin is
 * `arcaai_admin`, which is deliberately absent from `SEEDED_USERS` (that map is
 * the `__GLOBAL__` seed); the same local-constant pattern is used by
 * `agent-management-contract.spec.ts`.
 */
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';
const SEED_PASSWORD = 'password123';
const SYNTHETIC_ID = '019400aa-0000-7000-8000-00000000dead';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

test.describe('cross-tenant — promote', () => {
  test('a tenant-scoped caller cannot promote out of a tenant it does not manage', async ({ request }) => {
    const prober = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, FOREIGN_TENANT_KEY);
    expect(prober).not.toBeNull();

    const response = await request.post('/api/v1/admin/agent-promotions', {
      headers: auth(prober!.token),
      data: {
        sourceAgentId: SYNTHETIC_ID,
        fromTenantId: '00000000-0000-0000-0000-000000000000',
        toTenantId: '50000000-0000-0000-0000-000000000000',
      },
    });

    // Either the tenant-less-context precondition or the manage-on-both check
    // refuses it. Both are 403 PRIVILEGE answers, and crucially neither reveals
    // anything about the agent id.
    expect(response.status()).toBe(403);
  });

  test('an unauthorized caller cannot distinguish a real foreign agent from a synthetic id', async ({ request }) => {
    // 1. Resolve a REAL agent id inside the GLOBAL tenant.
    const owner = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(owner).not.toBeNull();

    const list = await request.get('/api/v1/admin/department-agents?page=1&limit=1', { headers: auth(owner!.token) });
    expect(list.status()).toBe(200);
    const agents = (await list.json()) as { data: Array<{ id: string }> };
    test.skip(agents.data.length === 0, 'no seeded department agent to probe with');
    const realAgentId = agents.data[0].id;

    // 2. Probe BOTH ids from a tenant-scoped token that manages neither side.
    const prober = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, FOREIGN_TENANT_KEY);
    expect(prober).not.toBeNull();

    const body = (sourceAgentId: string) => ({
      sourceAgentId,
      fromTenantId: '00000000-0000-0000-0000-000000000000',
      toTenantId: '50000000-0000-0000-0000-000000000000',
    });

    const real = await request.post('/api/v1/admin/agent-promotions', { headers: auth(prober!.token), data: body(realAgentId) });
    const synthetic = await request.post('/api/v1/admin/agent-promotions', { headers: auth(prober!.token), data: body(SYNTHETIC_ID) });

    // Identical on the wire — no existence oracle over another tenant's agents.
    expect(real.status()).toBe(synthetic.status());
    expect(real.status()).toBe(403);
  });

  test('a promotion never targets the same tenant it came from', async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(admin).not.toBeNull();

    const response = await request.post('/api/v1/admin/agent-promotions', {
      headers: auth(admin!.token),
      data: {
        sourceAgentId: SYNTHETIC_ID,
        fromTenantId: '50000000-0000-0000-0000-000000000000',
        toTenantId: '50000000-0000-0000-0000-000000000000',
      },
    });

    // 400 (same tenant) or 403 (context not elevated/tenant-less) — never a
    // silent success, and never a 404 that would confirm the agent id.
    expect([400, 403]).toContain(response.status());
  });
});

test.describe('cross-tenant — promotion records', () => {
  test("reading another tenant's promotion record is 404, never 403", async ({ request }) => {
    const prober = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, FOREIGN_TENANT_KEY);
    expect(prober).not.toBeNull();

    const response = await request.get(`/api/v1/admin/agent-promotions/${SYNTHETIC_ID}`, { headers: auth(prober!.token) });

    expect(response.status()).toBe(404);
  });

  test('the promotion list is scoped to the working tenant', async ({ request }) => {
    const prober = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, FOREIGN_TENANT_KEY);
    expect(prober).not.toBeNull();

    const response = await request.get('/api/v1/admin/agent-promotions?page=1&limit=50', { headers: auth(prober!.token) });
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { data: Array<{ toTenantId: string }> };
    // Every row a tenant can see is one promoted INTO it.
    for (const row of body.data) {
      expect(row.toTenantId).not.toBe('00000000-0000-0000-0000-000000000000');
    }
  });

  test('there is no route to mutate a promotion record (WORM)', async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(admin).not.toBeNull();

    const patched = await request.patch(`/api/v1/admin/agent-promotions/${SYNTHETIC_ID}`, {
      headers: auth(admin!.token),
      data: { checksum: 'tampered' },
    });
    const deleted = await request.delete(`/api/v1/admin/agent-promotions/${SYNTHETIC_ID}`, { headers: auth(admin!.token) });

    expect(patched.status()).toBe(404);
    expect(deleted.status()).toBe(404);
  });
});
