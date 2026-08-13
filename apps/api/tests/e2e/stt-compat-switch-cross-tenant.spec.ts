/**
 * Cross-tenant + fail-closed probes against the v1-compat STT switch
 * endpoint `POST /api/stt/switch` (note: the compat surface is OUTSIDE the
 * `/api/v1` global prefix). Mirrors `stt-fallback-cross-tenant.spec.ts` for the
 * native `/switch-to-fallback` route.
 *
 * Authored now, RUN when a live stack is available (`pnpm test:up:api` then
 * `pnpm test:e2e`) — it needs a seeded DB + running gateway, so it is NOT part
 * of the Phase D `pnpm test:unit` gate.
 *
 * Locked contracts:
 *  1. TENANT-OWNED — a foreign/unknown session 404s (no existence leak). Both
 *     native and compat sessions live in the same sessionId→tenantId binding,
 *     so an id the caller's tenant does not own is indistinguishable from a
 *     non-existent one.
 *  2. FAIL-CLOSED selection is only reachable AFTER ownership — an unknown
 *     session never surfaces a 409 (the ownership 404 comes first).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SWITCH = '/api/stt/switch';

test.describe('STT compat switch', () => {
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test('switching an unknown/foreign session 404s (tenant-owned, no existence leak)', async ({ request }) => {
    const resp = await request.post(SWITCH, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { session_id: 'compat-session-00000000-0000-0000-0000-0000000000ff', target: 'default' },
    });
    // 404 (unknown/foreign session) — never a 200 for a session the caller does
    // not own, and never a 409 (the ownership check precedes the fallback check).
    expect(resp.status()).toBe(404);
  });

  test('switching to `pipeline` on an unowned session also 404s (ownership precedes everything)', async ({ request }) => {
    const resp = await request.post(SWITCH, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { session_id: 'compat-session-does-not-exist', target: 'pipeline' },
    });
    expect(resp.status()).toBe(404);
  });

  test('an unknown target token is rejected by validation (400)', async ({ request }) => {
    const resp = await request.post(SWITCH, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { session_id: 'compat-session-does-not-exist', target: 'bogus' },
    });
    expect(resp.status()).toBe(400);
  });
});
