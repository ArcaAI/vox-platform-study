/**
 * TASK-708 — API-Key Scope Verification: contract tests.
 *
 * This spec has two halves, deliberately separated so the split in
 * `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md` §2/§7
 * is visible in the test file itself rather than only in prose:
 *
 *  1. "Real enforcement" — a sample of the 14 `SDK_DAY1_SCOPED_ROUTES`
 *     (`apps/api/src/bootstrap/api-key-scope-audit.ts`) that carry
 *     `@RequiredScopes(...)`. An API key WITHOUT the required scope must be
 *     rejected with the exact `enforceApiKeyScopes` 403 message shape
 *     (`packages/applications/src/authorization/unified-auth.guard.ts`);
 *     a key WITH the scope must pass the guard (proven by reaching a
 *     downstream 404 for a nonexistent resource, never the scope-denial 403).
 *
 *  2. "Gap closed" — `/admin/tenants` (`TenantController`), this ticket's own
 *     worked example. It used to have NO `@RequiredScopes(...)` at all (the
 *     original "decorative today" half of this spec, before Task 4 ran):
 *     an API key with no admin scope reached it regardless, returning 200
 *     scoped to the key's own tenant, because `enforceApiKeyScopes` no-ops
 *     when no `API_KEY_REQUIRED_SCOPES` metadata is present and CASL/RBAC is
 *     never evaluated on the API-key auth path at all (§2.4). Task 4 added
 *     `@RequiredScopes('admin:tenant:write')` to the class, so this now
 *     asserts the CLOSED behavior: an out-of-scope key is 403'd, an
 *     `admin:tenant:write`-scoped key still succeeds. This replaces the
 *     loose `[200, 400, 401, 403]` tolerance in `api-key-auth.spec.ts`.
 *
 *  3. "/internal/stt/*" (`SttInternalController`) — the SETTLED design
 *     (confirmed against the live tree at close-out; do not re-derive from
 *     an aspirational README draft): this controller is gated by the
 *     RESERVED `internal:stt:worker` `@RequiredScopes` scope, NOT a
 *     dedicated service-token guard — `/admin/*` and `/internal/*` were
 *     deliberately closed by two DIFFERENT mechanisms (owner decision,
 *     `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md`
 *     §6), but `/internal/stt/*` is the one documented, POLICED exception
 *     to "/internal/* is guard-only": the STT worker authenticates with an
 *     ordinary API key (BUG-013 — `apps/stt/src/stt/worker.py:209` sends its
 *     seeded SERVICE_ACCOUNT key's raw value as `X-Internal-Service-Key`,
 *     which `ApiKeyService.extractApiKeyFromRequest` accepts as an ordinary
 *     API-key header), so it cannot be pulled fully off the API-key surface
 *     the way `HarnessInternalController`/`EffectiveConfigController` are.
 *     `RESERVED_INTERNAL_SCOPE_CONTROLLERS` in
 *     `apps/api/src/bootstrap/api-key-scope-audit.ts` names this exemption
 *     and polices it (boot fails if the reserved scope is ever removed
 *     without also moving the controller to a guard). An ordinary tenant
 *     key without the reserved scope is 403'd; the seeded SERVICE_ACCOUNT
 *     key (and any platform `'*'`-wildcard key, by the same wildcard
 *     semantics proven in half 2) reaches the handler.
 *
 * Prerequisites: API server running against the test DB
 * (`pnpm test:up:api`), seeded (`pnpm test:db:seed`).
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_API_KEY_SERVICE_ACCOUNT, loginUser } from '../../../../tests/helpers';

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
  // Half 2 — "Gap closed": /admin/tenants, this ticket's own worked example
  // ==========================================================================

  test.describe('/admin/tenants (TenantController, admin:tenant:write): the Task 3/4 gap-closure worked example', () => {
    test("an API key with no admin scope is now 403'd (was 200 before Task 4)", async ({ request }) => {
      // `TenantController` now carries class-level `@RequiredScopes('admin:tenant:write')`
      // (TASK-708 Task 4). A key holding ONLY `consultation:report:write`
      // (nothing admin-shaped) is rejected by `enforceApiKeyScopes` before the
      // handler — and therefore before CASL/RBAC would even run on this path
      // (§2.4) — with the same message shape every other `@RequiredScopes`
      // route uses.
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-708-gap-admin-tenants-denied');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): admin:tenant:write');
    });

    test('an admin:tenant:write-scoped API key still succeeds', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['admin:tenant:write'], 'task-708-gap-admin-tenants-allowed');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      // Defense-in-depth data scoping (unaffected by this ticket, unchanged
      // behavior): the handler still restricts a non-super-admin caller to
      // their own tenant via the inline `isSuperAdmin(user)` check, so an
      // in-scope key still only sees one row, never the full cross-tenant
      // list — the scope gate and the tenant-scoping are independent controls.
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
    });

    test('the platform "*" wildcard scope still satisfies the new gate (no regression for platform-operator keys)', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['*'], 'task-708-gap-admin-tenants-wildcard');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(200);
    });
  });

  // ==========================================================================
  // Half 3 — "/internal/stt/* gated by the reserved `internal:stt:worker`
  // scope" (SttInternalController) — see the file-header doc comment for why
  // this is the settled design, not a dedicated service-token guard.
  // ==========================================================================

  test.describe('/internal/stt/* (SttInternalController): gated by the reserved internal:stt:worker scope', () => {
    test('an ordinary tenant SDK key (no internal:stt:worker, no wildcard) is 403 — cannot reach it at all', async ({ request }) => {
      // SEEDED_API_KEY is an ordinary DOCTOR-owned SDK key with no
      // `internal:*` scope — proves the gap-closure this ticket delivered:
      // before TASK-708, `x-internal-service-key` doubled as an ordinary
      // API-key header (`ApiKeyService.extractApiKeyFromRequest`), so ANY
      // active tenant key reached this controller. `@RequiredScopes('internal:stt:worker')`
      // now 403s it, exactly like every other scope-gated route in half 1.
      const response = await request.get('/api/v1/internal/stt/jobs/00000000-0000-0000-0000-000000000000/status', {
        headers: { 'X-API-Key': SEEDED_API_KEY, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): internal:stt:worker');
    });

    test("the seeded SERVICE_ACCOUNT key (the STT worker's own credential) reaches the handler (404 for a nonexistent job)", async ({ request }) => {
      // This is the actual credential `apps/stt/src/stt/worker.py:209` presents
      // (BUG-013 — the worker's own registered ACTIVE SERVICE_ACCOUNT ApiKey raw
      // value, sent as `X-Internal-Service-Key`, NOT the platform `API_GATEWAY_KEY`
      // secret — those are two different values; `API_GATEWAY_KEY` gates a
      // different guard, `InternalServiceTokenGuard`, on a different controller).
      // Its seeded scopes are `['*']`, which satisfies the reserved
      // `internal:stt:worker` scope via `ApiKeyService.hasScope`'s wildcard match —
      // the same wildcard semantics half 2 proves for `/admin/tenants`.
      const response = await request.get('/api/v1/internal/stt/jobs/00000000-0000-0000-0000-000000000000/status', {
        headers: { 'X-Internal-Service-Key': SEEDED_API_KEY_SERVICE_ACCOUNT, Accept: 'application/json' },
      });

      // Reaches the handler (a real, if 404, response) — proves the scope
      // gate admits the correct credential, not just that it rejects everything.
      expect(response.status()).toBe(404);
    });

    test('a wrong X-Internal-Service-Key value is rejected (401 — it is an ordinary API-key header, and the value is not a registered key)', async ({
      request,
    }) => {
      const response = await request.get('/api/v1/internal/stt/jobs/00000000-0000-0000-0000-000000000000/status', {
        headers: { 'X-Internal-Service-Key': 'definitely-not-a-registered-api-key', Accept: 'application/json' },
      });

      expect(response.status()).toBe(401);
    });
  });
});
