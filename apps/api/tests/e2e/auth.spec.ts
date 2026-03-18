/**
 * Auth Controller E2E Tests
 *
 * Tests for authentication endpoints: login, logout, me
 *
 * TEST DATA MANAGEMENT:
 * - Uses seeded users (admin) for authentication tests
 * - Does NOT create any test data (pure authentication testing)
 * - No cleanup required
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS } from '../../../../tests/helpers';

test.describe('Auth Controller', () => {
  test.describe('POST /auth/login', () => {
    test('should return 400 when username is missing', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: {
          password: 'password123',
        },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.message).toBeDefined();
    });

    test('should return 400 when password is missing', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: {
          username: 'testuser',
        },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.message).toBeDefined();
    });

    test('should return 400 when both username and password are missing', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: {},
      });

      expect(response.status()).toBe(400);
    });

    test('should return 401 for invalid credentials', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: {
          username: 'nonexistent_user',
          password: 'wrong_password',
        },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body.message).toBeDefined();
    });

    test('should return 401 for wrong password', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: {
          username: 'tenant_admin',
          password: 'completely_wrong_password',
          tenantKey: '__GLOBAL__',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should return token and user info on successful login', async ({ request }) => {
      const response = await request.post('/api/v1/auth/login', {
        data: {
          username: SEEDED_USERS.admin.username,
          password: SEEDED_USERS.admin.password,
          tenantKey: '__GLOBAL__',
        },
      });

      expect(response.status(), 'tenant_admin login failed').toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('refreshToken');
      expect(body).toHaveProperty('user');
      expect(body.user).toHaveProperty('id');
      expect(body.user).toHaveProperty('username');
      expect(body.user).toHaveProperty('roles');
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);
    });
  });

  test.describe('POST /auth/logout', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.post('/api/v1/auth/logout');

      expect(response.status()).toBe(401);
    });

    test('should return 401 with invalid token', async ({ request }) => {
      const response = await request.post('/api/v1/auth/logout', {
        headers: {
          Authorization: 'Bearer invalid_token_here',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should return 401 with malformed authorization header', async ({ request }) => {
      const response = await request.post('/api/v1/auth/logout', {
        headers: {
          Authorization: 'InvalidFormat token123',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should successfully logout with valid token', async ({ request }) => {
      const loginResponse = await request.post('/api/v1/auth/login', {
        data: {
          username: SEEDED_USERS.admin.username,
          password: SEEDED_USERS.admin.password,
          tenantKey: '__GLOBAL__',
        },
      });

      expect(loginResponse.status(), 'tenant_admin login failed').toBe(200);
      const { token } = await loginResponse.json();

      const logoutResponse = await request.post('/api/v1/auth/logout', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      expect(logoutResponse.status()).toBe(200);
      const body = await logoutResponse.json();
      expect(body.success).toBe(true);
    });
  });

  test.describe('GET /auth/me', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.get('/api/v1/auth/me');

      expect(response.status()).toBe(401);
    });

    test('should return 401 with invalid token', async ({ request }) => {
      const response = await request.get('/api/v1/auth/me', {
        headers: {
          Authorization: 'Bearer invalid_token',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should return 401 with expired token', async ({ request }) => {
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3QtaWQiLCJleHAiOjE2MDAwMDAwMDB9.invalid';

      const response = await request.get('/api/v1/auth/me', {
        headers: {
          Authorization: `Bearer ${expiredToken}`,
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should return current user info with valid token', async ({ request }) => {
      const loginResponse = await request.post('/api/v1/auth/login', {
        data: {
          username: SEEDED_USERS.admin.username,
          password: SEEDED_USERS.admin.password,
          tenantKey: '__GLOBAL__',
        },
      });

      expect(loginResponse.status(), 'tenant_admin login failed').toBe(200);
      const { token, user: loginUser } = await loginResponse.json();

      const meResponse = await request.get('/api/v1/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      expect(meResponse.status()).toBe(200);
      const body = await meResponse.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('username');
      expect(body).toHaveProperty('roles');
      expect(body.id).toBe(loginUser.id);
      expect(body.username).toBe(loginUser.username);
    });
  });

  test.describe('Authentication Token Validation', () => {
    test('should reject token with invalid signature', async ({ request }) => {
      const invalidSignatureToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3QtaWQiLCJ1c2VybmFtZSI6InRlc3QifQ.INVALID_SIGNATURE';

      const response = await request.get('/api/v1/auth/me', {
        headers: {
          Authorization: `Bearer ${invalidSignatureToken}`,
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject completely malformed token', async ({ request }) => {
      const response = await request.get('/api/v1/auth/me', {
        headers: {
          Authorization: 'Bearer not.a.valid.jwt.token',
        },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject empty bearer token', async ({ request }) => {
      const response = await request.get('/api/v1/auth/me', {
        headers: {
          Authorization: 'Bearer ',
        },
      });

      expect(response.status()).toBe(401);
    });
  });
});
