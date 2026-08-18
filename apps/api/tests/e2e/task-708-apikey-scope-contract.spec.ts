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
 *  4. "TASK-742 — fail closed" — the DEFAULT changed, not just one route.
 *     `enforceApiKeyScopes` used to return early and PERMIT when a route
 *     declared no `@RequiredScopes`, and CASL was never evaluated on the
 *     API-key path, so any key bearing any trivial scope reached every
 *     undeclared route with no authorization decision at all. It now denies.
 *     This half asserts the observable consequence on three surfaces the
 *     gateway conformance review named: `/audio/transcription-jobs` (20
 *     routes, 0 scopes), `/speech/*` (TTS), and an `@ForbidApiKey()` route
 *     (`/voice-profile` — re-pointed from `/tenant/me` by TASK-758, which
 *     converted that controller to policy A1's JWT + API key).
 *     Half 2's assertions are UNCHANGED by TASK-742 — `/admin/tenants` was
 *     already declared, so the new default never applied to it.
 *
 *  5. "Minting privilege ceiling" (TASK-756) — the other end of the same
 *     credential's life. Halves 1-4 all ask "what may this key REACH?";
 *     half 5 asks "who was allowed to MINT it?". `ApiKeyService` now refuses
 *     any scope whose implied CASL ability the CALLING principal does not
 *     itself hold, so a tenant admin — gated by the class-level
 *     `@CanManage('ApiKey')`, not by SUPER_ADMIN — can no longer issue a
 *     long-lived bearer credential carrying `admin:*` or the bare `'*'`.
 *     Consequence for the halves above: the three fixtures that need a
 *     privileged scope (`admin:tenant:write`, `'*'`) are now minted with the
 *     SUPER_ADMIN token instead of the tenant-admin one. Their assertions are
 *     unchanged — an API-key-authenticated caller is never treated as a super
 *     admin by the handlers (`UnifiedAuthGuard` publishes `{ id, tenantId }`
 *     with no `roles`), so a super-admin-minted key is still tenant-scoped at
 *     request time.
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
  // TASK-756 — the minting ceiling refuses a scope whose implied ability the
  // caller does not hold, so privileged fixtures (`admin:tenant:write`, `'*'`)
  // must be minted by a super admin. The tenant-admin token still mints every
  // ordinary tenant-plane scope this spec uses.
  let superAdminToken: string;
  const createdApiKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const [login, saLogin] = await Promise.all([
      loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    ]);
    expect(login?.token, 'tenant-admin login failed — cannot create scoped API keys').toBeTruthy();
    expect(saLogin?.token, 'super-admin login failed — cannot create privileged scoped API keys').toBeTruthy();
    adminToken = login!.token as string;
    superAdminToken = saLogin!.token as string;
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
      const key = await createScopedApiKey(request, superAdminToken, ['admin:tenant:write'], 'task-708-gap-admin-tenants-allowed');
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
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-708-gap-admin-tenants-wildcard');
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

  // ==========================================================================
  // Half 4 — TASK-742: the API-key path now FAILS CLOSED.
  //
  // Half 2 closed ONE route family by adding a scope to it. TASK-742 closed the
  // DEFAULT: a route that declares no `@RequiredScopes(...)` refuses API keys
  // outright, so "we forgot to scope it" no longer means "anyone with any key
  // may call it". The three surfaces below were all reachable, unauthorized, by
  // any key bearing any trivial scope before that change.
  //
  // Note what CANNOT be asserted here and why that is correct: there is no
  // longer any live route with no declaration to point an HTTP request at — the
  // boot audit `auditEveryApiKeyReachableRouteDeclaresScopes`
  // (`apps/api/src/bootstrap/api-key-surface-audit.ts`) refuses to start the
  // server while one exists. The runtime rule itself ("absent declaration ⇒
  // deny") is pinned in
  // `packages/applications/src/authorization/__tests__/unified-auth.guard.deny-by-default.test.ts`;
  // what this half proves is the OBSERVABLE consequence on the routes that
  // changed.
  // ==========================================================================

  test.describe('TASK-742 — surfaces that were unauthorized-reachable are now gated', () => {
    test('STT jobs (/audio/transcription-jobs, 20 routes, previously 0 scopes): an out-of-scope key is 403', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-742-stt-jobs-denied');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/audio/transcription-jobs', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): stt:transcription:write');
    });

    test('STT jobs: an stt:transcription:write-scoped key passes the gate', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['stt:transcription:write'], 'task-742-stt-jobs-allowed');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/audio/transcription-jobs', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      // Any non-403 proves the guard admitted it; the handler's own status is
      // not this spec's concern.
      expect(response.status()).not.toBe(403);
      expect(response.status()).not.toBe(401);
    });

    test('TTS (/speech/synthesize, previously 0 scopes): an STT-scoped key cannot synthesize speech', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['stt:transcription:write'], 'task-742-tts-denied');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/speech/synthesize', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
        data: { text: 'hello' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      // The whole point of giving TTS its own `tts:*` family rather than
      // reusing an `stt:*` scope: a transcription key is not a synthesis key.
      expect(body.message).toContain('API key does not have required scope(s): tts:speech:write');
    });

    // Re-pointed from `/tenant/me` to `/voice-profile` by TASK-758: policy A1
    // converted `MyTenantController` to `@RequiredScopes('tenant:profile:read')`,
    // so it is no longer an `@ForbidApiKey()` surface at all. `/voice-profile`
    // is a REASONED exemption (voice biometrics — a long-lived static
    // credential must never enrol or read a voice profile), named in
    // `BUSINESS_PLANE_KEY_FORBIDDEN` and policed at boot, so it will not move
    // again the way TASK-742's conservative default did.
    test('an @ForbidApiKey() surface (/voice-profile) refuses even the "*" wildcard key', async ({ request }) => {
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-742-forbid-wildcard');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/voice-profile', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('does not accept API-key authentication');
    });

    test('the same @ForbidApiKey() route is still reachable with a session JWT (the marker is API-key-specific)', async ({ request }) => {
      const response = await request.get('/api/v1/voice-profile', {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
      });

      expect(response.status()).toBe(200);
    });
  });

  // ==========================================================================
  // Half 5 — TASK-756: the MINTING privilege ceiling.
  //
  // Halves 1-4 gate what a key may REACH. This one gates who may ISSUE it.
  // `ValidScopesConstraint` only ever proved a requested scope was a REGISTRY
  // MEMBER; nothing proved the caller was entitled to grant it, so a tenant
  // admin could mint a long-lived bearer credential carrying `admin:*` or the
  // bare `'*'` — no MFA, no session expiry, no revocation-on-logout, and a
  // value that survives in CI logs and `.env` files. `ApiKeyService` now
  // refuses any scope whose implied CASL ability the CALLER does not hold.
  //
  // This does NOT weaken the request-time half: `enforceApiKeyAbilities` still
  // evaluates each route's CASL metadata against the key's bound user on every
  // request. The two are a conjunction.
  // ==========================================================================

  test.describe('TASK-756 — a tenant admin cannot mint a key above its own privilege', () => {
    test("a tenant admin minting 'admin:*' is refused with 403", async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { keyName: `task-756-admin-wildcard-${Date.now()}`, keyType: 'SDK', scopes: ['admin:*'] },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('beyond your own permissions');
    });

    test("a tenant admin minting the bare '*' is refused with 403", async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { keyName: `task-756-star-${Date.now()}`, keyType: 'SDK', scopes: ['*'] },
      });

      expect(response.status()).toBe(403);
    });

    test('the same tenant admin can still mint an ordinary tenant-plane scope (the ceiling does not over-block)', async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { keyName: `task-756-ordinary-${Date.now()}`, keyType: 'SDK', scopes: ['consultation:session:read'] },
      });

      expect(response.status()).toBe(201);
      const body = await response.json();
      createdApiKeyIds.push(body.apiKey.id);
    });

    test("a SUPER_ADMIN can still mint '*' (the platform-operator path is unchanged)", async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { keyName: `task-756-sa-star-${Date.now()}`, keyType: 'SDK', scopes: ['*'] },
      });

      expect(response.status()).toBe(201);
      const body = await response.json();
      createdApiKeyIds.push(body.apiKey.id);
    });

    test('a PATCH that WIDENS an existing key with admin:* is refused, while a rename is not', async ({ request }) => {
      const created = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { keyName: `task-756-widen-${Date.now()}`, keyType: 'SDK', scopes: ['consultation:session:read'] },
      });
      expect(created.status()).toBe(201);
      const createdBody = await created.json();
      createdApiKeyIds.push(createdBody.apiKey.id);

      const etag = created.headers()['etag'];

      const widen = await request.patch(`/api/v1/admin/api-keys/${createdBody.apiKey.id}`, {
        headers: { Authorization: `Bearer ${adminToken}`, ...(etag ? { 'If-Match': etag } : {}) },
        data: { scopes: ['consultation:session:read', 'admin:*'] },
      });
      expect(widen.status()).toBe(403);

      // A PATCH that never touches `scopes` is not ceiling-checked at all.
      const rename = await request.patch(`/api/v1/admin/api-keys/${createdBody.apiKey.id}`, {
        headers: { Authorization: `Bearer ${adminToken}`, ...(etag ? { 'If-Match': etag } : {}) },
        data: { keyName: `task-756-renamed-${Date.now()}` },
      });
      expect(rename.status()).toBe(200);
    });
  });
});
