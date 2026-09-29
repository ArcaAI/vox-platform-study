/**
 * TASK-1019 Lane S — "Test connection" must not become a way for a tenant admin
 * to send the PLATFORM credential to a host of its choosing.
 *
 * Two contracts, over real HTTP:
 *  - a platform-only plane (`model-registry`, the built-in engines) is 404 to a
 *    tenant on the probe route exactly as on the read route;
 *  - a cloud provider the tenant has no row for falls back to the platform key,
 *    and then the body may not name the endpoint: either 400
 *    `PLATFORM_KEY_ENDPOINT_LOCKED`, or (no platform key seeded) a probe that did
 *    not run on the platform key. The leak signature is `source: 'platform'`
 *    with a caller-chosen `baseUrl`, and that must never come back.
 *
 * Live-stack requirement: `pnpm test:up:api` against a seeded database.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/providers';
const FOREIGN_HOST = 'https://example.invalid';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

test.describe('TASK-1019 — the platform key never leaves for a tenant-chosen host', () => {
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed').toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test('a tenant probe of the model registry is 404 for both providers, with or without a baseUrl', async ({ request }) => {
    for (const provider of ['huggingface', 's3']) {
      for (const data of [{}, { baseUrl: FOREIGN_HOST }]) {
        const resp = await request.post(`${BASE}/model-registry/${provider}/test`, { headers: auth(tenantAdminToken), data });
        expect(resp.status(), `model-registry/${provider}/test ${JSON.stringify(data)}`).toBe(404);
      }
    }
  });

  test('a tenant probe of a built-in engine is 404', async ({ request }) => {
    const resp = await request.post(`${BASE}/llm/lm-studio/test`, { headers: auth(tenantAdminToken), data: { baseUrl: FOREIGN_HOST } });
    expect(resp.status()).toBe(404);
  });

  // `apiKey: null` passes the validation pipe (IsOptional skips null) and a
  // whitespace key passes MinLength(1); both clean to "no key" and so fall back
  // to the platform key exactly like an absent one — they must not unlock the
  // endpoint either (final review C2).
  const bodies: Array<[string, Record<string, unknown>]> = [
    ['no apiKey', { baseUrl: FOREIGN_HOST }],
    ['apiKey: null', { apiKey: null, baseUrl: FOREIGN_HOST }],
    ['whitespace apiKey', { apiKey: '   ', baseUrl: FOREIGN_HOST }],
  ];
  for (const [label, data] of bodies) {
    test(`a cloud probe that would fall back to the platform key refuses a body baseUrl (${label})`, async ({ request }) => {
      const resp = await request.post(`${BASE}/llm/openai/test`, { headers: auth(tenantAdminToken), data });
      if (resp.status() === 400) {
        expect(JSON.stringify(await resp.json())).toContain('PLATFORM_KEY_ENDPOINT_LOCKED');
        return;
      }
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body.source, 'the platform key was presented to a caller-chosen host').not.toBe('platform');
    });
  }
});
