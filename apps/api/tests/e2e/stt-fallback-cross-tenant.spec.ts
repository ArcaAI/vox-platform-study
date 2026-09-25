/**
 * The STT fallback surface after TASK-1006.
 *
 * The tenant-wide `TenantSttConfig` (`/api/v1/admin/stt-config/**`) is REMOVED: the fallback is a
 * property of the resolved ASR agent (`ResolvedAsrSpec.fallback`) and BYO STT keys live under
 * `admin/providers/stt/:provider` (covered by `ai-provider-connections.spec.ts`). What survives,
 * and is locked here:
 *  1. Every retired `admin/stt-config` route answers 404 — removed, not shimmed.
 *  2. The manual switch endpoint is tenant-owned (a foreign/unknown session 404s).
 *  3. The internal batch-pull route is service-token gated (no user JWT admits).
 *
 * Authored now, RUN when a live stack is available (`pnpm test:up:api` then `pnpm test:e2e`).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const RETIRED = '/api/v1/admin/stt-config';
const STREAM_BASE = '/api/v1/audio/transcription-jobs';

test.describe('STT fallback surface (TASK-1006)', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'super admin login (ARCAAI) failed').toBeTruthy();
    superAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test('every retired admin/stt-config route answers 404', async ({ request }) => {
    for (const token of [superAdminToken, tenantAdminToken]) {
      const headers = { Authorization: `Bearer ${token}` };
      for (const resp of [
        await request.get(RETIRED, { headers }),
        await request.get(`${RETIRED}/row`, { headers }),
        await request.get(`${RETIRED}/fallback-candidates`, { headers }),
        await request.put(`${RETIRED}/row`, { headers: { ...headers, 'If-Match': '"1"' }, data: { fallbackPipelineId: null } }),
      ]) {
        expect(resp.status()).toBe(404);
      }
    }
  });

  test('switch-to-fallback on an unknown/foreign session 404s (tenant-owned)', async ({ request }) => {
    const resp = await request.post(`${STREAM_BASE}/stream/session/00000000-0000-0000-0000-0000000000ff/switch-to-fallback`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    // 404 (unknown/foreign session, no existence leak) or 409 (the agent declares no fallback) —
    // never a 200 for a session the caller does not own.
    expect([404, 409]).toContain(resp.status());
  });

  test('the internal batch-pull route is service-token gated (no user JWT admits)', async ({ request }) => {
    const resp = await request.get('/api/v1/internal/stt/provider-overrides?tenantId=00000000-0000-0000-0000-000000000000', {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect([401, 403]).toContain(resp.status());
  });
});
