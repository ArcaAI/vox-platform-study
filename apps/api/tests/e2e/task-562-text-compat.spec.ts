/**
 * V1-compatible SMR summary gateway shims.
 *
 * Verifies the gateway contract for the two additive routes against a RUNNING
 * API:
 *   POST /api/smr/api/v1/summary/sync
 *   POST /api/smr/api/v1/presummary
 *
 * Key facts under test:
 *   - The routes are served at the LITERAL v1 paths (NO `api/v1` global prefix)
 * a request to them must NOT 404 (exact-path reproduction).
 *   - Deny-by-default auth: no credential → 401; a valid Bearer JWT or
 *     `x-api-key` reaches the shim.
 *   - Strict DTO validation: a missing `session_data` → 400.
 *   - Happy path returns a v1 `SummaryResponse` / `PreSummaryResponse` shape.
 *
 * The upstream SMR service (:8862) is NOT part of the API e2e infra, so a valid
 * request may resolve to a 200 (SMR up — shape validated) or a 500 (SMR down —
 * the v1 `{ error: "SMR service unavailable", ... }` / `{ detail: ... }` shape).
 * Either way it must never be an auth rejection or a 404.
 *
 * Prerequisites: API server running + seeded users (pnpm test:db:seed).
 */

import { expect, test } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';
// Validate LIVE 200 responses against the frozen v1 schema lock
// (/). Hermetic when SMR is down (status ≠ 200 → shape check skipped).
import { PreSummaryResponseSchema, SummaryResponseSchema } from '../../../../tests/contracts/smr-compat.schemas';

const SUMMARY_SYNC_PATH = '/api/smr/api/v1/summary/sync';
const PRESUMMARY_PATH = '/api/smr/api/v1/presummary';

const sampleSummaryBody = () => ({
  session_data: {
    session_id: `e2e-562-${Date.now()}`,
    created_at: new Date().toISOString(),
    conversation_segments: [
      { speaker: 'provider', text: 'What brings you in today?', timestamp: new Date().toISOString() },
      { speaker: 'patient', text: 'Chest tightness for three days.', timestamp: new Date().toISOString(), confidence: 0.94 },
    ],
    session_metadata: { language: 'en' },
    test_results_text: 'Troponin: normal. ECG: sinus rhythm.',
  },
  use_enhanced_format: false,
  department: 'Cardiology',
  visit_type: 'New Referral',
  temperature: 0.2,
  max_tokens: 800,
});

const samplePreSummaryBody = () => ({
  current_department: 'Cardiology',
  visit_type: 'Follow-up',
  age: '58',
  gender: 'male',
  formatted_vitals: 'BP 142/88, HR 78, SpO2 98%',
  formatted_test_results: 'Troponin normal; LDL 150 mg/dL',
  language: 'en',
});

test.describe('V1-compatible SMR summary shims', () => {
  let token: string;
  let apiKey: string | undefined;
  const createdApiKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // A TENANT-SCOPED admin, not the global superAdmin: the v1 SDK consumers
    // these shims emulate are always tenant-bound, and the compat shim requires
    // a resolvable tenant context (`requireTenantId`). A global-admin
    // authenticates with an EMPTY tenant, so it would (correctly) 401 on these
    // prefix-excluded routes — the working-tenant elevation interceptor does not
    // run there. tenant_admin's JWT carries a concrete tenantId, resolved by the
    // shim's JWT-user fallback.
    const result = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    token = result?.token ?? '';

    if (token) {
      // Mint an SDK api key to exercise the x-api-key parity path (D2).
      const created = await request.post('/api/v1/admin/api-keys', {
        headers: { Authorization: `Bearer ${token}` },
        data: { keyName: `e2e-562-${Date.now()}`, keyType: 'SDK', scopes: ['consultation:session:read', 'consultation:session:write'] },
      });
      if (created.status() === 201) {
        const body = await created.json();
        apiKey = body.rawKey;
        createdApiKeyIds.push(body.apiKey.id);
      }
    }
  });

  test.afterAll(async ({ request }) => {
    if (!token) return;
    for (const id of createdApiKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
  });

  test('summary/sync is served at the literal v1 path (not under api/v1) and denies unauthenticated calls', async ({ request }) => {
    // Literal path → 401 (auth), NOT 404 (route exists at the un-prefixed path).
    const unauth = await request.post(SUMMARY_SYNC_PATH, { data: sampleSummaryBody() });
    expect(unauth.status(), 'literal path must exist and require auth').toBe(401);

    // The global-prefixed variant must NOT exist (proves the exclusion is exact).
    const prefixed = await request.post(`/api/v1${SUMMARY_SYNC_PATH}`, { data: sampleSummaryBody() });
    expect(prefixed.status()).toBe(404);
  });

  test('presummary is served at the literal v1 path and denies unauthenticated calls', async ({ request }) => {
    const unauth = await request.post(PRESUMMARY_PATH, { data: samplePreSummaryBody() });
    expect(unauth.status()).toBe(401);
  });

  test('rejects a missing session_data with 400 (strict DTO)', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const response = await request.post(SUMMARY_SYNC_PATH, {
      headers: { Authorization: `Bearer ${token}` },
      data: { use_enhanced_format: false },
    });
    expect(response.status()).toBe(400);
  });

  test('rejects an undeclared field with 400 (forbidNonWhitelisted)', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const response = await request.post(SUMMARY_SYNC_PATH, {
      headers: { Authorization: `Bearer ${token}` },
      data: { ...sampleSummaryBody(), not_a_declared_field: true },
    });
    expect(response.status()).toBe(400);
  });

  test('an authenticated Bearer caller reaches the shim (never 401/403/404)', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const response = await request.post(SUMMARY_SYNC_PATH, {
      headers: { Authorization: `Bearer ${token}` },
      data: sampleSummaryBody(),
    });
    expect([200, 500, 502, 503]).toContain(response.status());
    if (response.status() === 200) {
      const body = await response.json();
      // v1 SummaryResponse shape — locked by the shared schema.
      const parsed = SummaryResponseSchema.safeParse(body);
      expect(parsed.success, `live response must match the v1 SummaryResponse schema: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(body.metadata).toHaveProperty('use_enhanced_format', false);
      // Provider internals must never leak.
      expect(body.metadata).not.toHaveProperty('raw_llm_content');
    }
  });

  test('an x-api-key caller reaches the shim (parity D2)', async ({ request }) => {
    test.skip(!apiKey, 'api key creation failed — is the API seeded?');
    const response = await request.post(SUMMARY_SYNC_PATH, {
      headers: { 'x-api-key': apiKey!, Accept: 'application/json' },
      data: sampleSummaryBody(),
    });
    expect([200, 500, 502, 503]).toContain(response.status());
  });

  test('presummary happy path returns a v1 PreSummaryResponse shape', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const response = await request.post(PRESUMMARY_PATH, {
      headers: { Authorization: `Bearer ${token}` },
      data: samplePreSummaryBody(),
    });
    expect([200, 500, 502, 503]).toContain(response.status());
    if (response.status() === 200) {
      const body = await response.json();
      // v1 PreSummaryResponse shape — locked by the shared schema.
      const parsed = PreSummaryResponseSchema.safeParse(body);
      expect(parsed.success, `live response must match the v1 PreSummaryResponse schema: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(Array.isArray(body.structured_data.sections)).toBe(true);
    }
  });
});
