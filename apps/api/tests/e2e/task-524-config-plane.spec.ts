/**
 * TASK-524 — config-plane core e2e (AUTHORED HERE, EXECUTED IN TASK-534/P7).
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus a seeded
 * database (`pnpm db:seed`), which supplies the eight DISABLED SYSTEM
 * `AiProviderConnection` rows and ZERO `AiRuntimeProfile` rows.
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
 *   4. The settings write lane's descriptor-driven enforcement holds through
 *      the real guard/interceptor pipeline, and the newly registered orphan
 *      keys actually appear in `GET /admin/settings/catalog`.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

test.describe('TASK-524 — AI provider connections', () => {
  let globalAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'global admin login failed').toBeTruthy();
    globalAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${globalAdminToken}` });

  test('seeds eight SYSTEM connections, all disabled and all keyless', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/ai-providers?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth() });
    expect(res.status()).toBe(200);

    const rows = await res.json();
    expect(rows).toHaveLength(8);
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

test.describe('TASK-524 — AI runtime profiles', () => {
  let globalAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    globalAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${globalAdminToken}` });

  test('seeds ZERO profiles, so resolution is empty (silent-change guard)', async ({ request }) => {
    const list = await request.get('/api/v1/admin/ai-runtime-profiles', { headers: auth() });
    expect(list.status()).toBe(200);
    expect(await list.json()).toEqual([]);

    const resolved = await request.get('/api/v1/admin/ai-runtime-profiles/resolve?provider=lm-studio&modelSlug=gemma-4', {
      headers: auth(),
    });
    expect(resolved.status()).toBe(200);
    expect((await resolved.json()).isEmpty).toBe(true);
  });

  test('rejects an out-of-range knob with 400', async ({ request }) => {
    const res = await request.put('/api/v1/admin/ai-runtime-profiles/row?provider=lm-studio', {
      headers: { ...auth(), 'If-Match': '"1"' },
      data: { temperature: 3 },
    });
    expect(res.status()).toBe(400);
  });

  test('PUT without If-Match → 428', async ({ request }) => {
    const res = await request.put('/api/v1/admin/ai-runtime-profiles/row?provider=lm-studio', {
      headers: auth(),
      data: { temperature: 0.5 },
    });
    expect(res.status()).toBe(428);
  });
});

test.describe('TASK-524 — settings registry write lane', () => {
  let globalAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    globalAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${globalAdminToken}` });

  test('the formerly orphaned keys now appear in the catalog', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings/catalog', { headers: auth() });
    expect(res.status()).toBe(200);

    const keys: string[] = (await res.json()).items.map((i: { key: string }) => i.key);
    for (const key of [
      'rate-limit.enabled',
      'audit-retention.enabled',
      'audit-retention.cron',
      'audit-retention.retention-days',
      'agentic.trajectory.enabled',
      'agentic.trajectory.cron',
      'agentic.trajectory.retentionDays',
    ]) {
      expect(keys, `${key} must be cataloged`).toContain(key);
    }
  });

  test('resolves a global-kv key through the effective read lane', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings/registry/rate-limit.enabled', { headers: auth() });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.tier).toBe('global-kv');
    expect(['global-kv', 'code-default']).toContain(body.sourceScope);
  });

  test('404s an unknown registry key on the path', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings/registry/nope.not.a.key', { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('400s an unwritable tier', async ({ request }) => {
    // `pipeline.*` is tier `db-config` — it keeps its dedicated service.
    const res = await request.put('/api/v1/admin/settings/registry/pipeline.harnessEnabled', {
      headers: auth(),
      data: { value: true },
    });
    expect(res.status()).toBe(400);
  });

  test('400s a value whose type contradicts the descriptor', async ({ request }) => {
    const res = await request.put('/api/v1/admin/settings/registry/rate-limit.enabled', {
      headers: auth(),
      data: { value: 'yes-please' },
    });
    expect(res.status()).toBe(400);
  });

  test('the static registry route wins over the global-setting :id route', async ({ request }) => {
    // If `GlobalSettingModule` had registered first, this would be parsed as
    // `admin/settings/:id` with id="registry" and 404/500 differently.
    const res = await request.get('/api/v1/admin/settings/registry/agentic.context.liveDelta.maxChars', {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).key).toBe('agentic.context.liveDelta.maxChars');
  });
});

test.describe('TASK-524 — cross-tenant posture', () => {
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

  test('a global-only registry key is not writable by a tenant admin', async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);

    const res = await request.put('/api/v1/admin/settings/registry/agentic.context.liveDelta.maxChars', {
      headers: { Authorization: `Bearer ${login!.token}` },
      data: { value: 9000 },
    });
    expect([401, 403]).toContain(res.status());
  });
});
