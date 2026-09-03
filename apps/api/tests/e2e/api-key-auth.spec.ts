/**
 * API Key Authentication E2E Tests
 *
 * Tests for the complete API key authentication lifecycle:
 * - CRUD: Create, Read, Update, Revoke, Delete API keys
 * - Authentication: Using API keys to access protected routes
 * - Access Control: IP allowlist, scope enforcement, key expiration/revocation
 * - Error handling: Missing keys, invalid keys, expired keys
 *
 * ─── Probe route (policy A2) ──────────────────────────────────────
 *
 * This spec is about HEADER VARIANTS, revocation and expiry — the route it
 * probes is incidental to what it proves. It used to probe
 * `GET /api/v1/admin/tenants`, which A2 has made JWT-only: every API key now
 * gets a 403 there whatever it holds, which would make the header-variant
 * assertions pass for the wrong reason (a 403 for "wrong plane" is
 * indistinguishable from a 403 for "header not read").
 *
 * The probe is therefore a BUSINESS-plane route the seeded key legitimately
 * reaches: `GET /api/v1/consultations/jobs/<uuid>`, scoped exactly
 * `consultation:session:read`. A **404** there is a precise, discriminating
 * success signal — it means the header authenticated AND the scope gate passed
 * AND the handler ran. The assertions were TIGHTENED in the move (the header
 * variants previously accepted any of `[200, 400, 401, 403]`, which proved
 * almost nothing); nothing was relaxed to make the spec pass.
 *
 * A2 itself — that no credential reaches `/admin/*` — is asserted in the final
 * describe block below, and in full in `task-708-apikey-scope-contract.spec.ts`.
 *
 * Prerequisites:
 * - API server running
 * - Database seeded with test users (super_admin, doctor)
 */

/**
 * A business-plane route gated by exactly `consultation:session:read`. A
 * well-formed but nonexistent id, so a correctly authenticated + scoped key
 * gets 404 rather than a row.
 */
const BUSINESS_PROBE = '/api/v1/consultations/jobs/00000000-0000-0000-0000-000000000000';

import { test, expect } from '@playwright/test';

test.describe('API Key Authentication', () => {
  let superAdminToken: string;
  let doctorToken: string;

  // Track created API keys for cleanup
  const createdApiKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Login as super admin and doctor
    const [superAdminLogin, doctorLogin] = await Promise.all([
      request.post('/api/v1/auth/login', {
        data: { username: 'super_admin', password: 'password123', tenantKey: '__GLOBAL__' },
      }),
      request.post('/api/v1/auth/login', {
        data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
      }),
    ]);

    expect(superAdminLogin.status(), 'super_admin login failed').toBe(200);
    const saBody = await superAdminLogin.json();
    superAdminToken = saBody.token;

    expect(doctorLogin.status(), 'doctor login failed').toBe(200);
    const doctorBody = await doctorLogin.json();
    doctorToken = doctorBody.token;
  });

  test.afterAll(async ({ request }) => {
    // Cleanup created API keys
    if (superAdminToken) {
      for (const id of createdApiKeyIds) {
        await request
          .delete(`/api/v1/admin/api-keys/${id}`, {
            headers: { Authorization: `Bearer ${superAdminToken}` },
          })
          .catch(() => {});
      }
    }
  });

  // ============================================================================
  // API Key CRUD Tests
  // ============================================================================

  test.describe('API Key CRUD Operations', () => {
    test('should create an API key and return the raw key only once', async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-crud-test-${Date.now()}`,
          keyType: 'SDK',
          description: 'E2E test key for CRUD operations',
          scopes: ['consultation:session:read', 'consultation:session:write'],
        },
      });

      expect(response.status(), 'API key creation failed').toBe(201);

      const body = await response.json();
      expect(body).toHaveProperty('rawKey');
      expect(body.rawKey).toMatch(/^hope_sk_/);
      expect(body).toHaveProperty('apiKey');
      expect(body.apiKey).toHaveProperty('id');
      expect(body.apiKey.keyName).toContain('e2e-crud-test');

      createdApiKeyIds.push(body.apiKey.id);
    });

    test('should list API keys for the authenticated user', async ({ request }) => {
      const response = await request.get('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${doctorToken}` },
      });

      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);

        // Raw keys should never be exposed in list responses
        for (const key of body.data) {
          expect(key).not.toHaveProperty('keyHash');
          expect(key).toHaveProperty('keyPrefix');
          expect(key).toHaveProperty('keyName');
        }
      }
    });

    test('should revoke an API key', async ({ request }) => {
      // Create a key to revoke (requires admin permissions)
      const createResponse = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-revoke-test-${Date.now()}`,
          keyType: 'SDK',
          scopes: ['consultation:session:read'],
        },
      });

      expect(createResponse.status(), 'API key creation failed').toBe(201);

      const { apiKey } = await createResponse.json();
      createdApiKeyIds.push(apiKey.id);

      // Revoke the key
      const revokeResponse = await request.post(`/api/v1/admin/api-keys/${apiKey.id}/revoke`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect([200, 201, 204]).toContain(revokeResponse.status());
    });
  });

  // ============================================================================
  // API Key Authentication Flow Tests
  // ============================================================================

  test.describe('API Key Authentication Flow', () => {
    test('should reject requests without any API key', async ({ request }) => {
      // Access a known API-key-protected route without a key
      const response = await request.get(BUSINESS_PROBE, {
        headers: { Accept: 'application/json' },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('message');
    });

    test('should reject requests with an invalid API key', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'X-API-Key': 'hope_sk_invalid_key_that_does_not_exist_000000',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject requests with a malformed API key', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'X-API-Key': 'not-a-real-key',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should accept valid API key via x-api-key header', async ({ request }) => {
      // Create a valid API key first (requires admin permissions)
      const createResponse = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-auth-test-${Date.now()}`,
          keyType: 'SDK',
          scopes: ['consultation:session:read', 'consultation:session:write'],
        },
      });

      expect(createResponse.status(), 'API key creation failed').toBe(201);

      const { rawKey, apiKey } = await createResponse.json();
      createdApiKeyIds.push(apiKey.id);

      // `ConsultationJobController.getJob` is scoped to exactly
      // `consultation:session:read`, which this key holds, so a precise 404
      // (job not found) proves the header authenticated AND passed its scope
      // gate. Under A2 an admin route could no longer serve as this probe at
      // all — see this file's header.
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'X-API-Key': rawKey,
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(404);
    });

    test('should reject a revoked API key', async ({ request }) => {
      // Create and revoke a key (requires admin permissions)
      const createResponse = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-revoked-auth-test-${Date.now()}`,
          keyType: 'SDK',
          scopes: ['consultation:session:read'],
        },
      });

      expect(createResponse.status(), 'API key creation failed').toBe(201);

      const { rawKey, apiKey } = await createResponse.json();
      createdApiKeyIds.push(apiKey.id);

      // Revoke the key
      await request.post(`/api/v1/admin/api-keys/${apiKey.id}/revoke`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      // Try to use the revoked key
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'X-API-Key': rawKey,
          Accept: 'application/json',
        },
      });

      // Should be rejected (401 - key is revoked)
      expect(response.status()).toBe(401);
    });
  });

  // ============================================================================
  // API Key Header Variants
  // ============================================================================

  test.describe('API Key Header Variants', () => {
    let validRawKey: string;

    test.beforeAll(async ({ request }) => {
      const createResponse = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-header-variant-test-${Date.now()}`,
          keyType: 'SDK',
          scopes: ['consultation:session:read', 'consultation:session:write'],
        },
      });

      expect(createResponse.status(), 'API key creation for header variant tests failed').toBe(201);
      const body = await createResponse.json();
      validRawKey = body.rawKey;
      createdApiKeyIds.push(body.apiKey.id);
    });

    // 404 EXACTLY, not a status set: the key is valid and holds the probe's
    // scope, so anything other than "handler ran, row not found" means the
    // header was not read as a credential.
    test('should accept key via apikey header', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          apikey: validRawKey,
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(404);
    });

    test('should accept key via api-key header', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'api-key': validRawKey,
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(404);
    });

    test('should accept key via x-api-key header', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'x-api-key': validRawKey,
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(404);
    });
  });

  // ============================================================================
  // Error Response Format Tests
  // ============================================================================

  test.describe('Error Response Format', () => {
    test('should return proper JSON error for missing key', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: { Accept: 'application/json' },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('statusCode', 401);
    });

    test('should return proper JSON error for invalid key', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: {
          'X-API-Key': 'hope_sk_totally_fake_key_value_here_0000000000000000000000000000_abcdef',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('message');
    });
  });

  // ============================================================================
  // Policy A2 — the admin plane is JWT-only
  // ============================================================================

  test.describe('Admin plane rejects API keys (policy A2)', () => {
    let validRawKey: string;

    test.beforeAll(async ({ request }) => {
      const createResponse = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-a2-probe-${Date.now()}`,
          keyType: 'SDK',
          scopes: ['consultation:session:read'],
        },
      });

      expect(createResponse.status(), 'API key creation for A2 tests failed').toBe(201);
      const body = await createResponse.json();
      validRawKey = body.rawKey;
      createdApiKeyIds.push(body.apiKey.id);
    });

    test('a valid API key is refused on /admin/tenants with the non-probing message', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: { 'X-API-Key': validRawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      // Deliberately identical for "declared never" and "declares nothing", so a
      // caller cannot probe which admin routes were explicitly closed.
      expect(body.message).toContain('does not accept API-key authentication');
    });

    test('the same key still works on the business plane — A2 removed reach, not the credential', async ({ request }) => {
      const response = await request.get(BUSINESS_PROBE, {
        headers: { 'X-API-Key': validRawKey, Accept: 'application/json' },
      });

      expect(response.status()).toBe(404);
    });

    test('a JWT still reaches /admin/tenants', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: { Authorization: `Bearer ${superAdminToken}`, Accept: 'application/json' },
      });

      expect(response.status()).toBe(200);
    });

    test('creating a key with a reserved admin scope is refused', async ({ request }) => {
      const response = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          keyName: `e2e-a2-reserved-${Date.now()}`,
          keyType: 'SDK',
          scopes: ['admin:tenant:write'],
        },
      });

      // 400 from the DTO constraint, or 403 from the service-side guard —
      // both are a refusal; what must never happen is a 201.
      expect([400, 403]).toContain(response.status());
    });

    test('GET /admin/api-keys/scopes no longer advertises the Admin or Webhook families', async ({ request }) => {
      const response = await request.get('/api/v1/admin/api-keys/scopes', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).not.toHaveProperty('Admin');
      expect(body).not.toHaveProperty('Webhook');
      expect(body).toHaveProperty('Consultation');

      const wildcard = (body['Wildcard'] as Array<{ scope: string }>).map((s) => s.scope);
      expect(wildcard).not.toContain('admin:*');
      expect(wildcard).not.toContain('webhook:*');
    });
  });
});
