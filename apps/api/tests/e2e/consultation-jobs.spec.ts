/**
 * ConsultationJobController E2E.
 *
 * Tests for the three routes exposed by `ConsultationJobController`:
 *   GET   /api/v1/consultations/jobs/:jobId
 *   PATCH /api/v1/consultations/jobs/:jobId/cancel
 *   GET   /api/v1/consultations/jobs/:jobId/stream  (SSE)
 *
 * Requires a live API + Redis + BullMQ workers running locally (see the
 * existing tests in `tests/e2e/auth.spec.ts` for the bootstrap pattern).
 * Vitest excludes `tests/e2e/**`; this spec is wired into the Playwright
 * runner described in `tests/setup/integration.setup.ts`.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS } from '../../../../tests/helpers';

async function login(request: any) {
  const response = await request.post('/api/v1/auth/login', {
    data: {
      username: SEEDED_USERS.admin.username,
      password: SEEDED_USERS.admin.password,
      tenantKey: '__GLOBAL__',
    },
  });
  expect(response.status(), 'login failed').toBe(200);
  return (await response.json()).token as string;
}

test.describe('ConsultationJobController', () => {
  test.describe('GET /consultations/jobs/:jobId', () => {
    test('returns 401 without authentication', async ({ request }) => {
      const response = await request.get('/api/v1/consultations/jobs/missing-id');
      expect(response.status()).toBe(401);
    });

    test('returns 404 for an unknown job id', async ({ request }) => {
      const token = await login(request);
      const response = await request.get('/api/v1/consultations/jobs/does-not-exist', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status()).toBe(404);
    });
  });

  test.describe('PATCH /consultations/jobs/:jobId/cancel', () => {
    test('returns 401 without authentication', async ({ request }) => {
      const response = await request.patch('/api/v1/consultations/jobs/missing-id/cancel');
      expect(response.status()).toBe(401);
    });

    test('returns 404 when service refuses to cancel an unknown job', async ({ request }) => {
      const token = await login(request);
      const response = await request.patch('/api/v1/consultations/jobs/does-not-exist/cancel', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status()).toBe(404);
    });
  });

  test.describe('GET /consultations/jobs/:jobId/stream', () => {
    test('returns 401 without authentication or ticket', async ({ request }) => {
      const response = await request.get('/api/v1/consultations/jobs/missing-id/stream');
      expect(response.status()).toBe(401);
    });

    test('accepts a single-use ticket issued by POST /auth/stream-ticket', async ({ request }) => {
      const token = await login(request);

      const ticketResponse = await request.post('/api/v1/auth/stream-ticket', {
        headers: { Authorization: `Bearer ${token}` },
        data: { scope: 'consultation_job:some-job-id' },
      });
      expect(ticketResponse.status()).toBe(200);
      const { ticket, expiresAt, scope } = await ticketResponse.json();
      expect(typeof ticket).toBe('string');
      expect(typeof expiresAt).toBe('number');
      expect(scope).toBe('consultation_job:some-job-id');

      // Using the ticket should NOT return 401 (it may still return a real SSE
      // stream that immediately completes if the job doesn't exist, but
      // crucially it must not be rejected by the auth guard).
      const sseResponse = await request.get(`/api/v1/consultations/jobs/some-job-id/stream?ticket=${encodeURIComponent(ticket)}`);
      expect(sseResponse.status()).not.toBe(401);
    });

    test('rejects a ticket whose scope does not match the requested job', async ({ request }) => {
      const token = await login(request);

      const ticketResponse = await request.post('/api/v1/auth/stream-ticket', {
        headers: { Authorization: `Bearer ${token}` },
        data: { scope: 'consultation_job:wrong-id' },
      });
      const { ticket } = await ticketResponse.json();

      const sseResponse = await request.get(`/api/v1/consultations/jobs/some-other-id/stream?ticket=${encodeURIComponent(ticket)}`);
      expect(sseResponse.status()).toBe(401);
    });
  });
});
