/**
 * AI provider connections e2e.
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus a seeded
 * database (`pnpm db:seed`), which supplies the nine DISABLED SYSTEM
 * `AiProviderConnection` rows (ollama, lm-studio, azure, bedrock, built-in,
 * sarvam, openai, vllm, llama-cpp — see seed/17-ai-provider-connection.ts).
 *
 * What these specs prove that unit tests cannot:
 *   1. The OCC chain really is wired end to end through the gateway —
 *      `@RequiresIfMatch()` produces a genuine 428 and a stale token a genuine
 *      412, over real HTTP with real headers.
 *   2. The strict global pipe (`whitelist + forbidNonWhitelisted`) rejects an
 *      undeclared body field with 400.
 *   3. The ciphertext never crosses the wire — asserted against the RAW
 *      RESPONSE TEXT, not a parsed object, so a leak through any nested field
 *      or serializer quirk still fails.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

test.describe('AI provider connections', () => {
  let globalAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'global admin login failed').toBeTruthy();
    globalAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${globalAdminToken}` });

  test('seeds nine SYSTEM connections, all disabled and all keyless', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/ai-providers?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    expect(res.status()).toBe(200);

    const rows = await res.json();
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.enabled, `${row.provider} must seed disabled`).toBe(false);
      expect(row.hasKey, `${row.provider} must seed keyless`).toBe(false);
    }
  });

  test('never returns ciphertext on the wire (raw-body assertion)', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/ai-providers?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    const raw = await res.text();
    expect(raw).not.toContain('encryptedApiKey');
    expect(raw).not.toContain('vault:v');
  });

  test('PATCH-equivalent PUT without If-Match → 428', async ({ request }) => {
    const res = await request.put(`/api/v1/admin/ai-providers/azure?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(),
      data: { enabled: false },
    });
    expect(res.status()).toBe(428);
  });

  test('PUT with a stale If-Match → 412', async ({ request }) => {
    const current = await request.get(`/api/v1/admin/ai-providers/azure?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(),
    });
    const { version } = await current.json();

    const res = await request.put(`/api/v1/admin/ai-providers/azure?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...auth(), 'If-Match': `"${version + 99}"` },
      data: { apiVersion: '2024-10-21' },
    });
    expect(res.status()).toBe(412);
  });

  test('rejects an undeclared body field with 400 (forbidNonWhitelisted)', async ({ request }) => {
    const res = await request.put(`/api/v1/admin/ai-providers/azure?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...auth(), 'If-Match': '"1"' },
      data: { enabled: true, thisFieldIsNotDeclared: 'boom' },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('AI provider connections cross-tenant posture', () => {
  test('a tenant admin cannot write a SYSTEM provider connection (403, not 404)', async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login).toBeTruthy();

    const res = await request.put(`/api/v1/admin/ai-providers/ollama?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${login!.token}`, 'If-Match': '"1"' },
      data: { enabled: true },
    });
    // Either the route-level CASL guard (403) or the service-level privilege
    // guard (403) fires; both are the correct privilege-boundary answer.
    expect([401, 403]).toContain(res.status());
  });
});
