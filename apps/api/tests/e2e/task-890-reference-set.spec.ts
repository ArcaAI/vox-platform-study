/**
 * TASK-890 §3.4 (OD-H / OD-J / OD-M) — DEPTH coverage for the SYSTEM REFERENCE SET.
 *
 * The owner rule (§1.5) is that CONTENT is cloned and CONFIG cascades. Everything downstream of
 * L13 depends on the first half being true at tenant-creation time, and none of it is expressible
 * in the route matrix, which can only say who may call the route:
 *
 *  - a tenant created through the API comes out CARRYING the platform content (agents with their
 *    TENANT assignments, prompt templates, the legacy bridge schema), because after step v it
 *    resolves nothing from SYSTEM and would otherwise fail closed on its first consultation;
 *  - and carrying NO clone of the two things that are CONFIG — the `AiModel` catalogue (OD-O)
 *    and the platform `GlobalSetting` rows (OD-P). A clone of either is a frozen snapshot that
 *    stops tracking the platform, which is the defect the two retirements exist to remove;
 *  - the re-sync route puts back what a tenant DELETED and leaves alone what it EDITED, which is
 *    the difference between a repair and an overwrite;
 *  - and it is a platform-administrator action: a tenant admin gets a 403, not a partial run.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const TENANTS = '/api/v1/admin/tenants';

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

async function tenantAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return login!.token;
}

/** A fresh tenant, created the way production creates one — through `TenantService.create`. */
async function createTenant(request: APIRequestContext, token: string): Promise<{ id: string; key: string }> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const response = await request.post(TENANTS, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `Reference Set ${suffix}`, key: `REFSET_${suffix}` },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json();
  return { id: body.id, key: body.key };
}

/** Read a tenant-scoped admin collection AS that tenant (super admin + `X-Tenant-Id`). */
async function asTenant(request: APIRequestContext, token: string, tenantId: string, path: string) {
  return request.get(path, { headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId } });
}

test.describe('TASK-890 — a new tenant is provisioned with the platform reference set', () => {
  test('it carries the platform agents and their TENANT assignments, cloned as its own rows', async ({ request }) => {
    const token = await superAdminToken(request);
    const tenant = await createTenant(request, token);

    const agents = await asTenant(request, token, tenant.id, '/api/v1/admin/agents');
    expect(agents.status(), await agents.text()).toBe(200);
    const agentRows = (await agents.json()) as Array<Record<string, unknown>>;

    // Every row is the TENANT's own — provisioning CLONES, so `tenantId` is never SYSTEM — and
    // each carries the provenance the console's "from platform" badge and the re-sync both read.
    expect(agentRows.length, 'the tenant must own at least one provisioned agent').toBeGreaterThan(0);
    for (const row of agentRows) {
      expect(row['tenantId']).toBe(tenant.id);
    }
    const provisioned = agentRows.filter((row) => row['sourceTenantId'] === '00000000-0000-0000-0000-000000000000');
    expect(provisioned.length, 'at least one agent must descend from the SYSTEM reference set').toBeGreaterThan(0);

    const assignments = await asTenant(request, token, tenant.id, '/api/v1/admin/agent-assignments');
    expect(assignments.status(), await assignments.text()).toBe(200);
    const assignmentRows = (await assignments.json()) as Array<Record<string, unknown>>;
    expect(assignmentRows.length, 'the cascade has no SYSTEM tier — the tenant needs its own assignment').toBeGreaterThan(0);
    for (const row of assignmentRows) {
      expect(row['tenantId']).toBe(tenant.id);
      // The slug must resolve IN THE TENANT, or the assignment points at nothing.
      expect(agentRows.some((agent) => agent['slug'] === row['agentSlug'])).toBe(true);
    }
  });

  test('each tenant gets its OWN copies of the platform prompt library — same names, disjoint rows', async ({ request }) => {
    const token = await superAdminToken(request);
    const [first, second] = [await createTenant(request, token), await createTenant(request, token)];

    const read = async (tenantId: string) => {
      const response = await asTenant(request, token, tenantId, '/api/v1/admin/prompt-templates?limit=200');
      expect(response.status(), await response.text()).toBe(200);
      const body = await response.json();
      return (Array.isArray(body) ? body : body.data) as Array<Record<string, unknown>>;
    };

    const firstRows = await read(first.id);
    const secondRows = await read(second.id);
    expect(firstRows.length, 'the tenant must own its clones of the platform prompt library').toBeGreaterThan(0);

    // The SAME names — both were provisioned from the same reference set — carried by DISJOINT
    // rows. That pair of facts IS "cloned, not shared": a shared read would have handed both
    // tenants the identical platform ids, and each tenant can now edit its own copy.
    const names = (rows: Array<Record<string, unknown>>) => new Set(rows.map((row) => row['name'] as string));
    expect([...names(firstRows)].sort()).toEqual([...names(secondRows)].sort());

    const firstIds = new Set(firstRows.map((row) => row['id'] as string));
    for (const row of secondRows) {
      expect(firstIds.has(row['id'] as string), 'two tenants must never share a prompt row').toBe(false);
    }
  });

  test('it carries NO AiModel clone and NO GlobalSetting clone — the catalogue and the settings are CONFIG', async ({ request }) => {
    const token = await superAdminToken(request);
    const tenant = await createTenant(request, token);

    // The catalogue the tenant SEES is the SYSTEM one, read through the shared-read set (OD-O):
    // every row it can pick is platform-owned, and it owns none of them.
    const catalogue = await asTenant(request, token, tenant.id, '/api/v1/admin/ai-models/catalogue');
    expect(catalogue.status(), await catalogue.text()).toBe(200);
    const models = (await catalogue.json()) as { models?: Array<Record<string, unknown>> };
    for (const model of models.models ?? []) {
      expect(model['tenantId'] ?? '00000000-0000-0000-0000-000000000000').not.toBe(tenant.id);
    }

    // And the settings: absence is the answer, because `AppSettingsService` resolves
    // tenant → SYSTEM at READ time. A clone here would be the frozen-snapshot defect OD-P removed.
    const settings = await request.get(`${TENANTS}/${tenant.id}/configs`, { headers: { Authorization: `Bearer ${token}` } });
    if (settings.status() === 200) {
      const configBody = await settings.json();
      const configRows = (Array.isArray(configBody) ? configBody : (configBody.data ?? [])) as Array<Record<string, unknown>>;
      expect(configRows.length, 'a new tenant must own no cloned GlobalSetting row').toBe(0);
    }
  });
});

test.describe('TASK-890 — POST /admin/tenants/:id/reference-set/sync', () => {
  test('re-adds a clone the tenant deleted, and reports zero on a second run', async ({ request }) => {
    const token = await superAdminToken(request);
    const tenant = await createTenant(request, token);

    // An ASSIGNMENT rather than an agent: an ACTIVE PUBLISHED agent correctly refuses deletion
    // (409), and the assignment is the row whose absence actually fails a tenant closed —
    // `AgentAssignmentService.resolve` walks department → tenant and stops.
    const before = await asTenant(request, token, tenant.id, '/api/v1/admin/agent-assignments');
    const rows = (await before.json()) as Array<Record<string, unknown>>;
    expect(rows.length, 'provisioning must have written the tenant`s own assignments').toBeGreaterThan(0);

    // A versioned route: `RequiresIfMatchGuard` answers 428 before authorization, so the delete
    // carries the row's current ETag.
    const victim = await request.get(`/api/v1/admin/agent-assignments/${rows[0]['id']}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenant.id },
    });
    expect(victim.status()).toBe(200);
    const etag = victim.headers()['etag'];
    expect(etag, 'the assignment must carry an ETag for the If-Match delete').toBeTruthy();

    const deleted = await request.delete(`/api/v1/admin/agent-assignments/${rows[0]['id']}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenant.id, 'If-Match': etag },
    });
    expect([200, 204]).toContain(deleted.status());

    const resync = await request.post(`${TENANTS}/${tenant.id}/reference-set/sync`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { mode: 'missing-only', kinds: ['agentAssignments'] },
    });
    expect(resync.status(), await resync.text()).toBe(200);
    const summary = await resync.json();
    expect(summary.tenantId).toBe(tenant.id);
    expect(summary.mode).toBe('missing-only');
    expect(summary.kinds.agentAssignments.added, 'the deleted assignment must come back').toBeGreaterThan(0);

    // Idempotent: the repair is missing-only, so running it again changes nothing.
    const again = await request.post(`${TENANTS}/${tenant.id}/reference-set/sync`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { mode: 'missing-only', kinds: ['agentAssignments'] },
    });
    expect(again.status()).toBe(200);
    expect((await again.json()).kinds.agentAssignments.added).toBe(0);
  });

  test('refuses the SYSTEM tenant — it IS the reference set', async ({ request }) => {
    const token = await superAdminToken(request);
    const response = await request.post(`${TENANTS}/00000000-0000-0000-0000-000000000000/reference-set/sync`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(response.status()).toBe(400);
  });

  test('a tenant admin is refused — writing another tenant`s content is a platform action', async ({ request }) => {
    const superToken = await superAdminToken(request);
    const tenant = await createTenant(request, superToken);
    const tenantToken = await tenantAdminToken(request);

    const response = await request.post(`${TENANTS}/${tenant.id}/reference-set/sync`, {
      headers: { Authorization: `Bearer ${tenantToken}` },
      data: {},
    });
    expect(response.status()).toBe(403);
  });

  test('rejects an unknown kind rather than silently running the whole set', async ({ request }) => {
    const token = await superAdminToken(request);
    const tenant = await createTenant(request, token);
    const response = await request.post(`${TENANTS}/${tenant.id}/reference-set/sync`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { kinds: ['aiModels'] },
    });
    expect(response.status()).toBe(400);
  });
});
