/**
 * TASK-776 — NEGATIVE credential tests.
 *
 * Every rejected credential shape, one per credential class, asserted to be
 * **401 (authentication)** and never 403 (authorization) or 200. A credential
 * that is revoked, expired, malformed, forged or absent has no principal at
 * all, so it can never reach the authorization stage — a 403 here would mean
 * the guard authenticated something it should not have.
 *
 * Companion to task-776-credential-classes.spec.ts (positive semantics).
 * Fixtures verified live before this file was written.
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';
import { SEEDED_API_KEY, SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

/** Seeded fixture keys (00-constants.ts / 02-apikey.ts, dev+test gated). */
const REVOKED_KEY = 'hope_sk_test_f1h2j01c09h9982kgi2hj2iij4_186793'; // keyStatus REVOKED
/** Same length/shape as a real secret, so the exchange fails on the VALUE, not on DTO validation. */
const WRONG_SECRET = 'hope_svcsec_test_0000000000000000000000000000000000000000000000000000000000000000';

const EXPIRED_KEY = 'hope_sk_test_i4k5m34f32k2215njl5km5llm7_419026'; // keyStatus EXPIRED

/** Business-plane probe: a valid key reaches it (200), so any 401 is the credential. */
const PROBE = '/api/v1/consultations/90000000-0000-0000-0000-000000000001';

/** base64url without padding — JWT segment encoding. */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * A structurally perfect HS256 JWT for a real seeded super admin, signed with a
 * secret the gateway does not hold. Proves the guard verifies the SIGNATURE and
 * not merely the claim set — the one forgery that would be catastrophic.
 */
function forgedJwt(secret: string): string {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    id: SEEDED_USERS.superAdmin.id,
    username: SEEDED_USERS.superAdmin.username,
    email: SEEDED_USERS.superAdmin.email,
    roles: ['SUPER_ADMIN'],
    iat: now,
    exp: now + 3600,
  });
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

test.describe('TASK-776 — negative credentials are 401, never 403', () => {
  test('sanity: the probe route IS reachable with a good credential', async ({ request }) => {
    const res = await request.get(PROBE, { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(res.status()).toBe(200);
  });

  test.describe('API key', () => {
    test('revoked key => 401', async ({ request }) => {
      const res = await request.get(PROBE, { headers: { 'X-API-Key': REVOKED_KEY } });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('API key is revoked');
    });

    test('expired key => 401', async ({ request }) => {
      const res = await request.get(PROBE, { headers: { 'X-API-Key': EXPIRED_KEY } });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('API key is expired');
    });

    test('malformed key => 401', async ({ request }) => {
      const res = await request.get(PROBE, { headers: { 'X-API-Key': 'not-a-real-key' } });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('Invalid API key');
    });

    test('well-formed but unregistered key => 401 (same message — no enumeration oracle)', async ({ request }) => {
      const res = await request.get(PROBE, {
        headers: { 'X-API-Key': 'hope_sk_test_zzzzzzzzzzzzzzzzzzzzzz_000000' },
      });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('Invalid API key');
    });

    test('empty header value falls through to "no credential" => 401', async ({ request }) => {
      const res = await request.get(PROBE, { headers: { 'X-API-Key': '' } });
      expect(res.status()).toBe(401);
    });
  });

  test.describe('service-account token', () => {
    test('garbage token => 401', async ({ request }) => {
      const res = await request.get('/api/v1/admin/users', {
        headers: { 'X-Service-Account-Token': 'garbage-token' },
      });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('Invalid or expired service-account token');
    });

    test('a REVOKED-shaped (never-issued) opaque token => 401', async ({ request }) => {
      const res = await request.get('/api/v1/admin/users', {
        headers: { 'X-Service-Account-Token': '5iC0C9EVc2oRVTLfuFCSso4gn8S-0000000000000000000' },
      });
      expect(res.status()).toBe(401);
    });

    test('bad client secret is refused at EXCHANGE => never issues a token', async ({ request }) => {
      const res = await request.post('/api/v1/auth/service-token', {
        data: { clientId: 'hope_svc_a4ca1a11ad3141b0c0de0001', clientSecret: WRONG_SECRET },
      });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('Invalid client credentials');
      expect(await res.text()).not.toContain('accessToken');
    });

    test('unknown clientId is refused at EXCHANGE with the SAME message (no account oracle)', async ({ request }) => {
      const res = await request.post('/api/v1/auth/service-token', {
        data: { clientId: 'hope_svc_000000000000000000000000', clientSecret: WRONG_SECRET },
      });
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toBe('Invalid client credentials');
    });

    test('a too-short secret dies in DTO validation (400) before any credential lookup', async ({ request }) => {
      const res = await request.post('/api/v1/auth/service-token', {
        data: { clientId: 'hope_svc_a4ca1a11ad3141b0c0de0001', clientSecret: 'short' },
      });
      expect(res.status()).toBe(400);
    });
  });

  test.describe('JWT', () => {
    test('garbage bearer => 401', async ({ request }) => {
      const res = await request.get(PROBE, { headers: { Authorization: 'Bearer not.a.jwt' } });
      expect(res.status()).toBe(401);
    });

    test('JWT signed with the WRONG secret => 401 (signature is verified)', async ({ request }) => {
      const res = await request.get(PROBE, { headers: { Authorization: `Bearer ${forgedJwt('wrong-secret-not-the-gateways')}` } });
      expect(res.status()).toBe(401);
    });

    test('a second forgery with a different wrong secret is refused identically', async ({ request }) => {
      const res = await request.get('/api/v1/admin/users', {
        headers: { Authorization: `Bearer ${forgedJwt('another-wrong-secret-0123456789')}` },
      });
      expect(res.status()).toBe(401);
    });

    test('valid JWT still works — the forgeries above fail on the SIGNATURE, not the claims', async ({ request }) => {
      const su = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
      expect(su).not.toBeNull();
      const res = await request.get('/api/v1/admin/users', { headers: { Authorization: `Bearer ${su!.token}` } });
      expect(res.status()).toBe(200);
    });
  });

  test.describe('no credential at all', () => {
    test('deny by default on a business-plane route', async ({ request }) => {
      const res = await request.get(PROBE);
      expect(res.status()).toBe(401);
      expect((await res.json()).message).toContain('Authentication required');
    });

    test('deny by default on an admin-plane route', async ({ request }) => {
      const res = await request.get('/api/v1/admin/users');
      expect(res.status()).toBe(401);
    });

    test('an unauthenticated tenant-scoped read is 401, not 404 — authentication precedes tenancy', async ({ request }) => {
      const res = await request.get('/api/v1/consultations/90000000-0000-0000-0001-000000000001');
      expect(res.status()).toBe(401);
    });
  });

  test.describe('sanity: a good JWT on a tenant-scoped route still behaves', () => {
    test('doctor JWT reaches its own consultation', async ({ request }) => {
      const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
      expect(doctor).not.toBeNull();
      const res = await request.get(PROBE, { headers: { Authorization: `Bearer ${doctor!.token}` } });
      expect(res.status()).toBe(200);
    });
  });
});
