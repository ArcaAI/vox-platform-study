/**
 * API-Key Scope Verification: contract tests.
 *
 * This spec has two halves, deliberately separated so the split in
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
 * 2. **Policy A2 ** — `/admin/*` is a **JWT-only** plane. This half
 *     has been REWRITTEN, and the direction of the assertion is now the
 * opposite of what left here.
 *
 *     History, because the inversion is not a mistake: `/admin/tenants`
 *     originally had NO `@RequiredScopes(...)` at all, so any key reached it
 *     (`enforceApiKeyScopes` no-opped when no metadata was present, and CASL
 * was never evaluated on the API-key path — Task 4 added
 *     `@RequiredScopes('admin:tenant:write')`, and this half asserted the
 *     resulting narrowing. A2 supersedes that on this plane: the residual risk
 * was never a privilege DELTA ( made scope+ability a conjunction,
 * added a minting ceiling) but a CREDENTIAL CLASS — a static,
 *     long-lived bearer secret with no MFA, no session expiry, no
 *     revocation-on-logout, no impersonation trail. Administration removes the
 *     class. So this half now asserts that NO credential reaches
 *     `/admin/tenants`, **including the bare `'*'` wildcard**, while a JWT
 *     still does; and half 2b asserts the reserved `admin:*`/`webhook:*`
 *     families can no longer be granted at all.
 *
 * This is a refinement of the owner ruling ("we cannot mix the
 *     `/admin/*` and `/internal/*` routes as they was design for different
 *     purposes"), not a reversal of it: no service token is introduced under
 *     `/admin/*`, and `/internal/*` (half 3) is untouched.
 *
 *  3. "/internal/stt/*" (`SttInternalController`) — the SETTLED design
 *     (confirmed against the live tree at close-out; do not re-derive from
 *     an aspirational README draft): this controller is gated by the
 *     RESERVED `internal:stt:worker` `@RequiredScopes` scope, NOT a
 *     dedicated service-token guard — `/admin/*` and `/internal/*` were
 *     deliberately closed by two DIFFERENT mechanisms (owner decision,
 * but `/internal/stt/*` is the one documented, POLICED exception
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
 * 4. " — fail closed" — the DEFAULT changed, not just one route.
 *     `enforceApiKeyScopes` used to return early and PERMIT when a route
 *     declared no `@RequiredScopes`, and CASL was never evaluated on the
 *     API-key path, so any key bearing any trivial scope reached every
 *     undeclared route with no authorization decision at all. It now denies.
 *     This half asserts the observable consequence on three surfaces the
 *     gateway conformance review named: `/audio/transcription-jobs` (20
 *     routes, 0 scopes), `/speech/*` (TTS), and an `@ForbidApiKey()` route
 * (`/voice-profile` — re-pointed from `/tenant/me`, which
 *     converted that controller to policy A1's JWT + API key).
 * Half 2's assertions are UNCHANGED — `/admin/tenants` was
 *     already declared, so the new default never applied to it.
 *
 * 5. "Minting privilege ceiling" — the other end of the same
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

test.describe('API-key scope contract (locks in current behavior)', () => {
  let adminToken: string;
  // the minting ceiling refuses a scope whose implied ability the
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
  // Half 2 — Policy A2: /admin/* is JWT-only. NO credential reaches
  // it, including the bare '*' wildcard.
  // ==========================================================================
  //
  // This block previously asserted the OPPOSITE — that an `admin:tenant:write`
  // key reached `/admin/tenants` and a `'*'` key did too. 's
  // scope narrowing has been superseded on this plane, not reversed: A2
  // narrows further along the same axis. The residual risk scope-narrowing
  // could not address is a CREDENTIAL-CLASS problem — a key is a long-lived
  // static bearer secret with no MFA, no session expiry, no
  // revocation-on-logout and no impersonation audit trail — so administration
  // removes the class rather than sizing it.
  //
  // The load-bearing mechanism: `enforceApiKeyNotForbidden` runs BEFORE
  // `enforceApiKeyScopes` in `UnifiedAuthGuard.handleApiKeyAuth`, so a
  // forbidden route has no scope that could rescue it. `'*'` is the case that
  // proves it — `@RequiredScopes` alone could never have denied it, because
  // `hasScope` grants the wildcard everything.

  test.describe('/admin/tenants (TenantController): policy A2 — JWT only', () => {
    test("an API key with no admin scope is 403'd", async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-757-admin-tenants-nonadmin');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      // NOT the scope message any more — the route refuses the credential
      // CLASS, and the message deliberately does not distinguish "declared
      // never" from "declares nothing" so a caller cannot probe the plane.
      expect(body.message).toContain('does not accept API-key authentication');
      expect(body.message).not.toContain('required scope');
    });

    test("the platform '*' wildcard key is ALSO 403'd — no scope can rescue a forbidden route", async ({ request }) => {
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-757-admin-tenants-wildcard');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('does not accept API-key authentication');
    });

    test('a tenant-admin JWT still reaches it — A2 removed a credential class, not the capability', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      // Unchanged, and independent of A2: the handler still restricts a
      // non-super-admin caller to their own tenant via its inline
      // `isSuperAdmin(user)` check.
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
    });

    test('WebhookController (admin/webhooks) is closed too — its gate was webhook:event:write, not an admin: scope', async ({ request }) => {
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-757-admin-webhooks-wildcard');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/admin/webhooks', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('does not accept API-key authentication');
    });
  });

  // ==========================================================================
  // Half 2b — the reserved families can no longer be GRANTED.
  // Scope-narrowing survives on the business plane; only the admin vocabulary
  // is withdrawn.
  // ==========================================================================

  test.describe('reserved scopes are refused at grant time', () => {
    for (const scope of ['admin:tenant:write', 'admin:*', 'webhook:event:write', 'webhook:*']) {
      test(`POST /admin/api-keys refuses to mint '${scope}'`, async ({ request }) => {
        const response = await request.post('/api/v1/admin/api-keys', {
          headers: { Authorization: `Bearer ${superAdminToken}` },
          data: { keyName: `task-757-reserved-${Date.now()}`, keyType: 'SDK', scopes: [scope] },
        });

        // 400 (DTO constraint) or 403 (service guard) — both refuse. A 201 is
        // the failure: it would issue a credential the platform always denies.
        expect([400, 403]).toContain(response.status());
      });
    }

    test("the bare '*' is still mintable by a super admin — it is the /internal/* SERVICE_ACCOUNT wildcard", async ({ request }) => {
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-757-star-still-mintable');
      createdApiKeyIds.push(key.id);
      expect(key.rawKey).toBeTruthy();
    });

    test('a business-plane scope is still mintable — A1  is unaffected', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:session:read'], 'task-757-business-still-mintable');
      createdApiKeyIds.push(key.id);
      expect(key.rawKey).toBeTruthy();
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
      // before, `x-internal-service-key` doubled as an ordinary
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
  // Half 4 —: the API-key path now FAILS CLOSED.
  //
  // Half 2 closed ONE route family by adding a scope to it. closed the
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

  test.describe('surfaces that were unauthorized-reachable are now gated', () => {
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

    // Re-pointed from `/tenant/me` to `/voice-profile` by: policy A1
    // converted `MyTenantController` to `@RequiredScopes('tenant:profile:read')`,
    // so it is no longer an `@ForbidApiKey()` surface at all. `/voice-profile`
    // is a REASONED exemption (voice biometrics — a long-lived static
    // credential must never enrol or read a voice profile), named in
    // `BUSINESS_PLANE_KEY_FORBIDDEN` and policed at boot, so it will not move
    // again the way conservative default did.
    test('an @ForbidApiKey() surface (/voice-profile) refuses even the "*" wildcard key', async ({ request }) => {
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-742-forbid-wildcard');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/voice-profiles', {
        headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('does not accept API-key authentication');
    });

    test('the same @ForbidApiKey() route is still reachable with a session JWT (the marker is API-key-specific)', async ({ request }) => {
      const response = await request.get('/api/v1/voice-profiles', {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
      });

      expect(response.status()).toBe(200);
    });
  });

  // ==========================================================================
  // Half 5 —: the MINTING privilege ceiling.
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

  test.describe('a tenant admin cannot mint a key above its own privilege', () => {
    /**
     * changed WHICH control refuses this, not WHETHER it is refused.
     * `admin:*` is now a RESERVED scope, and the DTO-level
     * `NoReservedScopesConstraint` runs in the validation pipe — i.e. BEFORE
     * `ApiKeyService.assertScopeCeiling` — so the refusal arrives as a 400
     * rather than the ceiling's 403. The ceiling itself is unchanged and is
     * still proven by the `'*'` case below, which A2 deliberately leaves
     * grantable (it is the `/internal/*` SERVICE_ACCOUNT wildcard).
     */
    test("a tenant admin minting 'admin:*' is refused (now by A2's reserved-scope rule, before the ceiling)", async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { keyName: `task-756-admin-wildcard-${Date.now()}`, keyType: 'SDK', scopes: ['admin:*'] },
      });

      expect([400, 403]).toContain(response.status());
      const body = await response.json();
      expect(JSON.stringify(body)).toMatch(/[Rr]eserved scope/);
    });

    test("a SUPER_ADMIN minting 'admin:*' is ALSO refused — A2 has no privilege escape hatch", async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: { keyName: `task-757-sa-admin-wildcard-${Date.now()}`, keyType: 'SDK', scopes: ['admin:*'] },
      });

      expect([400, 403]).toContain(response.status());
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

      // Refused by A2's widening-delta reserved-scope check since;
      // the ceiling would have refused it too. Either way, 403.
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
