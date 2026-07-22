/**
 * BYO cloud-credential probes against AiProviderConnectionController
 * (`/api/v1/admin/ai-providers`), following the task-307 / task-506 pattern.
 *
 * The e2e job needs a live gateway +
 * seeded DB; `pnpm test:api:up` then `pnpm test:e2e`.
 *
 * Locked contracts:
 *  1. SECRET NEVER ECHOED — no response from ANY route on this controller
 *     contains the key, the ciphertext, or an `apiKey`/`encryptedApiKey` field
 *     at any depth. Asserted over the full HTTP body, not a typed projection.
 *     There is no reveal route, so a probe for one must 404/405.
 *  2. Self-host providers are rejected on a tenant row → 403 (a privilege rule
 *     on the caller's OWN tenant, not the 404-over-403 existence posture).
 *  3. Cross-tenant — a tenant admin passing a foreign `?tenantId=` never gets
 *     data (403/404, never 200 with another tenant's row).
 *  4. RFC 7232 OCC — PUT without `If-Match` → 428; stale `If-Match` → 412;
 *     `If-Match: "0"` creates.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/ai-providers';

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
  // Vault Transit ciphertext is literally prefixed `vault:vN:` — a belt-and-braces
  // scan over the serialized body catches it wherever it might be embedded.
  expect(rawBody).not.toContain('vault:v');
}

async function readRow(request: APIRequestContext, token: string, provider: string, tenantId?: string) {
  const qs = tenantId ? `?tenantId=${tenantId}` : '';
  const resp = await request.get(`${BASE}/${provider}${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  return resp;
}

test.describe('tenant BYO cloud credentials', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string;
  let foreignTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login (ARCAAI) failed').toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    const resp = await readRow(request, globalAdminToken, 'azure');
    expect(resp.status()).toBe(200);
    foreignTenantId = ((await resp.json()) as { tenantId: string }).tenantId;
  });

  test('GET row never carries key material (masked hasKey/keyVersion only)', async ({ request }) => {
    const resp = await readRow(request, tenantAdminToken, 'azure');
    expect(resp.status()).toBe(200);
    const raw = await resp.text();
    assertNoSecretMaterial(raw);
    const body = JSON.parse(raw) as { hasKey: boolean; version: number };
    expect(typeof body.hasKey).toBe('boolean');
    expect(typeof body.version).toBe('number');
  });

  test('LIST never carries key material', async ({ request }) => {
    const resp = await request.get(BASE, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect(resp.status()).toBe(200);
    assertNoSecretMaterial(await resp.text());
  });

  test('there is NO reveal route for provider keys', async ({ request }) => {
    const resp = await request.get(`${BASE}/azure/reveal`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect([404, 405]).toContain(resp.status());
  });

  test('PUT without If-Match → 428', async ({ request }) => {
    const resp = await request.put(`${BASE}/azure`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { apiKey: 'probe-key', expectedVersion: 0 },
    });
    expect(resp.status()).toBe(428);
  });

  test('PUT with a stale If-Match → 412', async ({ request }) => {
    const resp = await request.put(`${BASE}/azure`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': '"9999"' },
      data: { apiKey: 'probe-key' },
    });
    expect(resp.status()).toBe(412);
  });

  test('self-host provider on a tenant row → 403 (privilege boundary, not 404)', async ({ request }) => {
    const resp = await request.put(`${BASE}/ollama`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': '"0"' },
      data: { baseUrl: 'http://evil.local:11434', expectedVersion: 0 },
    });
    expect(resp.status()).toBe(403);
  });

  test('a tenant admin cannot address a foreign tenant row', async ({ request }) => {
    const resp = await readRow(request, tenantAdminToken, 'azure', foreignTenantId);
    expect([403, 404]).toContain(resp.status());
    if (resp.status() === 200) {
      // Defensive: even if a future change relaxes the status, no data may leak.
      assertNoSecretMaterial(await resp.text());
    }
  });

  test('a written key is never returned by the write response either', async ({ request }) => {
    const read = await readRow(request, tenantAdminToken, 'azure');
    const etag = read.headers()['etag'] ?? '"0"';
    const resp = await request.put(`${BASE}/azure`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': etag },
      data: { apiKey: 'sk-e2e-probe-value', baseUrl: 'https://probe.openai.azure.com', enabled: false },
    });
    // 400 is a legitimate outcome when the test environment has no Vault Transit
    // provider (the Vault-gate rejects rather than storing plaintext) — the
    // secret-never-echoed contract must hold either way.
    expect([200, 400]).toContain(resp.status());
    const raw = await resp.text();
    expect(raw).not.toContain('sk-e2e-probe-value');
    if (resp.status() === 200) assertNoSecretMaterial(raw);
  });
});
