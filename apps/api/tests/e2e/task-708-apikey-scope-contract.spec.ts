/**
 * TASK-708 — API-Key Scope Verification: contract tests locking in CURRENT
 * behavior.
 *
 * This spec has two halves, deliberately separated so the split in
 * `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md` §2 is
 * visible in the test file itself rather than only in prose:
 *
 *  1. "Real enforcement" — a sample of the 14 `SDK_DAY1_SCOPED_ROUTES`
 *     (`apps/api/src/bootstrap/api-key-scope-audit.ts`) that carry
 *     `@RequiredScopes(...)`. An API key WITHOUT the required scope must be
 *     rejected with the exact `enforceApiKeyScopes` 403 message shape
 *     (`packages/applications/src/authorization/unified-auth.guard.ts:233`);
 *     a key WITH the scope must pass the guard (proven by reaching a
 *     downstream 404 for a nonexistent resource, never the scope-denial 403).
 *
 *  2. "Decorative today" — routes with NO `@RequiredScopes(...)` at all
 *     (the entire `/admin/*` surface — §2.3 of the README). An API key
 *     reaches these regardless of its scopes, because
 *     `UnifiedAuthGuard.enforceApiKeyScopes` no-ops when no
 *     `API_KEY_REQUIRED_SCOPES` metadata is present, and CASL/RBAC is never
 *     evaluated on the API-key auth path at all (§2.4). This half asserts
 *     the CURRENT real status code, replacing the loose
 *     `[200, 400, 401, 403]` tolerance in `api-key-auth.spec.ts`.
 *
 *     A `403` on the "decorative today" test in the future is the INTENDED
 *     fix (TASK-708 Task 4 — gated on the Task 3 human decision), not a
 *     regression. Whoever closes that gap for a given route MUST update this
 *     spec alongside the fix — do not leave this permanently green as a
 *     stale "gap exists" assertion once the route is scoped.
 *
 * Prerequisites: API server running against the test DB
 * (`pnpm test:up:api`), seeded (`pnpm test:db:seed`).
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface CreatedApiKey {
  id: string;
  rawKey: string;
}

/** Creates an API key with exactly the given scopes, owned by the caller's own tenant. */
async function createScopedApiKey(request: APIRequestContext, token: string, scopes: string[], namePrefix: string): Promise<CreatedApiKey> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      keyName: `${namePrefix}-${Date.now()}`,
      keyType: 'SDK',
      scopes,
    },
  });
  expect(response.status(), `API key creation failed for ${namePrefix}`).toBe(201);
  const body = await response.json();
  return { id: body.apiKey.id, rawKey: body.rawKey };
}

test.describe('TASK-708 — API-key scope contract (locks in current behavior)', () => {
  let adminToken: string;
  const createdApiKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(login?.token, 'tenant-admin login failed — cannot create scoped API keys').toBeTruthy();
    adminToken = login!.token as string;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdApiKeyIds) {
      await request
        .delete(`/api/v1/admin/api-keys/${id}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
        .catch(() => {});
    }
  });

  // ==========================================================================
  // Half 1 — "Real enforcement": the 14 SDK_DAY1_SCOPED_ROUTES actually gate
  // ==========================================================================

  test.describe('real enforcement — @RequiredScopes routes reject an out-of-scope key and admit an in-scope one', () => {
    test('ConsultationController.generateSummary (consultation:report:write): out-of-scope key gets 403 with the exact message shape', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:session:read'], 'task-708-nosummary');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/consultations/00000000-0000-0000-0000-000000000000/summary', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
        data: {},
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): consultation:report:write');
    });

    test('ConsultationController.generateSummary (consultation:report:write): in-scope key passes the scope gate (reaches the 404 for a nonexistent consultation, not the scope 403)', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-708-summary');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/consultations/00000000-0000-0000-0000-000000000000/summary', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
        data: {},
      });

      expect(response.status()).toBe(404);
      const body = await response.json();
      expect(body.message).not.toContain('required scope');
    });

    test('ConsultationController.generateSummaryAsync (consultation:report:write): out-of-scope key gets 403 with the exact message shape', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:session:read'], 'task-708-noasync');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/consultations/00000000-0000-0000-0000-000000000000/summary/async', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
        data: {},
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): consultation:report:write');
    });

    test('ConsultationController.generateSummaryAsync (consultation:report:write): in-scope key passes the scope gate (reaches the 404, not the scope 403)', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-708-async');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/consultations/00000000-0000-0000-0000-000000000000/summary/async', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
        data: {},
      });

      expect(response.status()).toBe(404);
      const body = await response.json();
      expect(body.message).not.toContain('required scope');
    });

    test('ConsultationJobController.getJob (consultation:session:read): out-of-scope key gets 403 with the exact message shape', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-708-nojob');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/consultations/jobs/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): consultation:session:read');
    });

    test('ConsultationJobController.getJob (consultation:session:read): in-scope key passes the scope gate (reaches the 404 for a nonexistent job, not the scope 403)', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:session:read'], 'task-708-job');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/consultations/jobs/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(404);
      const body = await response.json();
      expect(body.message).not.toContain('required scope');
    });
  });

  // ==========================================================================
  // Half 2 — "Decorative today": routes with no @RequiredScopes at all
  // ==========================================================================

  test.describe('documents the current gap: routes with no @RequiredScopes are reachable by any valid API key', () => {
    test('documents the current gap: an API key with no admin scope reaches /admin/tenants', async ({ request }) => {
      // `TenantController` has NO `@RequiredScopes(...)` anywhere (§2.3 of the
      // README — the /admin/* surface is entirely outside the 14-route
      // SDK_DAY1_SCOPED_ROUTES list). `enforceApiKeyScopes` therefore no-ops
      // for this route, and CASL/RBAC (`@CanAny(['manage','Tenant'],['update','Tenant'])`)
      // is never evaluated on the API-key auth path (§2.4) — so a key holding
      // ONLY `consultation:report:write` (nothing admin-shaped) still reaches
      // the handler. The handler's own inline `isSuperAdmin(user)` check (not
      // a route-level authorization gate) then falls back to a same-tenant-only
      // view because the API-key CLS `user` object carries no `roles`
      // (`unified-auth.guard.ts` sets only `{ id, tenantId }`) — so the
      // response is 200 with exactly the key's own tenant, not a 403.
      //
      // A 403 here in the future is the intended fix (TASK-708 Task 4, gated
      // on the Task 3 human classification decision) — update this test
      // alongside that fix rather than leaving it green forever.
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-708-gap-admin-tenants');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      // Current, real behavior — not a guess. If this ever starts failing
      // because the route now 403s, that is TASK-708 Task 4 landing: update
      // this assertion (and the comment above) rather than treating it as a
      // regression.
      expect(response.status(), 'a route with no @RequiredScopes(...) is not authorization-gated for API keys today').toBe(200);

      const body = await response.json();
      // Defense-in-depth data scoping (not an authorization gate): the
      // handler restricts a non-super-admin caller to their own tenant, so
      // the out-of-scope key still only sees one row, never the full
      // cross-tenant list.
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
    });
  });
});
