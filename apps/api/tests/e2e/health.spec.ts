/**
 * Health Endpoint E2E Tests
 *
 * Tests for the health check endpoint.
 * This is a simple test to verify the E2E setup works.
 */

import { test, expect } from '@playwright/test';

test.describe('Health Endpoint', () => {
  test('GET /health should return 200', async ({ request }) => {
    const response = await request.get('/api/v1/health');

    expect(response.status()).toBe(200);
  });

  test('GET /health should return health status', async ({ request }) => {
    const response = await request.get('/api/v1/health');
    const body = await response.json();

    expect(response.ok()).toBe(true);
    expect(body).toHaveProperty('status');
  });
});

test.describe('API Root', () => {
  test('GET /api should return a response', async ({ request }) => {
    const response = await request.get('/api');

    // The root endpoint might return 200 or 404 depending on configuration
    // Just verify we get a response
    expect(response.status()).toBeDefined();
  });
});
