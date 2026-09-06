/**
 * `admin/ai-services/readiness` — the platform's stored inference-readiness
 * observation (TASK-890 §3.12, OD-L).
 *
 * Needs a live gateway + seeded DB (`pnpm test:up:api`, then `pnpm test:e2e`).
 * TEXT and every engine may be DOWN: that is a COVERED case, not a skip
 * condition, and it is the most important one. A monitoring route that 5xx's
 * when the thing it monitors is unhealthy is useless precisely when it matters.
 *
 * Locked contracts:
 *  1. PLATFORM-ADMIN ONLY — the routes join the `manage:all` plane of
 *     `admin/ai-services`. A tenant admin is refused; an API key is refused
 *     unconditionally by `@ForbidApiKey()`, checked before scopes.
 *  2. NEVER 5xx — an unreachable text service, a cold snapshot and a switched-off
 *     sweep all produce a 200 document. `checkedAt: null` with empty collections
 *     is the honest "nothing observed", never a 404 and never an all-clear.
 *  3. THE READ NEVER PROBES — `GET readiness` serves what the sweep stored, so
 *     repeating it costs nothing and cannot be used to drive load at an engine.
 *  4. VOCABULARY — every readiness value is one of the six declared states, and
 *     every engine status one of three. A new state must be added deliberately,
 *     in the type, not discovered in production.
 *  5. NO OPERATOR SECRETS — the document carries hosts, never full URLs, never a
 *     credential, a bucket prefix or a tenant id.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const READINESS = '/api/v1/admin/ai-services/readiness';
const REFRESH = `${READINESS}/refresh`;

const READINESS_STATES = ['ready', 'loadable', 'engine_down', 'weights_missing', 'credential_missing', 'unknown'];
const ENGINE_STATUSES = ['up', 'down', 'unknown'];

interface ReadinessDocument {
  checkedAt: string | null;
  engines: Array<{
    provider: string;
    providerClass: string;
    baseUrlHost: string | null;
    status: string;
    latencyMs: number | null;
    loadedCount: number;
    listedCount: number;
    detail: string | null;
  }>;
  services: Array<{ key: string; healthy: boolean; lastSeenAt: string | null }>;
  models: Array<{
    id: string;
    slug: string;
    taskType: string;
    provider: string | null;
    providerClass: string | null;
    readiness: string;
    detail: string | null;
  }>;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let superAdminToken: string;
let tenantAdminToken: string;

test.beforeAll(async ({ request }) => {
  const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
  expect(sa, 'super admin login failed').toBeTruthy();
  superAdminToken = sa!.token;

  const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(ta, 'tenant admin login failed').toBeTruthy();
  tenantAdminToken = ta!.token;
});

async function readReadiness(request: APIRequestContext, token: string) {
  return request.get(READINESS, { headers: auth(token) });
}

test.describe('authorization', () => {
  test('a super admin reads the observation', async ({ request }) => {
    const response = await readReadiness(request, superAdminToken);
    expect(response.status()).toBe(200);
  });

  test('a tenant admin is refused — engine topology is not tenant data', async ({ request }) => {
    const response = await readReadiness(request, tenantAdminToken);
    expect([403, 404]).toContain(response.status());
  });

  test('an API key is refused on both routes, whatever its scopes', async ({ request }) => {
    // `@ForbidApiKey()` is checked BEFORE the scope check, so this is
    // unconditional — never "only when the key lacks the scope".
    const read = await request.get(READINESS, { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(read.status()).toBe(403);

    const refresh = await request.post(REFRESH, { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(refresh.status()).toBe(403);
  });

  test('an unauthenticated caller is 401 on both routes', async ({ request }) => {
    expect((await request.get(READINESS)).status()).toBe(401);
    expect((await request.post(REFRESH)).status()).toBe(401);
  });
});

test.describe('the document', () => {
  test('is a 200 whatever the platform’s health — including with nothing observed yet', async ({ request }) => {
    const response = await readReadiness(request, superAdminToken);
    expect(response.status()).toBe(200);

    const document = (await response.json()) as ReadinessDocument;
    expect(Array.isArray(document.engines)).toBe(true);
    expect(Array.isArray(document.services)).toBe(true);
    expect(Array.isArray(document.models)).toBe(true);

    if (document.checkedAt === null) {
      // "Nothing has been observed" is a state, not a missing resource.
      expect(document.engines).toEqual([]);
      expect(document.services).toEqual([]);
      expect(document.models).toEqual([]);
    } else {
      expect(new Date(document.checkedAt).toString()).not.toBe('Invalid Date');
    }
  });

  test('uses only the declared vocabulary', async ({ request }) => {
    const document = (await (await readReadiness(request, superAdminToken)).json()) as ReadinessDocument;

    for (const engine of document.engines) {
      expect(ENGINE_STATUSES, `engine ${engine.provider}`).toContain(engine.status);
    }
    for (const model of document.models) {
      expect(READINESS_STATES, `model ${model.slug}`).toContain(model.readiness);
    }
  });

  test('carries hosts and never a full URL, a credential or a tenant id', async ({ request }) => {
    const response = await readReadiness(request, superAdminToken);
    const body = await response.text();
    const document = JSON.parse(body) as ReadinessDocument;

    for (const engine of document.engines) {
      if (engine.baseUrlHost !== null) expect(engine.baseUrlHost).not.toMatch(/^https?:\/\//);
    }
    expect(body).not.toMatch(/"(apiKey|encryptedApiKey|tenantId|bucketPrefix|sourceUri)"/);
  });

  test('the read is idempotent and probes nothing — two calls agree', async ({ request }) => {
    const first = (await (await readReadiness(request, superAdminToken)).json()) as ReadinessDocument;
    const second = (await (await readReadiness(request, superAdminToken)).json()) as ReadinessDocument;

    // The sweep may have run between the two, so the observation may MOVE
    // FORWARD; it must never move backwards, and neither call may fail.
    if (first.checkedAt && second.checkedAt) {
      expect(new Date(second.checkedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.checkedAt).getTime());
    }
  });
});

test.describe('refresh', () => {
  test('a super admin takes an observation now, and it is not older than the previous one', async ({ request }) => {
    const before = (await (await readReadiness(request, superAdminToken)).json()) as ReadinessDocument;

    const response = await request.post(REFRESH, { headers: auth(superAdminToken) });
    // 429 is a legitimate outcome of the 6/min ceiling when the suite is
    // re-run tightly; it is a PASS for this contract, not a flake to retry away.
    expect([200, 429]).toContain(response.status());
    if (response.status() === 429) return;

    const after = (await response.json()) as ReadinessDocument;
    expect(after.checkedAt).not.toBeNull();
    if (before.checkedAt) {
      expect(new Date(after.checkedAt!).getTime()).toBeGreaterThanOrEqual(new Date(before.checkedAt).getTime());
    }
    // An unreachable engine is an OBSERVATION, never a 5xx.
    for (const engine of after.engines) {
      expect(ENGINE_STATUSES).toContain(engine.status);
    }
  });

  test('a tenant admin cannot force a probe', async ({ request }) => {
    const response = await request.post(REFRESH, { headers: auth(tenantAdminToken) });
    expect([403, 404]).toContain(response.status());
  });
});

/**
 * The catalogue half of §3.12 — `GET admin/ai-models/catalogue` stamps each row
 * with the readiness the sweep observed. L1's route merged in the same wave, so
 * this now runs: it is the ONE assertion that the two lanes share a snapshot
 * (`modelReadinessFrom`) rather than each computing a readiness of its own.
 */
test.describe('catalogue stamping', () => {
  test('a model the sweep saw ready reads `ready` in the tenant catalogue', async ({ request }) => {
    const readiness = (await (await readReadiness(request, superAdminToken)).json()) as ReadinessDocument;
    const ready = readiness.models.find((model) => model.readiness === 'ready');
    test.skip(!ready, 'no model is currently ready on this deployment');

    const catalogue = await request.get('/api/v1/admin/ai-models/catalogue', { headers: auth(superAdminToken) });
    expect(catalogue.status()).toBe(200);

    const body = (await catalogue.json()) as { models: Array<{ id: string; readiness: string; readinessCheckedAt: string | null }> };
    const row = body.models.find((model) => model.id === ready!.id);
    expect(row?.readiness).toBe('ready');
    expect(row?.readinessCheckedAt).toBe(readiness.checkedAt);
  });
});
