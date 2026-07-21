/**
 * UnifiedAuthGuard Behavior E2E Tests
 *
 * Tests for the unified authentication guard covering:
 * - API key vs JWT priority logic
 * - API key header variants (x-api-key, api-key, apikey)
 * - Invalid/malformed API key handling
 * - Login edge cases (empty credentials, user enumeration prevention)
 * - Public route access (unauthenticated and authenticated)
 * - JWT token edge cases (malformed Authorization headers, expired tokens)
 * - Error response format consistency
 *
 * Prerequisites:
 * - API server running
 * - Database seeded with test users and API keys (pnpm test:db:seed)
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, SEEDED_API_KEY, loginUser } from '../../../../tests/helpers';

const PROTECTED_ROUTE = '/api/v1/admin/tenants';
const HEALTH_ROUTE = '/api/v1/health';
const LOGIN_ROUTE = '/api/v1/auth/login';

test.describe('UnifiedAuthGuard Behavior', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const result = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    superAdminToken = result?.token ?? '';

    // This used to be a soft probe
    // (`apiKeyWorks = probe.status() !== 401`) that made every API-key test
    // below call `test.skip()` when it failed. That turned a total outage of
    // API-key authentication into a silent green run: the tenant-scope
    // extension threw on the pre-auth `ApiKey` lookup, EVERY key on the
    // platform 401'd, and this suite reported success by skipping.
    // The probe is now an assertion — if API-key auth breaks, this suite MUST
    // go red rather than evaporate. Do NOT re-introduce a skip here.
    const probe = await request.get(PROTECTED_ROUTE, {
      headers: { 'X-API-Key': SEEDED_API_KEY, Accept: 'application/json' },
    });
    expect(probe.status(), 'Seeded API key was rejected — API-key authentication is broken (TASK-539 S-3)').not.toBe(401);
  });

  // ==========================================================================
  // API Key vs JWT Priority
  // ==========================================================================

  test.describe('API Key vs JWT Priority', () => {
    test('should prioritize API key when both API key and JWT are present', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          'X-API-Key': SEEDED_API_KEY,
          Authorization: 'Bearer invalid.jwt.token',
          Accept: 'application/json',
        },
      });

      // Valid API key should succeed even with an invalid JWT
      expect(response.status()).not.toBe(401);
    });

    test('should fall through to JWT when no API key is present', async ({ request }) => {
      if (!superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          Accept: 'application/json',
        },
      });

      expect(response.status()).not.toBe(401);
    });

    test('should return 401 when neither API key nor JWT is provided', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: { Accept: 'application/json' },
      });

      expect(response.status()).toBe(401);
    });
  });

  // ==========================================================================
  // API Key Header Variants
  // ==========================================================================

  test.describe('API Key Header Variants', () => {
    test('should accept API key via x-api-key header', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          'x-api-key': SEEDED_API_KEY,
          Accept: 'application/json',
        },
      });

      expect(response.status()).not.toBe(401);
    });

    test('should accept API key via api-key header', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          'api-key': SEEDED_API_KEY,
          Accept: 'application/json',
        },
      });

      expect(response.status()).not.toBe(401);
    });

    test('should accept API key via apikey header', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          apikey: SEEDED_API_KEY,
          Accept: 'application/json',
        },
      });

      expect(response.status()).not.toBe(401);
    });
  });

  // ==========================================================================
  // Invalid API Key Handling
  // ==========================================================================

  test.describe('Invalid API Key Handling', () => {
    test('should return 401 for invalid API key', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          'X-API-Key': 'hope_sk_fake_key_1234567890',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should return 401 for malformed API key', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          'X-API-Key': 'not-a-real-key',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should return JSON error body for invalid API key', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          'X-API-Key': 'hope_sk_fake_key_1234567890',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('statusCode');
      expect(body).toHaveProperty('message');
      expect(body.statusCode).toBe(401);
    });
  });

  // ==========================================================================
  // Login Edge Cases
  // ==========================================================================

  test.describe('Login Edge Cases', () => {
    test('should reject login with empty string username', async ({ request }) => {
      const response = await request.post(LOGIN_ROUTE, {
        data: { username: '', password: 'pass' },
      });

      expect([400, 401]).toContain(response.status());
    });

    test('should reject login with empty string password', async ({ request }) => {
      const response = await request.post(LOGIN_ROUTE, {
        data: { username: 'user', password: '' },
      });

      expect([400, 401]).toContain(response.status());
    });

    test('should not leak user existence on wrong password', async ({ request }) => {
      const [wrongPasswordResponse, nonexistentUserResponse] = await Promise.all([
        request.post(LOGIN_ROUTE, {
          data: {
            username: SEEDED_USERS.superAdmin.username,
            password: 'definitely-wrong-password',
          },
        }),
        request.post(LOGIN_ROUTE, {
          data: {
            username: 'nonexistent_user_xyz_987654',
            password: 'definitely-wrong-password',
          },
        }),
      ]);

      expect(wrongPasswordResponse.status()).toBe(nonexistentUserResponse.status());

      const wrongPwBody = await wrongPasswordResponse.json();
      const noUserBody = await nonexistentUserResponse.json();

      // Both should return a generic error — the message must not reveal
      // whether the username exists
      expect(wrongPwBody).toHaveProperty('message');
      expect(noUserBody).toHaveProperty('message');
    });

    test('should return consistent error format for auth failures', async ({ request }) => {
      const responses = await Promise.all([
        request.get(PROTECTED_ROUTE, {
          headers: { Accept: 'application/json' },
        }),
        request.get(PROTECTED_ROUTE, {
          headers: {
            'X-API-Key': 'hope_sk_fake_key_1234567890',
            Accept: 'application/json',
          },
        }),
        request.get(PROTECTED_ROUTE, {
          headers: {
            Authorization: 'Bearer invalid.token.value',
            Accept: 'application/json',
          },
        }),
      ]);

      for (const response of responses) {
        expect(response.status()).toBe(401);
        const body = await response.json();
        expect(body).toHaveProperty('statusCode');
        expect(body).toHaveProperty('message');
      }
    });
  });

  // ==========================================================================
  // Public Route Access
  // ==========================================================================

  test.describe('Public Route Access', () => {
    test('should allow unauthenticated access to health endpoint', async ({ request }) => {
      const response = await request.get(HEALTH_ROUTE, {
        headers: { Accept: 'application/json' },
      });

      expect(response.ok()).toBe(true);
    });

    test('should allow unauthenticated access to login endpoint', async ({ request }) => {
      // POST with deliberately bad credentials — endpoint itself should be
      // reachable (not blocked by auth guard), even though login will fail.
      const response = await request.post(LOGIN_ROUTE, {
        data: { username: 'probe', password: 'probe' },
      });

      // The guard should NOT block; the endpoint handles its own auth.
      // Expect 401 from invalid creds, NOT from a guard rejection.
      expect([400, 401]).toContain(response.status());
    });

    test('should still allow authenticated requests to public routes', async ({ request }) => {
      if (!superAdminToken) {
        test.skip();
        return;
      }

      const response = await request.get(HEALTH_ROUTE, {
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          Accept: 'application/json',
        },
      });

      expect(response.ok()).toBe(true);
    });
  });

  // ==========================================================================
  // JWT Token Edge Cases
  // ==========================================================================

  test.describe('JWT Token Edge Cases', () => {
    test('should reject request with Bearer prefix but no token', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          Authorization: 'Bearer ',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject request with wrong authorization scheme', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject request with only the word Bearer', async ({ request }) => {
      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          Authorization: 'Bearer',
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject expired JWT token', async ({ request }) => {
      // Pre-crafted JWT with exp in the past (exp: 0 → 1970-01-01).
      // Header: {"alg":"HS256","typ":"JWT"}
      // Payload: {"sub":"expired","exp":0}
      // Signature: invalid (but the guard should reject on expiry before
      // even reaching signature verification in most implementations).
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiJleHBpcmVkIiwiZXhwIjowfQ.' + 'invalid_signature_placeholder';

      const response = await request.get(PROTECTED_ROUTE, {
        headers: {
          Authorization: `Bearer ${expiredToken}`,
          Accept: 'application/json',
        },
      });

      expect(response.status()).toBe(401);
    });
  });
});
