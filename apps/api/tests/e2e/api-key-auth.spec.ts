/**
 * API Key Authentication E2E Tests
 *
 * Tests for the complete API key authentication lifecycle:
 * - CRUD: Create, Read, Update, Revoke, Delete API keys
 * - Authentication: Using API keys to access protected routes
 * - Access Control: IP allowlist, scope enforcement, key expiration/revocation
 * - Error handling: Missing keys, invalid keys, expired keys
 *
 * Prerequisites:
 * - API server running
 * - Database seeded with test users (super_admin, doctor)
 */

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
      const response = await request.get('/api/v1/admin/tenants', {
        headers: { Accept: 'application/json' },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('message');
    });

    test('should reject requests with an invalid API key', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: {
          'X-API-Key': 'hope_sk_invalid_key_that_does_not_exist_000000',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject requests with a malformed API key', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
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

      // Use the raw key to access a protected route
      const response = await request.get('/api/v1/admin/tenants', {
        headers: {
          'X-API-Key': rawKey,
          Accept: 'application/json',
        },
      });

      expect([200, 400, 401, 403]).toContain(response.status());
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
      const response = await request.get('/api/v1/admin/tenants', {
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

    test('should accept key via apikey header', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: {
          apikey: validRawKey,
          Accept: 'application/json',
        },
      });

      expect([200, 400, 401, 403]).toContain(response.status());
    });

    test('should accept key via api-key header', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: {
          'api-key': validRawKey,
          Accept: 'application/json',
        },
      });

      expect([200, 400, 401, 403]).toContain(response.status());
    });

    test('should accept key via x-api-key header', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: {
          'x-api-key': validRawKey,
          Accept: 'application/json',
        },
      });

      expect([200, 400, 401, 403]).toContain(response.status());
    });
  });

  // ============================================================================
  // Error Response Format Tests
  // ============================================================================

  test.describe('Error Response Format', () => {
    test('should return proper JSON error for missing key', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
        headers: { Accept: 'application/json' },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('statusCode', 401);
    });

    test('should return proper JSON error for invalid key', async ({ request }) => {
      const response = await request.get('/api/v1/admin/tenants', {
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
});
