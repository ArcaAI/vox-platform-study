/**
 * TASK-986 — reserved-tenant lockdown (R2 / owner ruling D-5) and the
 * SUPER_ADMIN-only `plan` field (R1 / owner decision D-1).
 *
 * Why this needs an e2e and not just the unit suite:
 *
 *  - The reserved rows are identified by LITERAL ids that only exist in a
 *    seeded database. The pre-existing unit fixture used a random id with the
 *    key `__GLOBAL__`, which is exactly why the id-less guard survived review:
 *    every assertion passed against a row that was not the reserved row.
 *  - The `plan` gate is a per-FIELD privilege check. The route-authz matrix
 *    (`task-776-route-authz-matrix.spec.ts`) works from `route-manifest.json`,
 *    which records `action + subject` pairs — it cannot express "this body
 *    field is super-admin-only", so the depth test belongs here
 *    (rule 05 §API Test Standard).
 *
 * Both checks answer 403, NOT the house 404-over-403 cross-tenant posture:
 * these are privilege boundaries over rows whose existence is a declared
 * constant, exactly like the platform-tier settings gates.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** The two reserved rows (`seed/00-constants.ts`), written as literals on purpose. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/**
 * The seeded ArcaAI tenant and its TENANT_ADMIN (`seed/05-tenant.ts`,
 * `seed/91-user.ts`). `SEEDED_USERS` surfaces only Global users, and Global is
 * now itself a reserved row — so the plan gate needs an admin whose OWN tenant
 * is an ordinary customer tenant, or the reserved guard answers first and the
 * test proves the wrong 403. The password is the shared seeded one.
 */
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';
const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';

interface TenantRow {
  id: string;
  key: string;
  name: string;
  plan: string | null;
  version: number;
}

async function readTenant(request: APIRequestContext, token: string, id: string): Promise<{ row: TenantRow; etag: string }> {
  const response = await request.get(`/api/v1/admin/tenants/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status(), `GET tenant ${id}`).toBe(200);
  const etag = response.headers()['etag'];
  expect(etag, `tenant ${id} must carry a strong ETag for the OCC PATCH`).toBeTruthy();
  return { row: (await response.json()) as TenantRow, etag: etag! };
}

test.describe('TASK-986 — reserved tenants refuse every PATCH', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super_admin login failed').toBeTruthy();
    superAdminToken = superAdmin!.token;
  });

  for (const [label, id] of [
    ['SYSTEM', SYSTEM_TENANT_ID],
    ['Global', GLOBAL_TENANT_ID],
  ] as const) {
    test(`${label} (${id}) — PATCH resourceStatus is 403, even for a super admin`, async ({ request }) => {
      const { etag } = await readTenant(request, superAdminToken, id);

      const response = await request.patch(`/api/v1/admin/tenants/${id}`, {
        headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': etag },
        data: { resourceStatus: 'DISABLED' },
      });

      // Before TASK-986 this was a 200 that DEACTIVATED the row.
      expect(response.status(), `PATCH ${label} must be refused`).toBe(403);
    });

    test(`${label} (${id}) — PATCH key is 403, so the guard cannot be renamed away`, async ({ request }) => {
      const { etag } = await readTenant(request, superAdminToken, id);

      const response = await request.patch(`/api/v1/admin/tenants/${id}`, {
        headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': etag },
        data: { key: `renamed-${label.toLowerCase()}` },
      });

      expect(response.status(), `PATCH ${label}.key must be refused`).toBe(403);
    });

    test(`${label} (${id}) — suspend / archive / delete are all 403`, async ({ request }) => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };

      const suspend = await request.post(`/api/v1/admin/tenants/${id}/suspend`, { headers: auth });
      expect(suspend.status(), `suspend ${label}`).toBe(403);

      const archive = await request.post(`/api/v1/admin/tenants/${id}/archive`, { headers: auth });
      expect(archive.status(), `archive ${label}`).toBe(403);

      const removed = await request.delete(`/api/v1/admin/tenants/${id}`, { headers: auth });
      expect(removed.status(), `delete ${label}`).toBe(403);
    });
  }

  test('the reserved rows are still READABLE — the lockdown is on writes only', async ({ request }) => {
    const { row } = await readTenant(request, superAdminToken, SYSTEM_TENANT_ID);
    expect(row.id).toBe(SYSTEM_TENANT_ID);
  });

  test('a reserved-key rename is refused by the DTO on an ORDINARY tenant too', async ({ request }) => {
    const { etag } = await readTenant(request, superAdminToken, ARCAAI_TENANT_ID);

    const response = await request.patch(`/api/v1/admin/tenants/${ARCAAI_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': etag },
      data: { key: '__GLOBAL__' },
    });

    // 400 from the global ValidationPipe (`NotReservedTenantKeyConstraint`),
    // not 403: the row is writable, the VALUE is not.
    expect(response.status(), 'minting a reserved-key impostor must be refused').toBe(400);
  });
});

test.describe('TASK-986 — `plan` is a SUPER_ADMIN-only field', () => {
  let superAdminToken: string;
  let arcaaiAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super_admin login failed').toBeTruthy();
    superAdminToken = superAdmin!.token;

    const arcaaiAdmin = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEEDED_USERS.admin.password, ARCAAI_TENANT_KEY);
    expect(arcaaiAdmin, 'arcaai_admin login failed').toBeTruthy();
    arcaaiAdminToken = arcaaiAdmin!.token;
  });

  test('a tenant admin cannot raise its OWN tenant plan (403)', async ({ request }) => {
    const { row, etag } = await readTenant(request, arcaaiAdminToken, ARCAAI_TENANT_ID);
    const target = row.plan === 'ENTERPRISE' ? 'STARTER' : 'ENTERPRISE';

    const response = await request.patch(`/api/v1/admin/tenants/${ARCAAI_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${arcaaiAdminToken}`, 'If-Match': etag },
      data: { plan: target },
    });

    expect(response.status(), 'a tenant admin must not set its own plan').toBe(403);

    // And the row is untouched.
    const after = await readTenant(request, arcaaiAdminToken, ARCAAI_TENANT_ID);
    expect(after.row.plan).toBe(row.plan);
    expect(after.row.version).toBe(row.version);
  });

  test('a tenant admin may still PATCH a non-plan field on its own tenant', async ({ request }) => {
    const { row, etag } = await readTenant(request, arcaaiAdminToken, ARCAAI_TENANT_ID);
    const original = row.name;

    const response = await request.patch(`/api/v1/admin/tenants/${ARCAAI_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${arcaaiAdminToken}`, 'If-Match': etag },
      data: { name: `${original} ` },
    });

    try {
      expect(response.status(), 'a non-plan PATCH stays available to the tenant admin').toBe(200);
    } finally {
      const restore = await readTenant(request, arcaaiAdminToken, ARCAAI_TENANT_ID);
      await request.patch(`/api/v1/admin/tenants/${ARCAAI_TENANT_ID}`, {
        headers: { Authorization: `Bearer ${arcaaiAdminToken}`, 'If-Match': restore.etag },
        data: { name: original },
      });
    }
  });

  test('a super admin CAN set the plan, and the change lands', async ({ request }) => {
    const { row, etag } = await readTenant(request, superAdminToken, ARCAAI_TENANT_ID);
    const original = row.plan;
    const target = original === 'PRO' ? 'ENTERPRISE' : 'PRO';

    try {
      const response = await request.patch(`/api/v1/admin/tenants/${ARCAAI_TENANT_ID}`, {
        headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': etag },
        data: { plan: target },
      });

      expect(response.status(), 'a super admin may set the plan').toBe(200);
      expect(((await response.json()) as TenantRow).plan).toBe(target);
    } finally {
      // Restore the seeded plan so the rest of the suite sees the row it expects.
      const current = await readTenant(request, superAdminToken, ARCAAI_TENANT_ID);
      if (current.row.plan !== original && original) {
        await request.patch(`/api/v1/admin/tenants/${ARCAAI_TENANT_ID}`, {
          headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': current.etag },
          data: { plan: original },
        });
      }
    }
  });

  test('EXISTENCE first: an unknown id with a `plan` body is 404, never a 403 oracle', async ({ request }) => {
    const unknownId = '01920000-0000-7000-8000-0000000009ff';

    const response = await request.patch(`/api/v1/admin/tenants/${unknownId}`, {
      headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': '"1"' },
      data: { plan: 'ENTERPRISE' },
    });

    expect(response.status(), 'privilege must never leak which tenant ids exist').toBe(404);
  });

  test("a tenant admin still cannot see ANOTHER tenant's row (404-over-403 is unchanged)", async ({ request }) => {
    const response = await request.get(`/api/v1/admin/tenants/${GLOBAL_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${arcaaiAdminToken}` },
    });

    expect([403, 404], 'cross-tenant reads keep the house posture').toContain(response.status());
  });
});

test.describe('TASK-986 — the Global tenant is reserved for its own admins too', () => {
  test('a tenant admin of __GLOBAL__ cannot PATCH it', async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant_admin login failed').toBeTruthy();

    const { etag } = await readTenant(request, admin!.token, GLOBAL_TENANT_ID);

    const response = await request.patch(`/api/v1/admin/tenants/${GLOBAL_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${admin!.token}`, 'If-Match': etag },
      data: { description: 'edited by its own admin' },
    });

    expect(response.status(), 'the Global playground row is write-locked for everyone').toBe(403);
  });
});
