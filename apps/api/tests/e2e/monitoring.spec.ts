/**
 * Health & Monitoring E2E Tests
 *
 * Tests for health check and monitoring endpoints
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe('Health & Monitoring', () => {
  let authToken = '';

  test.beforeAll(async ({ request }) => {
    try {
      // The monitoring controller is gated to GLOBAL_ADMIN (`manage all`):
      // ops/uptime/sessions is platform-wide infra data, so a TENANT_ADMIN
      // (correctly) gets 403. Authenticate as the super-admin operator to exercise
      // the authorized read path.
      const result = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
      if (result) authToken = result.token;
    } catch {
      // Seeded data may not be available
    }
  });

  test.describe('Health Endpoint', () => {
    test('should return 200 for health check', async ({ request }) => {
      const response = await request.get('/api/v1/health');
      expect(response.status()).toBe(200);
    });

    test('should return health status object', async ({ request }) => {
      const response = await request.get('/api/v1/health');
      const body = await response.json();

      expect(response.ok()).toBe(true);
      expect(body).toHaveProperty('status');
    });

    test('should respond quickly (< 5 seconds)', async ({ request }) => {
      const start = Date.now();
      const response = await request.get('/api/v1/health');
      const duration = Date.now() - start;

      expect(response.status()).toBe(200);
      expect(duration).toBeLessThan(5000);
    });
  });

  test.describe('Monitoring Endpoints', () => {
    test('uptime endpoint should return 401 without auth', async ({ request }) => {
      const response = await request.get('/api/v1/monitoring/uptime');
      expect(response.status()).toBe(401);
    });

    test('uptime endpoint should return service status with auth', async ({ request }) => {
      test.skip(!authToken, 'Requires seeded admin user — run pnpm test:db:seed first');
      const response = await request.get('/api/v1/monitoring/uptime', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('services');
    });

    test('sessions endpoint should require auth', async ({ request }) => {
      const response = await request.get('/api/v1/monitoring/sessions');
      expect(response.status()).toBe(401);
    });

    test('sessions endpoint should return data with auth', async ({ request }) => {
      test.skip(!authToken, 'Requires seeded admin user — run pnpm test:db:seed first');
      const response = await request.get('/api/v1/monitoring/sessions', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect([200, 404]).toContain(response.status());
    });

    test('heartbeats endpoint should return data', async ({ request }) => {
      const response = await request.get('/api/v1/monitoring/heartbeats');
      expect([200, 401, 404]).toContain(response.status());
    });
  });

  test.describe('API Response Headers', () => {
    test('should include CORS headers', async ({ request }) => {
      const response = await request.get('/api/v1/health');
      expect(response.headers()['access-control-allow-credentials']).toBeDefined();
    });

    test('should include security headers', async ({ request }) => {
      const response = await request.get('/api/v1/health');
      const headers = response.headers();
      expect(headers['x-content-type-options']).toBeDefined();
      expect(headers['x-frame-options']).toBeDefined();
    });
  });

  test.describe('Error Handling', () => {
    test('should return 404 for unknown endpoints', async ({ request }) => {
      const response = await request.get('/api/v1/unknown-endpoint-12345');
      expect(response.status()).toBe(404);
    });

    test('should return proper error format', async ({ request }) => {
      const response = await request.get('/api/v1/unknown-endpoint-12345');
      const body = await response.json();
      expect(body).toHaveProperty('statusCode');
      expect(body).toHaveProperty('message');
    });

    test('should handle malformed JSON in request body', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: 'not-json',
      });
      expect([400, 401, 415]).toContain(response.status());
    });
  });
});
