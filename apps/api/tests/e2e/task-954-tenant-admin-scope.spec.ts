/**
 * TASK-954 — the tenant admin's console scope, over real HTTP.
 *
 * Two gateway contracts only a live, seeded stack can settle:
 *
 *  1. `GET admin/providers/:service/platform-defaults` — the platform fallback
 *     a TENANT inherits, read-only. A tenant admin reads its own (200, one
 *     entry per cloud provider, SYSTEM-owned, masked — never key material —
 *     each with the cascade's verdict); a foreign tenant is 403; the platform
 *     tier itself is 400 (top of the cascade); a super admin reads what a
 *     working tenant inherits via `?tenantId=`.
 *
 *  2. `GET admin/settings` — a non-elevated caller's row list carries no
 *     `locked` platform default (it could not change one anyway), while a
 *     super admin acting on the same tenant through `X-Tenant-Id` still lists
 *     them: the exclusion is a privilege rule, not a scope rule.
 *
 * Live-stack requirement: `pnpm test:up:api` against a seeded database.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const PROVIDERS = '/api/v1/admin/providers';
const SETTINGS = '/api/v1/admin/settings';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const LLM_CLOUD_PROVIDERS = ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'];
const RESOLUTIONS = ['inherited', 'overridden', 'vetoed', 'not-entitled', 'not-configured', 'off'];

interface PlatformDefaultConnection {
  tenantId: string;
  service: string;
  provider: string;
  hasKey: boolean;
  enabled: boolean;
  version: number;
  resolution: string;
}
interface PlatformDefaults {
  service: string;
  tenantId: string;
  entitled: boolean;
  connections: PlatformDefaultConnection[];
}
interface SettingRow {
  id: string;
  key: string;
  locked: boolean;
  tenantId?: string | null;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

test.describe('TASK-954 — the platform fallback a tenant inherits, read-only', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let tenantAdminTenantId: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(sa, 'super admin login failed').toBeTruthy();
    superAdminToken = sa!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed').toBeTruthy();
    tenantAdminToken = ta!.token;
    tenantAdminTenantId = ta!.user.tenantId;
  });

  test('a tenant admin reads one masked, SYSTEM-owned entry per cloud provider, each with a verdict', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/llm/platform-defaults`, { headers: auth(tenantAdminToken) });
    expect(resp.status()).toBe(200);

    const body = (await resp.json()) as PlatformDefaults;
    expect(body.service).toBe('llm');
    expect(body.tenantId).toBe(tenantAdminTenantId);
    expect(typeof body.entitled).toBe('boolean');
    expect(body.connections.map((c) => c.provider)).toEqual(LLM_CLOUD_PROVIDERS);
    for (const connection of body.connections) {
      expect(connection.tenantId, `${connection.provider} is the platform row`).toBe(SYSTEM_TENANT_ID);
      expect(RESOLUTIONS, `${connection.provider} carries a verdict`).toContain(connection.resolution);
      expect(typeof connection.hasKey).toBe('boolean');
    }
  });

  test('never returns key material (raw-body assertion)', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/llm/platform-defaults`, { headers: auth(tenantAdminToken) });
    expect(resp.status()).toBe(200);
    const raw = await resp.text();
    expect(raw).not.toContain('encryptedApiKey');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('vault:');
  });

  test('never lists a platform-managed engine or the model registry — platform infrastructure stays platform-only', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/llm/platform-defaults`, { headers: auth(tenantAdminToken) });
    const body = (await resp.json()) as PlatformDefaults;
    for (const provider of ['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp', 'built-in']) {
      expect(
        body.connections.some((c) => c.provider === provider),
        `${provider} must not reach a tenant`,
      ).toBe(false);
    }
  });

  test('a tenant admin asking for another tenant — including SYSTEM — is 403', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/llm/platform-defaults?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth(tenantAdminToken) });
    expect(resp.status()).toBe(403);
  });

  test('the platform tier itself is 400 for a super admin — it is the top of the cascade', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/llm/platform-defaults?tenantId=${SYSTEM_TENANT_ID}`, { headers: auth(superAdminToken) });
    expect(resp.status()).toBe(400);
  });

  test('a super admin reads what a working tenant inherits via ?tenantId=', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/stt/platform-defaults?tenantId=${tenantAdminTenantId}`, { headers: auth(superAdminToken) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as PlatformDefaults;
    expect(body.tenantId).toBe(tenantAdminTenantId);
    expect(body.service).toBe('stt');
    expect(body.connections.length).toBeGreaterThan(0);
  });

  test('an unknown service segment is 400', async ({ request }) => {
    const resp = await request.get(`${PROVIDERS}/not-a-service/platform-defaults`, { headers: auth(tenantAdminToken) });
    expect(resp.status()).toBe(400);
  });

  test('the static segment is not captured as a provider read on the tier that would 404 it', async ({ request }) => {
    // Before the route existed, `platform-defaults` fell into `:service/:provider`
    // and answered "no such row" (404). A 200 here pins the declaration order.
    const resp = await request.get(`${PROVIDERS}/tts/platform-defaults`, { headers: auth(tenantAdminToken) });
    expect(resp.status()).toBe(200);
  });
});

test.describe('TASK-954 — a tenant admin lists only the settings rows it can change', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let tenantAdminTenantId: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    superAdminToken = sa!.token;
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    tenantAdminToken = ta!.token;
    tenantAdminTenantId = ta!.user.tenantId;
  });

  test('no locked row reaches a tenant admin, on the plain list or with the secrets facet', async ({ request }) => {
    for (const query of ['?limit=200', '?limit=200&secretsOnly=false']) {
      const resp = await request.get(`${SETTINGS}${query}`, { headers: auth(tenantAdminToken) });
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as { data: SettingRow[]; count: number };
      expect(body.data.length, 'the tenant still sees its own unlocked rows').toBeGreaterThan(0);
      for (const row of body.data) {
        expect(row.locked, `${row.key} is locked and must not be listed for a tenant admin`).toBe(false);
        expect(row.tenantId).toBe(tenantAdminTenantId);
      }
      expect(body.count, 'the count agrees with the filtered page').toBe(body.data.length);
    }
  });

  test('a super admin acting on the same tenant still lists the locked rows — privilege, not scope', async ({ request }) => {
    const resp = await request.get(`${SETTINGS}?limit=200`, { headers: { ...auth(superAdminToken), 'X-Tenant-Id': tenantAdminTenantId } });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { data: SettingRow[] };
    expect(body.data.every((row) => row.tenantId === tenantAdminTenantId)).toBe(true);
    // The seed ships locked platform defaults in every customer tenant
    // (`stt/*`, `ux-constants/*`); the super admin is the caller who may edit them.
    expect(
      body.data.some((row) => row.locked),
      'the seeded locked rows are visible to a super admin',
    ).toBe(true);
  });
});
