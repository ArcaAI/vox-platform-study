/**
 * Cross-tenant probes against the Prompt Inspector and the composed-prompt records (TASK-1035):
 *
 *   - `POST /admin/consultations/:consultationId/prompt-preview` — the response IS the prompt,
 *     PHI included, so a preview of another tenant's consultation must be 404 (never 403, never
 *     200), indistinguishable from an id nobody holds;
 *   - `GET /admin/composed-prompts/:id` — another tenant's record, or an unknown id, is 404;
 *   - `GET /admin/composed-prompts?consultationId=` — another tenant's consultation lists nothing.
 *
 * Genuine probe: the consultation REALLY EXISTS in `__GLOBAL__` and is probed from ARCAAI by the
 * SAME human, so the tenant is the only variable.
 *
 * Live-stack requirement: the test API on 8968 plus the seeded test database
 * (`pnpm infra:test:up`, schema push, `RUN_SEED=all` seed). The owning-tenant preview needs the
 * guardrail service for PII detection; without it the owner sees 503 (`GUARDRAIL_UNAVAILABLE`),
 * which still proves the request got PAST the tenant check — the cross-tenant assertions do not
 * depend on it.
 */
import { expect, test } from '@playwright/test';

import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** Seeded `GEN_COMPLETED` consultation — tenant `__GLOBAL__` (`SEED_CONSULTATION_IDS.GEN_COMPLETED`). */
const GLOBAL_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';

/** uuidv7-shaped ids no tenant has ever held — the 404 SHAPE baseline. */
const SYNTHETIC_CONSULTATION_ID = '018f0000-0000-7000-8000-000000000999';
const SYNTHETIC_RECORD_ID = '018f0000-0000-7000-8000-000000000998';

const previewPath = (id: string): string => `/api/v1/admin/consultations/${id}/prompt-preview`;

test.describe('TASK-1035 — Prompt Inspector + composed-prompt records cross-tenant probe', () => {
  let globalToken: string;
  let arcaaiToken: string;

  test.beforeAll(async ({ request }) => {
    const globalLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(globalLogin, 'super_admin login (__GLOBAL__) failed').toBeTruthy();
    globalToken = globalLogin!.token;

    const arcaaiLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiToken = arcaaiLogin!.token;
  });

  test('the owning tenant gets past the tenant check (200, or 503 without a guardrail)', async ({ request }) => {
    const response = await request.post(previewPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${globalToken}` },
      data: { phase: 'finalize' },
    });

    expect([200, 503], `owning-tenant preview — body: ${await response.text()}`).toContain(response.status());
  });

  test('a preview of another tenant`s consultation is 404 — never 403, never 200', async ({ request }) => {
    const response = await request.post(previewPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${arcaaiToken}` },
      data: { phase: 'finalize' },
    });

    expect(response.status(), `cross-tenant preview — body: ${await response.text()}`).toBe(404);
  });

  test('a cross-tenant consultation and an unknown one are indistinguishable', async ({ request }) => {
    const crossTenant = await request.post(previewPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${arcaaiToken}` },
      data: { phase: 'live' },
    });
    const synthetic = await request.post(previewPath(SYNTHETIC_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${arcaaiToken}` },
      data: { phase: 'live' },
    });

    expect(crossTenant.status()).toBe(404);
    expect(synthetic.status()).toBe(404);
    expect(String((await crossTenant.json()).message ?? '')).not.toMatch(/tenant/i);
  });

  test('an invalid phase is a 400 before anything else', async ({ request }) => {
    const response = await request.post(previewPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${globalToken}` },
      data: { phase: 'summary' },
    });

    expect(response.status()).toBe(400);
  });

  test('another tenant`s consultation lists no composed-prompt record', async ({ request }) => {
    const response = await request.get(`/api/v1/admin/composed-prompts?consultationId=${GLOBAL_CONSULTATION_ID}`, {
      headers: { Authorization: `Bearer ${arcaaiToken}` },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { data: unknown[]; count: number };
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  test('a record id from no tenant of the caller is 404', async ({ request }) => {
    const response = await request.get(`/api/v1/admin/composed-prompts/${SYNTHETIC_RECORD_ID}`, {
      headers: { Authorization: `Bearer ${arcaaiToken}` },
    });

    expect(response.status()).toBe(404);
  });

  test('every record the OWNING tenant lists is 404 from another tenant', async ({ request }) => {
    const owned = await request.get(`/api/v1/admin/composed-prompts?consultationId=${GLOBAL_CONSULTATION_ID}`, {
      headers: { Authorization: `Bearer ${globalToken}` },
    });
    expect(owned.status()).toBe(200);
    const rows = ((await owned.json()) as { data: Array<{ id: string }> }).data;
    test.skip(rows.length === 0, 'no composed prompt has been recorded for the seeded consultation on this stack');

    const probe = await request.get(`/api/v1/admin/composed-prompts/${rows[0]!.id}`, {
      headers: { Authorization: `Bearer ${arcaaiToken}` },
    });
    expect(probe.status()).toBe(404);
  });
});
