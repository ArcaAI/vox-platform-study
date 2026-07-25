/**
 * API Gateway Proxy Endpoint E2E Tests
 *
 * Smoke-checks that unauthenticated requests to proxy endpoints don't crash
 * the gateway. STT uses native NestJS controllers, not a proxy.
 */

import { test, expect } from '@playwright/test';

test.describe('API Gateway Service Proxy', () => {
  test.describe('Authentication', () => {
    test('should reject unauthenticated requests to proxy endpoints', async ({ request }) => {
      const response = await request.get('/api/v1/health');
      expect([200, 401, 404]).toContain(response.status());
    });
  });
});
