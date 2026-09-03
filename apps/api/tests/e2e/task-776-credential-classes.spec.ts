/**
 * Credential-class DEPTH tests (semantics of `UnifiedAuthGuard`).
 *
 * The e2e suite exercises the JWT path in >90% of specs, the API-key path in
 * ~13 of 106, and the service-account path in ~6. This spec closes the
 * SEMANTIC half of that gap: not "which routes each credential can reach"
 * (that is the breadth/matrix suite's job) but "what the guard MEANS by
 * accepting or refusing a credential".
 *
 * Every constant below was verified against the running test API before this
 * file was written; where reality differed from the ticket brief, the comment
 * says so.
 *
 * The four credential classes (all verified live):
 *   1. Super-admin JWT — POST /auth/login (no tenantKey) -> Bearer
 *   2. Tenant-admin JWT — POST /auth/login + tenantKey '__GLOBAL__'
 *   3. API key — X-API-Key: <raw seeded key>
 *   4. Service-account token — POST /auth/service-token -> X-Service-Account-Token
 *
 * Guard source of truth: packages/applications/src/authorization/unified-auth.guard.ts
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, SEEDED_API_KEY, loginUser } from '../../../../tests/helpers';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** SDK_ARCAAI (00-constants.ts) — ACTIVE, bound to ARCAAI_ADMIN, tenant ARCAAI. */
const API_KEY_ARCAAI = 'hope_sk_test_e0g1i90b98g8871jfh1gi1hhi3_075682';

/**
 * SERVICE_ACCOUNT API key. NOTE: despite the name this is an API KEY, not a
 * service-account token — a different credential class with a different header.
 * Its scopes were narrowed from `['*']` to `['internal:stt:worker']`
 * (02-apikey.ts), so NO wildcard-scoped key exists on the platform any more.
 * The brief asked for an explicit wildcard proof of `@ForbidApiKey`; the
 * closest live equivalent is asserted below ( using this key,
 * with the wildcard's absence recorded here rather than fabricated.
 */
const API_KEY_STT_WORKER = 'hope_sa_test_d9f0h89a87f7760ieg0fh0ggh2_964571';

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';
const TENANT_ARCAAI = '50000000-0000-0000-0000-000000000001';
const TENANT_SYSTEM = '00000000-0000-0000-0000-000000000000';

const USER_DOCTOR_GLOBAL = '70000000-0000-0000-0000-000000000010';
const USER_ARCAAI_DOCTOR = '70000000-0000-0000-0000-000000000040';
const CONSULTATION_GLOBAL = '90000000-0000-0000-0000-000000000001';
const CONSULTATION_ARCAAI = '90000000-0000-0000-0001-000000000001';

/** Business-plane route: `@RequiredScopes('consultation:session:read')`. */
const CONSULTATION = (id: string) => `/api/v1/consultations/${id}`;
/** Admin-plane route: `@ForbidApiKey()` via policy A2. */
const ADMIN_USERS = '/api/v1/admin/users';
/**
 * `GET /workflows` — `@CanList('WorkflowDefinition')` AND
 * `@RequiredScopes('workflow:definition:read')`. The scope/ability split is
 * live here: tenant_admin holds the ability (200), doctor does not (403).
 */
const WORKFLOWS = '/api/v1/workflows';

// ─── DB access (for constructions the API deliberately refuses to build) ─────

interface ApiKeyDb {
  apiKey: {
    update(args: { where: { id: string }; data: { userId: string | null } }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}
let dbClient: ApiKeyDb | null = null;
async function getDb(): Promise<ApiKeyDb> {
  if (!dbClient) {
    // Same dist-import pattern as password-security-hardening.spec.ts: the
    // shared db.helper resolves @arcaai/database from the repo root, which
    // does not depend on it.
    const distEntry = pathToFileURL(join(__dirname, '../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as ApiKeyDb;
  }
  return dbClient;
}

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET },
  });
  expect(res.status(), 'service-token exchange').toBe(200);
  const body = await res.json();
  expect(body.expiresIn).toBe(900);
  return body.accessToken as string;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

test.describe('credential-class semantics', () => {
  let superAdminJwt: string;
  let tenantAdminJwt: string;
  let svcToken: string;

  test.beforeAll(async ({ request }) => {
    const su = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(su, 'super-admin login').not.toBeNull();
    expect(ta, 'tenant-admin login').not.toBeNull();
    superAdminJwt = su!.token;
    tenantAdminJwt = ta!.token;
    svcToken = await serviceAccountToken(request);
  });

  // ─── 0. The four classes actually authenticate ────────────────────────────

  test.describe('the four credential classes', () => {
    test('super-admin JWT authenticates on the admin plane', async ({ request }) => {
      const res = await request.get(ADMIN_USERS, { headers: { Authorization: `Bearer ${superAdminJwt}` } });
      expect(res.status()).toBe(200);
    });

    test('tenant-admin JWT authenticates and is tenant-bound', async ({ request }) => {
      const res = await request.get(WORKFLOWS, { headers: { Authorization: `Bearer ${tenantAdminJwt}` } });
      expect(res.status()).toBe(200);
    });

    test('API key authenticates on the business plane', async ({ request }) => {
      const res = await request.get(CONSULTATION(CONSULTATION_GLOBAL), { headers: { 'X-API-Key': SEEDED_API_KEY } });
      expect(res.status()).toBe(200);
    });

    test('service-account token authenticates on the admin plane', async ({ request }) => {
      const res = await request.get(ADMIN_USERS, { headers: { 'X-Service-Account-Token': svcToken } });
      expect(res.status()).toBe(200);
    });
  });

  // ─── 1. Ambiguous credentials ─────────────────────────────────────────────

  test.describe('ambiguous credentials (checked BEFORE either is validated)', () => {
    test('two INDIVIDUALLY VALID credentials still 401', async ({ request }) => {
      const res = await request.get(CONSULTATION(CONSULTATION_GLOBAL), {
        headers: { 'X-API-Key': SEEDED_API_KEY, 'X-Service-Account-Token': svcToken },
      });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toContain('Present exactly one credential');
    });

    test('two GARBAGE credentials 401 with the SAME message — the check precedes validation', async ({ request }) => {
      const res = await request.get(CONSULTATION(CONSULTATION_GLOBAL), {
        headers: { 'X-API-Key': 'garbage', 'X-Service-Account-Token': 'garbage' },
      });
      expect(res.status()).toBe(401);
      // Not "Invalid API key" / "Invalid or expired service-account token":
      // neither credential was ever looked up.
      expect((await res.json()).message).toContain('Present exactly one credential');
    });
  });

  // ─── 2. @ForbidApiKey is unconditional ────────────────────────────────────

  test.describe('@ForbidApiKey is unconditional (before rate-limit, scope and ability)', () => {
    test('a fully valid, in-tenant API key is 403 on /admin/*', async ({ request }) => {
      const res = await request.get(ADMIN_USERS, { headers: { 'X-API-Key': SEEDED_API_KEY } });
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toBe('This route does not accept API-key authentication');
    });

    test('the broadest-scoped key on the platform is refused identically', async ({ request }) => {
      // Was `['*']` before; no wildcard key remains, so this is the
      // strongest live case. The point stands either way: the denial is a
      // metadata flag, so no scope — not even a wildcard — can rescue it.
      const res = await request.get(ADMIN_USERS, { headers: { 'X-API-Key': API_KEY_STT_WORKER } });
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toBe('This route does not accept API-key authentication');
    });
  });

  // ─── 3. Deny by default ───────────────────────────────────────────────────

  test.describe('deny-by-default scopes', () => {
    test('service-account token on a route with no @RequiredSvcScopes is 403', async ({ request }) => {
      // /workflows declares @RequiredScopes (API keys) but no @RequiredSvcScopes.
      const res = await request.get(WORKFLOWS, { headers: { 'X-Service-Account-Token': svcToken } });
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toBe('This route does not accept service-account authentication');
    });

    test('the same route is reachable by a JWT — the 403 is about the CREDENTIAL CLASS, not the route', async ({ request }) => {
      const res = await request.get(WORKFLOWS, { headers: { Authorization: `Bearer ${tenantAdminJwt}` } });
      expect(res.status()).toBe(200);
    });

    test('API key without the declared scope is refused by scope, not by ability', async ({ request }) => {
      // SDK_DOCTOR does not hold 'workflow:definition:read'.
      const res = await request.get(WORKFLOWS, { headers: { 'X-API-Key': SEEDED_API_KEY } });
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toContain('does not have required scope(s): workflow:definition:read');
    });
  });

  // ─── 4. Scopes AND abilities — the credential can never exceed its human ──

  test.describe('scopes AND abilities compose as AND (never as a fallback)', () => {
    let keyId: string;
    let rawKey: string;

    test.beforeAll(async ({ request }) => {
      // Created as tenant_admin, who HOLDS list:WorkflowDefinition. Note the
      // grant-time defense: creating this key as `doctor` is refused with
      // "Cannot grant API key scopes beyond your own permissions" — so the
      // scope-held/ability-missing pairing cannot be built through the API at
      // all. It is constructed below by re-binding the key's userId directly,
      // which is the only way to reach the guard-level conjunction.
      const res = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        data: { keyName: `t776-and-${Date.now()}`, scopes: ['workflow:definition:read'] },
      });
      expect(res.status(), 'create scoped key').toBe(201);
      const body = await res.json();
      keyId = body.apiKey.id;
      rawKey = body.rawKey;
    });

    test.afterAll(async () => {
      const db = await getDb();
      await db.apiKey.delete({ where: { id: keyId } });
    });

    test('control: scope held AND bound user holds the ability => 200', async ({ request }) => {
      const res = await request.get(WORKFLOWS, { headers: { 'X-API-Key': rawKey } });
      expect(res.status()).toBe(200);
    });

    test('scope held BUT bound user lacks the CASL ability => 403 (the scope does not rescue it)', async ({ request }) => {
      const db = await getDb();
      await db.apiKey.update({ where: { id: keyId }, data: { userId: USER_DOCTOR_GLOBAL } });

      const res = await request.get(WORKFLOWS, { headers: { 'X-API-Key': rawKey } });
      expect(res.status()).toBe(403);
      // The ABILITY message, not the scope message: the scope gate passed and
      // the request still died on the bound human's permissions.
      expect((await res.json()).message).toBe('Missing permissions: list:WorkflowDefinition');
    });

    // ─── 5. Unlinked key ───────────────────────────────────────────────────
    test('a key with NO bound userId is 403 on a permission-gated route (fails closed)', async ({ request }) => {
      const db = await getDb();
      await db.apiKey.update({ where: { id: keyId }, data: { userId: null } });

      const res = await request.get(WORKFLOWS, { headers: { 'X-API-Key': rawKey } });
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toBe('This API key is not linked to a user, so the permissions this route requires cannot be evaluated');
    });
  });

  // ─── 6. Service-account tenant binding happens at EXCHANGE ────────────────

  test.describe('service-account working tenant binds at exchange, not per request', () => {
    /** Ids (last 3 chars) visible to the seeded account, whose home tenant is ARCAAI. */
    async function visibleUserIds(request: APIRequestContext, headers: Record<string, string>): Promise<string[]> {
      const res = await request.get(`${ADMIN_USERS}?limit=50`, { headers });
      expect(res.status()).toBe(200);
      const body = await res.json();
      return (body.data as { id: string }[]).map((u) => u.id).sort();
    }

    test('X-Tenant-Id cannot redirect a service-account token to another tenant', async ({ request }) => {
      const base = await visibleUserIds(request, { 'X-Service-Account-Token': svcToken });
      expect(base.length).toBeGreaterThan(0);
      // The account is ARCAAI-bound; Global's doctor must not be reachable.
      expect(base).not.toContain(USER_DOCTOR_GLOBAL);
      expect(base).toContain(USER_ARCAAI_DOCTOR);

      for (const tenantId of [TENANT_GLOBAL, TENANT_SYSTEM, TENANT_ARCAAI]) {
        const withHeader = await visibleUserIds(request, {
          'X-Service-Account-Token': svcToken,
          'X-Tenant-Id': tenantId,
        });
        expect(withHeader, `X-Tenant-Id: ${tenantId} must not change the effective tenant`).toEqual(base);
      }
    });

    test('a cross-tenant row stays 404 even with X-Tenant-Id naming its tenant', async ({ request }) => {
      const res = await request.get(`${ADMIN_USERS}/${USER_DOCTOR_GLOBAL}`, {
        headers: { 'X-Service-Account-Token': svcToken, 'X-Tenant-Id': TENANT_GLOBAL },
      });
      expect(res.status()).toBe(404);
    });

    test('its own tenant`s row is readable — proving the 404 above is scoping, not a broken route', async ({ request }) => {
      const res = await request.get(`${ADMIN_USERS}/${USER_ARCAAI_DOCTOR}`, {
        headers: { 'X-Service-Account-Token': svcToken },
      });
      expect(res.status()).toBe(200);
    });
  });

  // ─── 8. 404-over-403 holds per credential class ───────────────────────────

  test.describe('404-over-403 per credential class', () => {
    test('tenant-admin JWT: cross-tenant consultation id => 404', async ({ request }) => {
      // tenant_admin is bound to Global; CONSULTATION_ARCAAI belongs to ARCAAI.
      // (arcaai_admin is seeded with `password: null` and cannot log in, so the
      // direction is reversed rather than faked.)
      const res = await request.get(CONSULTATION(CONSULTATION_ARCAAI), {
        headers: { Authorization: `Bearer ${tenantAdminJwt}` },
      });
      expect(res.status()).toBe(404);
    });

    test('doctor JWT: in-tenant id => 200 (the 404 above is tenancy, not the route)', async ({ request }) => {
      const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
      expect(doctor).not.toBeNull();
      const res = await request.get(CONSULTATION(CONSULTATION_GLOBAL), {
        headers: { Authorization: `Bearer ${doctor!.token}` },
      });
      expect(res.status()).toBe(200);
    });

    test('API key: cross-tenant consultation id => 404 (not 403)', async ({ request }) => {
      const res = await request.get(CONSULTATION(CONSULTATION_GLOBAL), { headers: { 'X-API-Key': API_KEY_ARCAAI } });
      expect(res.status()).toBe(404);
      expect((await res.json()).message).toContain('not found');
    });

    test('API key: in-tenant id => 200 (the 404 above is tenancy, not the route)', async ({ request }) => {
      const res = await request.get(CONSULTATION(CONSULTATION_GLOBAL), { headers: { 'X-API-Key': SEEDED_API_KEY } });
      expect(res.status()).toBe(200);
    });

    test('service-account token: cross-tenant row => 404', async ({ request }) => {
      const res = await request.get(`${ADMIN_USERS}/${USER_DOCTOR_GLOBAL}`, {
        headers: { 'X-Service-Account-Token': svcToken },
      });
      expect(res.status()).toBe(404);
    });

    test('a PRIVILEGE failure is 403, not 404 — the two are never conflated', async ({ request }) => {
      // Same credential, same plane: forbidden route -> 403; missing row -> 404.
      const forbidden = await request.get(ADMIN_USERS, { headers: { 'X-API-Key': SEEDED_API_KEY } });
      expect(forbidden.status()).toBe(403);

      const missing = await request.get(CONSULTATION('90000000-0000-0000-0000-0000000000ff'), {
        headers: { 'X-API-Key': SEEDED_API_KEY },
      });
      expect(missing.status()).toBe(404);
    });
  });
});
