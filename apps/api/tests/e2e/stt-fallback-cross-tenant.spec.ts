/**
 * Cross-tenant + secret-hygiene probes against the STT fallback/BYOK
 * surface: `/api/v1/admin/stt-config` (admin) + the streaming switch endpoint.
 * Follows the / / pattern (see
 * `ai-provider-connections-cross-tenant.spec.ts`).
 *
 * Authored now, RUN when a live stack is available (`pnpm test:up:api` then
 * `pnpm test:e2e`) — it needs a seeded DB + running gateway, so it is NOT part
 * of the Phase D `pnpm test:unit` gate.
 *
 * Locked contracts:
 *  1. SECRET NEVER ECHOED — no response from ANY route contains the key, the
 *     ciphertext, or an `apiKey`/`encryptedApiKey` field at any depth. Asserted
 *     over the full HTTP body, not a typed projection. No reveal route exists.
 *  2. RFC 7232 OCC — a credential/row PUT without `If-Match` → 428; a stale
 *     `If-Match` → 412; `If-Match: "0"` creates.
 *  3. Unknown BYO provider → 400 (not 404 — the provider set is fixed).
 *  4. Cross-tenant — a tenant admin passing a foreign `?tenantId=` never gets
 *     another tenant's data (403/404, never 200 with foreign rows).
 *  5. The manual switch endpoint is tenant-owned (a foreign/unknown session
 *     404s) and fail-closed on selection (no fallback configured → 409).
 *  6. The internal batch-pull route is service-token gated (no user JWT admits).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/stt-config';
const STREAM_BASE = '/api/v1/audio/transcription-jobs';

/** Every key name in an object graph — the deep secret scan. */
function deepKeys(value: unknown, acc: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    value.forEach((v) => deepKeys(v, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    acc.push(k);
    deepKeys(v, acc);
  }
  return acc;
}

function assertNoSecretMaterial(rawBody: string): void {
  const parsed = JSON.parse(rawBody) as unknown;
  const keys = deepKeys(parsed).map((k) => k.toLowerCase());
  for (const forbidden of ['apikey', 'encryptedapikey', 'ciphertext', 'secret', 'plaintext']) {
    expect(keys, `response must not carry a '${forbidden}' field`).not.toContain(forbidden);
  }
  // Vault Transit ciphertext is literally prefixed `vault:vN:`.
  expect(rawBody).not.toContain('vault:v');
}

test.describe('STT fallback + BYOK', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let foreignTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'super admin login (ARCAAI) failed').toBeTruthy();
    superAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    // The SYSTEM/platform-default tenant id — a foreign tenant from the seeded
    // tenant admin's perspective.
    const resp = await request.get(BASE, { headers: { Authorization: `Bearer ${superAdminToken}` } });
    expect(resp.status()).toBe(200);
    foreignTenantId = ((await resp.json()) as { tenantId: string }).tenantId;
  });

  test('GET effective + GET row never carry key material', async ({ request }) => {
    for (const path of ['', '/row']) {
      const resp = await request.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
      expect(resp.status()).toBe(200);
      assertNoSecretMaterial(await resp.text());
    }
  });

  test('GET credentials list never carries key material (masked hasKey/keyVersion only)', async ({ request }) => {
    const resp = await request.get(`${BASE}/credentials`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect(resp.status()).toBe(200);
    assertNoSecretMaterial(await resp.text());
  });

  test('GET fallback-candidates returns an array of enabled cloud pipelines, no secrets', async ({ request }) => {
    const resp = await request.get(`${BASE}/fallback-candidates`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect(resp.status()).toBe(200);
    const raw = await resp.text();
    assertNoSecretMaterial(raw);
    expect(Array.isArray(JSON.parse(raw))).toBe(true);
  });

  test('there is NO reveal route for provider keys', async ({ request }) => {
    const resp = await request.get(`${BASE}/credentials/sarvam/reveal`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect([404, 405]).toContain(resp.status());
  });

  test('credential PUT without If-Match → 428', async ({ request }) => {
    const resp = await request.put(`${BASE}/credentials/sarvam`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { apiKey: 'probe-key', expectedVersion: 0 },
    });
    expect(resp.status()).toBe(428);
  });

  test('credential PUT with a stale If-Match → 412', async ({ request }) => {
    const resp = await request.put(`${BASE}/credentials/sarvam`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': '"9999"' },
      data: { apiKey: 'probe-key' },
    });
    expect(resp.status()).toBe(412);
  });

  test('an unknown BYO provider → 400 (fixed provider set, not 404)', async ({ request }) => {
    const resp = await request.put(`${BASE}/credentials/not-a-provider`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': '"0"' },
      data: { apiKey: 'probe-key', expectedVersion: 0 },
    });
    expect(resp.status()).toBe(400);
  });

  test('fallback row PUT without If-Match → 428', async ({ request }) => {
    const resp = await request.put(`${BASE}/row`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { fallbackPipelineId: null, expectedVersion: 0 },
    });
    expect(resp.status()).toBe(428);
  });

  test('a written key is never returned by the write response either', async ({ request }) => {
    const read = await request.get(`${BASE}/credentials`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    const rows = (await read.json()) as Array<{ provider: string; version: number }>;
    const existing = rows.find((r) => r.provider === 'sarvam');
    const etag = existing ? `"${existing.version}"` : '"0"';
    const resp = await request.put(`${BASE}/credentials/sarvam`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': etag },
      data: { apiKey: 'sk-e2e-probe-value', enabled: false },
    });
    // 400 is legitimate when the test env has no Vault Transit provider (the
    // Vault-gate rejects rather than storing plaintext) — the never-echoed
    // contract holds either way.
    expect([200, 400]).toContain(resp.status());
    const raw = await resp.text();
    expect(raw).not.toContain('sk-e2e-probe-value');
    if (resp.status() === 200) assertNoSecretMaterial(raw);
  });

  test('a tenant admin cannot address a foreign tenant', async ({ request }) => {
    const resp = await request.get(`${BASE}/credentials?tenantId=${foreignTenantId}`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect([403, 404]).toContain(resp.status());
    if (resp.status() === 200) assertNoSecretMaterial(await resp.text());
  });

  test('switch-to-fallback on an unknown/foreign session 404s (tenant-owned)', async ({ request }) => {
    const resp = await request.post(`${STREAM_BASE}/stream/session/00000000-0000-0000-0000-0000000000ff/switch-to-fallback`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    // 404 (unknown/foreign session, no existence leak) or 409 (no fallback
    // configured) — never a 200 for a session the caller does not own.
    expect([404, 409]).toContain(resp.status());
  });

  test('the internal batch-pull route is service-token gated (no user JWT admits)', async ({ request }) => {
    const resp = await request.get(`/api/v1/internal/stt/provider-overrides?tenantId=${foreignTenantId}`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect([401, 403]).toContain(resp.status());
  });
});
