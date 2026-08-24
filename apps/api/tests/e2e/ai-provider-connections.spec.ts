/**
 * AI provider connections e2e.
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus a seeded
 * database (`pnpm db:seed`), which supplies the eleven SYSTEM `llm`
 * `AiProviderConnection` rows (ollama, lm-studio, azure, bedrock, built-in,
 * sarvam, openai, anthropic, vertex, vllm, llama-cpp — see
 * seed/17-ai-provider-connection.ts; the legacy `/admin/ai-providers` alias
 * hard-pins `service='llm'`, so `stt`/`tts` rows never show up here).
 * Seed-authoritative posture: the five built-in-local engines
 * (ollama, lm-studio, built-in, vllm, llama-cpp) seed ENABLED as the Day-1
 * default; the six cloud/BYO providers (azure, bedrock, sarvam, openai,
 * anthropic, vertex) seed DISABLED until a tenant brings a key.
 *
 * No VENDOR credential is ever seeded, but "keyless" is not the same as "no key
 * material": TASK-799 lane B gives the four self-hosted ENGINE rows the
 * non-secret placeholder `not-needed`, because the `provider_overrides` fold
 * that DELIVERS a connection to `apps/text` drops any row without key material,
 * so a keyless self-host row resolves and then serves nothing (503). `built-in`
 * is excluded on purpose — it has no remote endpoint to authenticate to.
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
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'super admin login failed').toBeTruthy();
    superAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  test('seeds eleven SYSTEM llm connections: built-in-local enabled, cloud disabled, all keyless', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/ai-providers?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    expect(res.status()).toBe(200);

    // Seed-authoritative: the built-in-local engines are the enabled
    // Day-1 default; cloud/BYO providers stay disabled until a tenant keys them.
    // TASK-736 REVISED (owner decision 2026-08-17): Ollama's provider logic is
    // retained, so its SYSTEM connection row is back and the llm connection
    // count returns to eleven. Only its MODEL CATALOG rows stay purged.
    const BUILTIN_LOCAL = new Set(['ollama', 'lm-studio', 'built-in', 'vllm', 'llama-cpp']);
    // The self-hosted ENGINE rows carry the non-secret `not-needed` placeholder (see the header):
    // `built-in` runs in-process, so it is the one built-in-local row with nothing to key.
    const SELF_HOST_KEYED = new Set(['ollama', 'lm-studio', 'vllm', 'llama-cpp']);

    const rows = await res.json();
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.hasKey, `${row.provider} key material must match the self-host placeholder posture`).toBe(SELF_HOST_KEYED.has(row.provider));
      expect(row.enabled, `${row.provider} enabled-state must match built-in-local posture`).toBe(BUILTIN_LOCAL.has(row.provider));
    }
    const enabled = rows
      .filter((r: { enabled: boolean }) => r.enabled)
      .map((r: { provider: string }) => r.provider)
      .sort();
    expect(enabled).toEqual([...BUILTIN_LOCAL].sort());
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
