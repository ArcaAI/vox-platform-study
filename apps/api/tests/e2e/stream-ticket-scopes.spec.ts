/**
 * Stream-ticket scopes on the two SSE routes the Admin
 * Console consumes:
 *
 *   GET /api/v1/admin/dna-writing-styles/jobs/:jobId/stream
 *     `@StreamScope({ namespace: 'dna_job', param: 'jobId' })`
 *   GET /api/v1/audio/transcription-jobs/:id/stream
 *     `@StreamScope({ namespace: 'transcription_job', param: 'id' })`
 *
 * Contract (mirrors consultation-jobs.e2e-spec.ts): no credential → 401; a
 * single-use ticket minted by POST /auth/stream-ticket with the matching
 * `<namespace>:<resourceId>` scope must pass the auth guard (anything but
 * 401 — unknown ids may still 404 from the pre-stream ownership guard or
 * terminate the stream immediately); a ticket for a DIFFERENT resource id
 * must be rejected with 401.
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

async function mintTicket(request: any, token: string, scope: string): Promise<string> {
  const response = await request.post('/api/v1/auth/stream-ticket', {
    headers: { Authorization: `Bearer ${token}` },
    data: { scope },
  });
  expect(response.status(), `stream-ticket mint failed for ${scope}`).toBe(200);
  const body = await response.json();
  expect(body.scope).toBe(scope);
  return body.ticket as string;
}

test.describe('stream-ticket scopes', () => {
  test.describe('GET /admin/dna-writing-styles/jobs/:jobId/stream', () => {
    test('returns 401 without authentication or ticket', async ({ request }) => {
      const response = await request.get('/api/v1/admin/dna-writing-styles/jobs/some-job/stream');
      expect(response.status()).toBe(401);
    });

    test('accepts a single-use ticket scoped dna_job:<jobId>', async ({ request }) => {
      const token = await login(request);
      const ticket = await mintTicket(request, token, 'dna_job:e2e-dna-job-419');

      const sseResponse = await request.get(`/api/v1/admin/dna-writing-styles/jobs/e2e-dna-job-419/stream?ticket=${encodeURIComponent(ticket)}`);
      // The unknown job may terminate the stream immediately (404/stream
      // error), but the ticket must not be rejected by the auth guard.
      expect(sseResponse.status()).not.toBe(401);
    });

    test('rejects a ticket minted for a different job id', async ({ request }) => {
      const token = await login(request);
      const ticket = await mintTicket(request, token, 'dna_job:other-job');

      const sseResponse = await request.get(`/api/v1/admin/dna-writing-styles/jobs/e2e-dna-job-419/stream?ticket=${encodeURIComponent(ticket)}`);
      expect(sseResponse.status()).toBe(401);
    });
  });

  test.describe('GET /audio/transcription-jobs/:id/stream', () => {
    test('returns 401 without authentication or ticket', async ({ request }) => {
      const response = await request.get('/api/v1/audio/transcription-jobs/some-job/stream');
      expect(response.status()).toBe(401);
    });

    test('accepts a single-use ticket scoped transcription_job:<id>', async ({ request }) => {
      const token = await login(request);
      const ticket = await mintTicket(request, token, 'transcription_job:e2e-stt-job-419');

      const sseResponse = await request.get(`/api/v1/audio/transcription-jobs/e2e-stt-job-419/stream?ticket=${encodeURIComponent(ticket)}`);
      // Ticket auth must pass; the unknown id then 404s in the pre-stream
      // @TenantOwnedResource ownership guard — that is the accepted contract.
      expect(sseResponse.status()).not.toBe(401);
    });

    test('rejects a ticket minted for a different job id', async ({ request }) => {
      const token = await login(request);
      const ticket = await mintTicket(request, token, 'transcription_job:other-job');

      const sseResponse = await request.get(`/api/v1/audio/transcription-jobs/e2e-stt-job-419/stream?ticket=${encodeURIComponent(ticket)}`);
      expect(sseResponse.status()).toBe(401);
    });
  });
});
