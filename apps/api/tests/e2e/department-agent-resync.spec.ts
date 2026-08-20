/**
 * Agent golden-library provisioning + resync, end-to-end.
 *
 * Exercises the two runtime halves through the real gateway:
 *   - Part 2: creating a tenant clones the SYSTEM agent golden library into it
 *     (`TenantService.provisionTenantAgentCatalog`). Proven indirectly but
 *     decisively: immediately after create, a single-tenant RESYNC of the new
 *     tenant reports every golden agent already present (added:0, skipped:N) —
 *     which can only be true if provisioning ran.
 *   - Part 3: the `POST admin/department-agents/resync` reconciler — super-admin
 *     only (`@CanManage('Tenant')`, the same posture as tenant provisioning),
 *     idempotent, and refusing to resync the SYSTEM tenant against itself.
 *
 * The reconciler is the DepartmentAgent sibling of the pipeline resync
 * ; its cross-tenant privilege posture is asserted the same way.
 *
 * A SINGLE super-admin token is acquired in `beforeAll` and reused across
 * tests — the login endpoint is tiered-rate-limited (strict tier), so a
 * login-per-test pattern trips the throttler on a warm instance and turns
 * endpoint proofs into misleading login-null failures. The super-admin-only
 * gate (a tenant admin gets 403) is asserted in the controller unit test
 * (`department-agent-resync.controller.test.ts`), so it is not re-logged-in here.
 *
 * Live-stack requirement: dev stack + seed (`pnpm test:api:up`).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

interface ResyncSummary {
  added: number;
  fastForwarded: number;
  skipped: number;
}

let superAdminToken: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  const ctx: APIRequestContext = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    const superAdmin = await loginUser(ctx, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super admin login').not.toBeNull();
    superAdminToken = superAdmin!.token;
  } finally {
    await ctx.dispose();
  }
});

// SERIAL: this file's `beforeAll` performs stateful writes (opening consultations,
// generating summaries, registering rows) that later tests read back by id.
// Under `fullyParallel: true` Playwright spreads one file's tests across workers,
// so `beforeAll` re-runs concurrently and those setups race each other — the
// symptom is failures that vanish under `--workers=1`. Pin the file to one worker.
test.describe.configure({ mode: 'serial' });

test.describe('agent resync — authorization', () => {
  test('resyncing the SYSTEM tenant against itself is rejected (400)', async ({ request }) => {
    const rejected = await request.post('/api/v1/admin/department-agents/resync', {
      headers: auth(superAdminToken),
      data: { tenantId: SYSTEM_TENANT_ID },
    });
    expect(rejected.status()).toBe(400);
  });
});

test.describe('agent resync — sweep + idempotency', () => {
  test('a super admin sweeps every tenant and the sweep is idempotent', async ({ request }) => {
    // First sweep converges every existing tenant onto the golden library.
    const first = await request.post('/api/v1/admin/department-agents/resync', {
      headers: auth(superAdminToken),
      data: {},
    });
    expect(first.status()).toBe(200);
    const firstSummary = (await first.json()) as ResyncSummary;
    expect(firstSummary).toMatchObject({
      added: expect.any(Number),
      fastForwarded: expect.any(Number),
      skipped: expect.any(Number),
    });

    // Second sweep must be a no-op — nothing added or fast-forwarded.
    const second = await request.post('/api/v1/admin/department-agents/resync', {
      headers: auth(superAdminToken),
      data: {},
    });
    expect(second.status()).toBe(200);
    const secondSummary = (await second.json()) as ResyncSummary;
    expect(secondSummary.added).toBe(0);
    expect(secondSummary.fastForwarded).toBe(0);
    expect(secondSummary.skipped).toBeGreaterThan(0);
  });
});

test.describe('agent provisioning — a new tenant gets the golden library', () => {
  test('creating a tenant provisions golden agents; resyncing it is then a no-op', async ({ request }) => {
    // Throwaway tenant — a real uuid-v7 id, so the single-tenant resync path
    // accepts it. Cleaned up at the end.
    const key = `TASK548_E2E_${Date.now()}`;
    const created = await request.post('/api/v1/admin/tenants', {
      headers: auth(superAdminToken),
      data: { name: 'TASK-548 e2e provisioning probe', key },
    });
    expect(created.status()).toBe(201);
    const tenant = (await created.json()) as { id: string };

    try {
      // If provisioning ran at create time, the golden agents are ALL present,
      // so the reconciler adds nothing and skips them as pristine/current.
      const resynced = await request.post('/api/v1/admin/department-agents/resync', {
        headers: auth(superAdminToken),
        data: { tenantId: tenant.id },
      });
      expect(resynced.status()).toBe(200);
      const summary = (await resynced.json()) as ResyncSummary;
      expect(summary.added).toBe(0);
      expect(summary.fastForwarded).toBe(0);
      // One skipped per provisioned golden agent (the full day-1 catalog).
      // The catalog is `DEFAULT_DEPARTMENTS`
      // (packages/database/src/prisma/db_main/seed/04-department.ts), which
      // owner ruling OD-8 replaced with EIGHT platform-generic care settings —
      // the 18-row specialty roster it used to carry now belongs to ArcaAI
      // alone, so this floor moved 18 → 8 with the catalog.
      expect(summary.skipped).toBeGreaterThanOrEqual(8);
    } finally {
      // Cleanup — soft-delete the throwaway tenant.
      await request.delete(`/api/v1/admin/tenants/${tenant.id}`, { headers: auth(superAdminToken) });
    }
  });
});
