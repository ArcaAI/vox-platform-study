/**
 * TASK-758 — policy A1 (business plane = JWT + API key) as an HTTP contract.
 *
 * 13 controllers that carried TASK-742's conservative `@ForbidApiKey()`
 * default — the classification those `API-KEY-NOTE` blocks explicitly deferred
 * to an owner ruling — now declare a real scope. This spec asserts the three
 * things a decorator swap could plausibly get wrong:
 *
 *  1. **Reach.** A key HOLDING the new scope gets past the guard. Proven by a
 *     non-403 downstream status, never by a 200: the handler's own outcome is
 *     not this spec's concern, only that `enforceApiKeyScopes` admitted it.
 *  2. **No blanket grant.** A key WITHOUT the scope still gets the exact
 *     `enforceApiKeyScopes` 403 message shape. Conversion widened WHICH
 *     credential class may reach the route, not WHAT any key may do.
 *  3. **The `me` decision, proven rather than asserted.** A key bound to user
 *     A reading `/users/me/settings` gets A's rows; an unbound SERVICE_ACCOUNT
 *     key is refused outright by `enforceApiKeyAbilities`.
 *
 * Plus the exemption list's own contract: the three reasoned exemptions still
 * 403 an API key while remaining reachable with a session JWT.
 *
 * Prerequisites: API server running against the test DB
 * (`pnpm test:up:api`), seeded (`pnpm test:db:seed`).
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, SEEDED_API_KEY_SERVICE_ACCOUNT, loginUser } from '../../../../tests/helpers';

interface CreatedApiKey {
  id: string;
  rawKey: string;
}

async function createScopedApiKey(request: APIRequestContext, token: string, scopes: string[], namePrefix: string): Promise<CreatedApiKey> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: { Authorization: `Bearer ${token}` },
    data: { keyName: `${namePrefix}-${Date.now()}`, keyType: 'SDK', scopes },
  });
  expect(response.status(), `API key creation failed for ${namePrefix}`).toBe(201);
  const body = await response.json();
  return { id: body.apiKey.id, rawKey: body.rawKey };
}

test.describe('TASK-758 — business-plane auth model (policy A1)', () => {
  let adminToken: string;
  let superAdminToken: string;
  const createdApiKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const [login, saLogin] = await Promise.all([
      loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    ]);
    expect(login?.token, 'tenant-admin login failed').toBeTruthy();
    expect(saLogin?.token, 'super-admin login failed').toBeTruthy();
    adminToken = login!.token as string;
    superAdminToken = saLogin!.token as string;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdApiKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } }).catch(() => {});
    }
  });

  // ==========================================================================
  // 1 — the converted surfaces are now reachable with the right scope
  // ==========================================================================

  const REACHABLE: Array<{ name: string; scope: string; path: string }> = [
    { name: 'MyTenantController (GET /tenants/me)', scope: 'tenant:profile:read', path: '/api/v1/tenants/me' },
    { name: 'MyBillingController (GET /tenants/me/invoices)', scope: 'tenant:account:read', path: '/api/v1/tenants/me/invoices' },
    { name: 'MyUsageController (GET /tenants/me/usage-summary)', scope: 'tenant:account:read', path: '/api/v1/tenants/me/usage-summary' },
    { name: 'MyEntitlementsController (GET /tenants/me/entitlements)', scope: 'tenant:account:read', path: '/api/v1/tenants/me/entitlements' },
    { name: 'ChangelogController (GET /changelog)', scope: 'platform:changelog:read', path: '/api/v1/changelog' },
    { name: 'AudioPipelinePublicController (GET /audio/pipelines)', scope: 'stt:model:read', path: '/api/v1/audio/pipelines' },
    { name: 'PromptTemplateController (GET /prompt-templates/available)', scope: 'prompt:template:read', path: '/api/v1/prompt-templates/available' },
    {
      name: 'MyTenantContextSchemaController (GET /tenants/me/context-schema)',
      scope: 'tenant:context-schema:read',
      path: '/api/v1/tenants/me/context-schema',
    },
    { name: 'UserSettingsController (GET /users/me/settings)', scope: 'user:settings:read', path: '/api/v1/users/me/settings' },
    { name: 'UserDepartmentsMeController (GET /users/me/departments)', scope: 'user:profile:read', path: '/api/v1/users/me/departments' },
  ];

  for (const { name, scope, path } of REACHABLE) {
    test(`${name} admits a key holding ${scope}`, async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, [scope], 'task-758-reach');
      createdApiKeyIds.push(key.id);

      const response = await request.get(path, { headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' } });

      // Before A1 this was a 403 carrying "does not accept API-key
      // authentication". Any non-403/401 proves the guard admitted it.
      expect(response.status()).not.toBe(403);
      expect(response.status()).not.toBe(401);
    });
  }

  // ==========================================================================
  // 2 — the conversion is not a blanket grant
  // ==========================================================================

  test('a key without the scope still gets the enforceApiKeyScopes 403 (GET /tenants/me)', async ({ request }) => {
    const key = await createScopedApiKey(request, adminToken, ['consultation:session:read'], 'task-758-noscope');
    createdApiKeyIds.push(key.id);

    const response = await request.get('/api/v1/tenants/me', { headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' } });

    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.message).toContain('API key does not have required scope(s): tenant:profile:read');
  });

  test('the read scope does not reach the write route — PATCH /tenants/me/config needs tenant:profile:write', async ({ request }) => {
    const key = await createScopedApiKey(request, adminToken, ['tenant:profile:read'], 'task-758-readonly');
    createdApiKeyIds.push(key.id);

    const response = await request.patch('/api/v1/tenants/me/config', {
      headers: { 'X-API-Key': key.rawKey, Accept: 'application/json', 'If-Match': '"1"' },
      data: { configs: [] },
    });

    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.message).toContain('API key does not have required scope(s): tenant:profile:write');
  });

  test('the read scope does not reach the write route — PATCH /users/me/settings needs user:settings:write', async ({ request }) => {
    const key = await createScopedApiKey(request, adminToken, ['user:settings:read'], 'task-758-settings-readonly');
    createdApiKeyIds.push(key.id);

    const response = await request.patch('/api/v1/users/me/settings/arcaai-sdk/task758Probe', {
      headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
      data: { value: 'probe' },
    });

    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.message).toContain('API key does not have required scope(s): user:settings:write');
  });

  // ==========================================================================
  // 3 — the `me` decision
  // ==========================================================================

  test("`me` resolves to the key's BOUND USER, not to a tenant-wide set", async ({ request }) => {
    const key = await createScopedApiKey(request, adminToken, ['user:settings:read'], 'task-758-me');
    createdApiKeyIds.push(key.id);

    const [viaKey, viaJwt] = await Promise.all([
      request.get('/api/v1/users/me/settings', { headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' } }),
      request.get('/api/v1/users/me/settings', { headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' } }),
    ]);

    expect(viaKey.status()).toBe(200);
    expect(viaJwt.status()).toBe(200);

    // The key is minted BY the admin and therefore bound TO the admin, so the
    // two views are the same user's rows. That equality is the proof: a
    // tenant-wide resolution would return other users' settings too.
    const keyRows = (await viaKey.json()) as Array<{ userId?: string }>;
    const jwtRows = (await viaJwt.json()) as Array<{ userId?: string }>;
    const owners = new Set(keyRows.map((r) => r.userId));
    expect(owners.size).toBeLessThanOrEqual(1);
    expect(keyRows.length).toBe(jwtRows.length);
  });

  test('an unbound SERVICE_ACCOUNT key cannot use a /users/me/* route (enforceApiKeyAbilities fails closed)', async ({ request }) => {
    const response = await request.get('/api/v1/users/me/departments', {
      headers: { 'X-API-Key': SEEDED_API_KEY_SERVICE_ACCOUNT, Accept: 'application/json' },
    });

    expect(response.status()).toBe(403);
  });

  // ==========================================================================
  // 4 — the exemption list keeps its gate
  // ==========================================================================

  const EXEMPT: Array<{ name: string; path: string }> = [
    { name: 'VoiceProfileController', path: '/api/v1/voice-profiles' },
    // `dna-writing-styles` has no root GET — probe a real route, or Nest 404s on an
    // unmatched path BEFORE any guard runs and the exemption is never exercised.
    { name: 'DnaWritingStyleController', path: '/api/v1/dna-writing-styles/settings' },
    { name: 'AuthController', path: '/api/v1/auth/me' },
  ];

  for (const { name, path } of EXEMPT) {
    test(`${name} still refuses even a "*" wildcard key`, async ({ request }) => {
      const key = await createScopedApiKey(request, superAdminToken, ['*'], 'task-758-exempt');
      createdApiKeyIds.push(key.id);

      const response = await request.get(path, { headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' } });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('does not accept API-key authentication');
    });

    test(`${name} is still reachable with a session JWT`, async ({ request }) => {
      const response = await request.get(path, { headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' } });

      expect(response.status()).not.toBe(403);
      expect(response.status()).not.toBe(401);
    });
  }

  // ==========================================================================
  // 5 — cross-tenant posture is unchanged by the conversion
  // ==========================================================================

  test('a key from tenant X reading a foreign invoice still gets 404, never 403', async ({ request }) => {
    const key = await createScopedApiKey(request, adminToken, ['tenant:account:read'], 'task-758-crosstenant');
    createdApiKeyIds.push(key.id);

    const response = await request.get('/api/v1/tenants/me/invoices/00000000-0000-0000-0000-000000000000', {
      headers: { 'X-API-Key': key.rawKey, Accept: 'application/json' },
    });

    expect(response.status()).toBe(404);
  });
});
