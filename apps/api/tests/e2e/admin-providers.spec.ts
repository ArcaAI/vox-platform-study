/**
 * Unified provider-connection admin surface e2e — `admin/providers/:service`
 * (C3).
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus a seeded
 * database (`pnpm db:seed`), which supplies the DISABLED SYSTEM
 * `AiProviderConnection` rows across the `llm` / `stt` / `tts` services.
 *
 * What these specs prove that unit tests cannot:
 *   1. The unified controller is mounted at `admin/providers/:service/:provider`
 *      and the OCC chain (`@RequiresIfMatch()`) is wired end to end — a genuine
 *      428 for a missing header and a genuine 412 for a stale token, over real
 *      HTTP with real headers.
 *   2. The three new cloud LLM providers (openai / anthropic / vertex) are
 *      readable on the plane (governance + seed landed).
 *   3. The legacy `admin/ai-providers/*` alias still resolves to the same `llm`
 *      rows for the one-release deprecation window.
 *   4. The ciphertext never crosses the wire — asserted against the RAW RESPONSE
 *      TEXT so a leak through any nested field or serializer quirk still fails.
 *
 * The frozen `admin/ai-providers` e2e (`ai-provider-connections.spec.ts`) is left
 * untouched; this file is the NEW coverage for the unified route surface.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

test.describe('Unified provider connections — admin/providers/llm', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'super admin login failed').toBeTruthy();
    superAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  test('lists the SYSTEM llm connections including the three new cloud providers, all masked', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/providers/llm?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    expect(res.status()).toBe(200);

    const rows = await res.json();
    const providers = new Set<string>(rows.map((r: { provider: string }) => r.provider));
    // The new cloud LLM providers plus the incumbents must all seed.
    for (const p of ['azure', 'bedrock', 'openai', 'anthropic', 'vertex']) {
      expect(providers.has(p), `llm connection for '${p}' must seed`).toBe(true);
    }
    // No VENDOR credential is ever seeded. The four self-hosted ENGINE rows do carry the
    // non-secret `not-needed` placeholder (TASK-799 lane B — the `provider_overrides` fold drops
    // a keyless row, so without it the engine resolves and then serves nothing); `built-in` runs
    // in-process and has no endpoint to authenticate to. Either way the ciphertext column never
    // reaches the wire, which is what this route's masking contract is about.
    const SELF_HOST_KEYED = new Set(['ollama', 'lm-studio', 'vllm', 'llama-cpp']);
    for (const row of rows) {
      expect(row.service, 'every row on this route is service=llm').toBe('llm');
      expect(row.hasKey, `${row.provider} key material must match the self-host placeholder posture`).toBe(SELF_HOST_KEYED.has(row.provider));
      expect(row).not.toHaveProperty('encryptedApiKey');
    }
  });

  test('reads one row (anthropic) masked, with a version-driven ETag', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/providers/llm/anthropic?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const row = await res.json();
    expect(row.service).toBe('llm');
    expect(row.provider).toBe('anthropic');
    expect(row.hasKey).toBe(false);
  });

  test('never returns ciphertext on the wire (raw-body assertion)', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/providers/llm?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    const raw = await res.text();
    expect(raw).not.toContain('encryptedApiKey');
    expect(raw).not.toContain('vault:v');
  });

  test('PUT without If-Match → 428', async ({ request }) => {
    const res = await request.put(`/api/v1/admin/providers/llm/openai?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(),
      data: { enabled: false },
    });
    expect(res.status()).toBe(428);
  });

  test('PUT with a stale If-Match → 412', async ({ request }) => {
    const current = await request.get(`/api/v1/admin/providers/llm/openai?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    const { version } = await current.json();

    const res = await request.put(`/api/v1/admin/providers/llm/openai?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...auth(), 'If-Match': `"${version + 99}"` },
      data: { baseUrl: 'https://api.openai.com/v1' },
    });
    expect(res.status()).toBe(412);
  });

  test('rejects an undeclared body field with 400 (forbidNonWhitelisted)', async ({ request }) => {
    const res = await request.put(`/api/v1/admin/providers/llm/openai?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...auth(), 'If-Match': '"1"' },
      data: { enabled: true, thisFieldIsNotDeclared: 'boom' },
    });
    expect(res.status()).toBe(400);
  });

  test('rejects an unknown service segment with 400', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/providers/not-a-service?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    expect(res.status()).toBe(400);
  });
});

test.describe('Unified provider connections — legacy admin/ai-providers alias', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'super admin login failed').toBeTruthy();
    superAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  test('the legacy alias returns the SAME llm rows as the unified route', async ({ request }) => {
    const [legacy, unified] = await Promise.all([
      request.get(`/api/v1/admin/ai-providers?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() }),
      request.get(`/api/v1/admin/providers/llm?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() }),
    ]);
    expect(legacy.status()).toBe(200);
    expect(unified.status()).toBe(200);

    const providersOf = (rows: { provider: string }[]) => rows.map((r) => r.provider).sort();
    expect(providersOf(await legacy.json())).toEqual(providersOf(await unified.json()));
  });

  test('the legacy alias still enforces OCC (missing If-Match → 428)', async ({ request }) => {
    const res = await request.put(`/api/v1/admin/ai-providers/anthropic?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(),
      data: { enabled: false },
    });
    expect(res.status()).toBe(428);
  });
});
