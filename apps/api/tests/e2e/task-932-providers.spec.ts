/**
 * TASK-932 — the platform half of `admin/providers`, over real HTTP.
 *
 * Three contracts that only a live gateway plus a seeded database can settle:
 *
 *  R-12 — a CUSTOMER tenant sees only the cloud providers it may bring an
 *         account for. The built-in engines and the whole `model-registry`
 *         plane are platform infrastructure, so a tenant read of one is a
 *         **404** — existence, the house posture — even though a tenant WRITE
 *         of one has always been a 403. Two different questions, two different
 *         answers, and the pair is what a test has to pin: asserting only the
 *         404 would pass just as well if the route had been deleted.
 *
 *  R-3  — `POST :service/:provider/reset` restores the SEEDED endpoint. Super
 *         admin only; a tenant admin gets 403 for every provider alike, which
 *         is what makes the check leak no existence oracle.
 *
 *  D-7  — a blank, ENABLED `model-registry:s3` row is the platform's OWN object
 *         storage, and the internal weight-fetch route resolves it rather than
 *         reporting `absent`. `apps/stt` reads `absent` as "pull anonymously",
 *         which for a private weights bucket is a failed fetch, so the
 *         distinction is the whole point of the seed change.
 *
 * Live-stack requirement: `pnpm test:up:api` against a seeded database.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/providers';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The internal weight-fetch route is guarded by `InternalServiceTokenGuard`,
 * whose secret is a deployment value this suite cannot know. Gated on the
 * operator supplying it, exactly as `model-retention-settings.spec.ts` does for
 * `internal/effective-config`.
 */
const INTERNAL_ACCESS_TOKEN = process.env.E2E_INTERNAL_ACCESS_TOKEN ?? '';

interface ConnectionRow {
  service: string;
  provider: string;
  baseUrl: string | null;
  enabled: boolean;
  hasKey: boolean;
  extraJson: Record<string, unknown> | null;
  version: number;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function readRow(request: APIRequestContext, token: string, service: string, provider: string, tenantId?: string) {
  const qs = tenantId ? `?tenantId=${tenantId}` : '';
  return request.get(`${BASE}/${service}/${provider}${qs}`, { headers: auth(token) });
}

test.describe('TASK-932 — provider reads follow the tier (R-12)', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(sa, 'super admin login failed').toBeTruthy();
    superAdminToken = sa!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed').toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test('a tenant admin LISTS only cloud BYO providers', async ({ request }) => {
    const resp = await request.get(`${BASE}/llm`, { headers: auth(tenantAdminToken) });
    expect(resp.status()).toBe(200);

    const rows = (await resp.json()) as ConnectionRow[];
    for (const row of rows) {
      expect(
        ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
        `'${row.provider}' is platform infrastructure and must not reach a tenant`,
      ).toContain(row.provider);
    }
  });

  test('a direct tenant read of a built-in engine is 404, not 403 — existence is hidden', async ({ request }) => {
    for (const provider of ['lm-studio', 'ollama', 'vllm', 'llama-cpp']) {
      const resp = await readRow(request, tenantAdminToken, 'llm', provider);
      expect(resp.status(), `llm/${provider} must be 404 for a tenant`).toBe(404);
    }
  });

  test('a direct tenant read of the model registry is 404 for both providers', async ({ request }) => {
    for (const provider of ['s3', 'huggingface']) {
      const resp = await readRow(request, tenantAdminToken, 'model-registry', provider);
      expect(resp.status(), `model-registry/${provider} must be 404 for a tenant`).toBe(404);
    }
  });

  test('the same rows are readable on the platform tier — the 404 is scope, not deletion', async ({ request }) => {
    for (const [service, provider] of [
      ['llm', 'lm-studio'],
      ['model-registry', 's3'],
    ] as const) {
      const resp = await readRow(request, superAdminToken, service, provider, SYSTEM_TENANT_ID);
      expect(resp.status(), `${service}/${provider} must be readable on SYSTEM`).toBe(200);
      const row = (await resp.json()) as ConnectionRow;
      expect(row.provider).toBe(provider);
    }
  });

  test('a tenant WRITE of a platform provider is still 403 — a privilege rule, not an existence one', async ({ request }) => {
    const resp = await request.put(`${BASE}/llm/ollama`, {
      headers: { ...auth(tenantAdminToken), 'If-Match': '"0"' },
      data: { baseUrl: 'http://evil.local:11434', expectedVersion: 0 },
    });
    expect(resp.status()).toBe(403);
  });

  test('a cloud provider is unaffected — the tenant surface is intact', async ({ request }) => {
    const resp = await readRow(request, tenantAdminToken, 'llm', 'azure');
    expect(resp.status()).toBe(200);
  });
});

test.describe('TASK-932 — reset to the built-in default (R-3)', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    superAdminToken = sa!.token;
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    tenantAdminToken = ta!.token;
  });

  test('a tenant admin is refused 403 — and identically for a provider with no default', async ({ request }) => {
    const engine = await request.post(`${BASE}/llm/lm-studio/reset`, { headers: auth(tenantAdminToken), data: {} });
    expect(engine.status()).toBe(403);

    // Row-INDEPENDENT: the same 403 for a provider that ships no built-in
    // default at all, so the privilege check cannot be used to probe which
    // providers have one.
    const cloud = await request.post(`${BASE}/llm/azure/reset`, { headers: auth(tenantAdminToken), data: {} });
    expect(cloud.status()).toBe(403);
  });

  test('a provider with no built-in default is 404 for a super admin', async ({ request }) => {
    const resp = await request.post(`${BASE}/llm/azure/reset?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth(superAdminToken), data: {} });
    expect(resp.status()).toBe(404);
  });

  test('an unknown service segment is a 400 before anything else', async ({ request }) => {
    const resp = await request.post(`${BASE}/not-a-service/lm-studio/reset?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(superAdminToken),
      data: {},
    });
    expect(resp.status()).toBe(400);
  });

  test('restores the seeded endpoint after an admin points it somewhere else', async ({ request }) => {
    const before = await readRow(request, superAdminToken, 'llm', 'lm-studio', SYSTEM_TENANT_ID);
    expect(before.status()).toBe(200);
    const original = (await before.json()) as ConnectionRow;

    const moved = await request.put(`${BASE}/llm/lm-studio?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...auth(superAdminToken), 'If-Match': `"${original.version}"` },
      data: { baseUrl: 'http://localhost:1234/v1' },
    });
    expect(moved.status()).toBe(200);
    expect(((await moved.json()) as ConnectionRow).baseUrl).toBe('http://localhost:1234/v1');

    const reset = await request.post(`${BASE}/llm/lm-studio/reset?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth(superAdminToken), data: {} });
    expect(reset.status()).toBe(200);
    const restored = (await reset.json()) as ConnectionRow;

    // The shipped default is the in-cluster Service address, so whatever the
    // operator typed is gone and the row is enabled and keyed (an engine row
    // without key material is dropped by the override fold — a 503 in
    // `apps/text` — which is why reset writes the placeholder rather than
    // clearing it).
    expect(restored.baseUrl).toBe('http://hope-lmstudio:1234/v1');
    expect(restored.enabled).toBe(true);
    expect(restored.hasKey).toBe(true);

    // Leave the environment as we found it: a dev stack whose LM Studio row
    // points at the cluster is a stack where every LLM call fails.
    if (original.baseUrl && original.baseUrl !== restored.baseUrl) {
      const put = await request.put(`${BASE}/llm/lm-studio?tenantId=${SYSTEM_TENANT_ID}`, {
        headers: { ...auth(superAdminToken), 'If-Match': `"${restored.version}"` },
        data: { baseUrl: original.baseUrl },
      });
      expect(put.status()).toBe(200);
    }
  });

  test('never returns key material (raw-body assertion)', async ({ request }) => {
    const resp = await request.post(`${BASE}/model-registry/huggingface/reset?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(superAdminToken),
      data: {},
    });
    expect(resp.status()).toBe(200);
    const raw = await resp.text();
    expect(raw).not.toContain('encryptedApiKey');
    expect(raw).not.toContain('vault:v');
  });
});

test.describe('TASK-932 — the weight store is the built-in global default (R-11 / D-7)', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    superAdminToken = sa!.token;
  });

  test('the SYSTEM row seeds ENABLED and keyless, marked as inheriting the platform storage', async ({ request }) => {
    const resp = await readRow(request, superAdminToken, 'model-registry', 's3', SYSTEM_TENANT_ID);
    expect(resp.status()).toBe(200);
    const row = (await resp.json()) as ConnectionRow;

    expect(row.enabled, 'a disabled weight store renders as "no key · Disabled" — the R-11 defect').toBe(true);
    expect(row.hasKey).toBe(false);
    expect(row.extraJson).toMatchObject({ inheritsPlatformStorage: true });
  });

  test.describe('internal weight-fetch resolution (env-gated)', () => {
    test.skip(
      !INTERNAL_ACCESS_TOKEN,
      'requires E2E_INTERNAL_ACCESS_TOKEN set to the running gateway’s INTERNAL_ACCESS_TOKEN secret ' +
        '(InternalServiceTokenGuard fails closed with no configured secret)',
    );

    test('a keyless SYSTEM row resolves to the platform storage credentials, not to `absent`', async ({ request }) => {
      const resp = await request.get(`/api/v1/internal/model-registry-credential?service=stt&provider=s3&tenantId=${SYSTEM_TENANT_ID}`, {
        headers: { 'X-Service-Token': INTERNAL_ACCESS_TOKEN },
      });
      expect(resp.status()).toBe(200);

      const body = (await resp.json()) as { outcome: string; baseUrl?: string; funding?: string; source?: string; extras?: Record<string, unknown> };
      // `absent` means "pull anonymously" to `apps/stt` — correct for a public
      // Hugging Face repo, wrong for a private weights bucket.
      expect(body.outcome, 'the platform weight store must resolve, not report "no opinion"').toBe('resolved');
      expect(body.source).toBe('platform-storage');
      expect(body.funding).toBe('platform');
      expect(body.baseUrl, 'the fetcher needs an endpoint it can address').toBeTruthy();
      expect(body.extras?.accessKeyId, 'the non-secret half of the S3 pair travels in extras').toBeTruthy();
    });

    test('an invalid service token is rejected 401 (fail-closed)', async ({ request }) => {
      const resp = await request.get(`/api/v1/internal/model-registry-credential?service=stt&provider=s3&tenantId=${SYSTEM_TENANT_ID}`, {
        headers: { 'X-Service-Token': 'definitely-not-the-secret' },
      });
      expect(resp.status()).toBe(401);
    });
  });
});
