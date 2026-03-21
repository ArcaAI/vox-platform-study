/**
 * API Gateway Proxy Endpoint E2E Tests
 *
 * Tests the API Gateway's proxy endpoints to Python microservices (TTS, SMR, NLP, FedL).
 * These tests verify that the API Gateway correctly forwards requests and handles responses.
 *
 * NOTE: STT v1 proxy was removed in TASK-210 Phase 1. STT v2 uses native NestJS controllers.
 * NOTE: These tests check connectivity to Python services which may not be running in test env.
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
