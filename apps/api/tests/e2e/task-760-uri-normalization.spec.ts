/**
 * business-plane URI normalization, verified over real HTTP.
 *
 * Two things are under test and they pull in opposite directions:
 *
 *  1. Every renamed route answers at its NEW URI, and every RETIRED URI
 *     answers **404**. Until TASK-1012 (D-3) a retired URI answered a 308
 *     Permanent Redirect from a shim marked `DELETE IN ALL-2.0.0`; the shims
 *     are deleted, so a retired prefix is now simply not a route. A 308 (or any
 *     3xx) here would mean a shim came back.
 *
 *  2. The v1 COMPAT surfaces (`api/smr/api/v1`, `api/stt`, `ws /stt`) were
 *     removed outright by TASK-1004 (zero traffic, no consumers). The block
 *     below now asserts the opposite of what it asserted before that ticket:
 *     each retired path answers 404, not a redirect and not a live route.
 *
 * Every request that probes a retired URI sets `maxRedirects: 0`; Playwright
 * follows redirects by default, which would hide a resurrected shim behind the
 * route it redirects to.
 */
import { expect, test } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const V1 = '/api/v1';

let tenantAdminToken: string;
let doctorToken: string;

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

test.beforeAll(async ({ request }) => {
  const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(tenantAdmin, 'tenant_admin login failed').toBeTruthy();
  tenantAdminToken = tenantAdmin!.token;

  const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
  expect(doctor, 'doctor login failed').toBeTruthy();
  doctorToken = doctor!.token;
});

// ─── The new URIs resolve ────────────────────────────────────────────────

test.describe('the normalized URIs answer', () => {
  const reads: [string, string][] = [
    ['user self plane — preferences', `${V1}/users/me/preferences`],
    ['user self plane — settings', `${V1}/users/me/settings`],
    ['user self plane — departments', `${V1}/users/me/departments`],
    ['tenant self plane — identity', `${V1}/tenants/me`],
    ['tenant self plane — config', `${V1}/tenants/me/config`],
    ['tenant self plane — context schema', `${V1}/tenants/me/context-schema`],
    ['tenant self plane — entitlements', `${V1}/tenants/me/entitlements`],
    ['tenant self plane — invoices', `${V1}/tenants/me/invoices`],
    ['tenant self plane — spend', `${V1}/tenants/me/spend`],
    ['tenant self plane — usage summary', `${V1}/tenants/me/usage-summary`],
    ['tenant self plane — usage burndown', `${V1}/tenants/me/usage-burndown`],
    ['voice profiles (plural)', `${V1}/voice-profiles`],
  ];

  for (const [name, path] of reads) {
    test(`GET ${path} (${name}) resolves — not 404, not 405`, async ({ request }) => {
      const response = await request.get(path, { headers: bearer(tenantAdminToken), maxRedirects: 0 });
      expect(response.status(), `${path} did not resolve`).not.toBe(404);
      expect(response.status(), `${path} resolved to the wrong verb`).not.toBe(405);
      // A shim would answer here; the target must not.
      expect(response.status(), `${path} is itself redirecting — it should be the target`).not.toBe(308);
    });
  }

  test('POST /users/me/permission-checks returns the caller effective permission set', async ({ request }) => {
    const response = await request.post(`${V1}/users/me/permission-checks`, { headers: bearer(doctorToken), maxRedirects: 0 });
    expect([200, 201]).toContain(response.status());
    const body = await response.json();
    expect(body).toHaveProperty('permissions');
    expect(Array.isArray(body.permissions)).toBe(true);
  });

  test('POST /users/:id/permission-checks checks a named user', async ({ request }) => {
    const payload = JSON.parse(Buffer.from(doctorToken.split('.')[1], 'base64url').toString('utf8')) as { sub?: string; id?: string };
    const userId = payload.sub ?? payload.id!;
    const response = await request.post(`${V1}/users/${userId}/permission-checks`, {
      headers: bearer(doctorToken),
      data: { action: 'create', subject: 'ApiKey' },
      maxRedirects: 0,
    });
    expect([200, 201]).toContain(response.status());
    expect(await response.json()).toHaveProperty('allowed');
  });

  test('the `speech` prefix did NOT move (decision D-3) — it is a capability, not the apps/tts service name', async ({ request }) => {
    const response = await request.get(`${V1}/speech/voices`, { headers: bearer(tenantAdminToken), maxRedirects: 0 });
    expect(response.status()).not.toBe(404);
    expect(response.status()).not.toBe(308);
  });
});

// ─── The retired URIs answer 404 (TASK-1012 D-3 — the 308 shims are gone) ──

interface RetiredUri {
  method: 'get' | 'post' | 'patch' | 'delete';
  from: string;
  /** The URI that replaced it — documentation only; nothing redirects there any more. */
  to: string;
  asTenantAdmin?: boolean;
}

const RETIRED: RetiredUri[] = [
  { method: 'get', from: `${V1}/user/me/preferences`, to: `${V1}/users/me/preferences` },
  { method: 'patch', from: `${V1}/user/me/preferences`, to: `${V1}/users/me/preferences` },
  { method: 'get', from: `${V1}/user/me/settings`, to: `${V1}/users/me/settings` },
  { method: 'patch', from: `${V1}/user/me/settings/arcaai-sdk/probe`, to: `${V1}/users/me/settings/arcaai-sdk/probe` },
  { method: 'get', from: `${V1}/user/me/departments`, to: `${V1}/users/me/departments` },
  { method: 'get', from: `${V1}/tenant/me`, to: `${V1}/tenants/me` },
  { method: 'get', from: `${V1}/tenant/me/config`, to: `${V1}/tenants/me/config` },
  { method: 'patch', from: `${V1}/tenant/me/config`, to: `${V1}/tenants/me/config`, asTenantAdmin: true },
  { method: 'get', from: `${V1}/tenant/me/context-schema`, to: `${V1}/tenants/me/context-schema` },
  { method: 'get', from: `${V1}/entitlements/me`, to: `${V1}/tenants/me/entitlements` },
  { method: 'get', from: `${V1}/billing/me/invoices`, to: `${V1}/tenants/me/invoices` },
  { method: 'get', from: `${V1}/billing/me/spend`, to: `${V1}/tenants/me/spend` },
  { method: 'get', from: `${V1}/usage/me/summary`, to: `${V1}/tenants/me/usage-summary` },
  { method: 'get', from: `${V1}/usage/me/burndown`, to: `${V1}/tenants/me/usage-burndown` },
  { method: 'get', from: `${V1}/voice-profile`, to: `${V1}/voice-profiles` },
  { method: 'post', from: `${V1}/rbac/check/my-permissions`, to: `${V1}/users/me/permission-checks` },
  { method: 'post', from: `${V1}/ai/guardrail/analyze`, to: `${V1}/safety-checks` },
  { method: 'post', from: `${V1}/ai/nlp/entities`, to: `${V1}/text-analyses/entities` },
  { method: 'post', from: `${V1}/ai/nlp/diagnosis`, to: `${V1}/text-analyses/diagnosis` },
  { method: 'post', from: `${V1}/ai/nlp/topic`, to: `${V1}/text-analyses/topic` },
  { method: 'post', from: `${V1}/ai/nlp/intent`, to: `${V1}/text-analyses/intent` },
  { method: 'post', from: `${V1}/text/generate`, to: `${V1}/text-generations/generate` },
  { method: 'post', from: `${V1}/text/generate/assembled`, to: `${V1}/text-generations/generate/assembled` },
  { method: 'get', from: `${V1}/text/providers`, to: `${V1}/text-generations/providers` },
  { method: 'get', from: `${V1}/text/guardrail-providers`, to: `${V1}/text-generations/guardrail-providers` },
  { method: 'get', from: `${V1}/text/tasks/t-1`, to: `${V1}/text-generations/tasks/t-1` },
  { method: 'post', from: `${V1}/text/tasks/t-1/cancel`, to: `${V1}/text-generations/tasks/t-1/cancel` },
  { method: 'get', from: `${V1}/text/tasks/t-1/stream`, to: `${V1}/text-generations/tasks/t-1/stream` },
];

test.describe('every retired URI answers 404 — removed, not redirected', () => {
  for (const retired of RETIRED) {
    test(`${retired.method.toUpperCase()} ${retired.from} → 404 (was 308 → ${retired.to})`, async ({ request }) => {
      const response = await request[retired.method](retired.from, {
        headers: bearer(retired.asTenantAdmin ? tenantAdminToken : doctorToken),
        maxRedirects: 0,
        ...(retired.method === 'get' ? {} : { data: {} }),
      });

      expect(response.status(), `${retired.from} must be gone — a 3xx means a redirect shim came back`).toBe(404);
      expect(response.headers()['location']).toBeUndefined();
    });
  }

  test('an anonymous caller is not redirected anywhere either', async ({ request }) => {
    for (const path of [`${V1}/user/me/settings`, `${V1}/tenant/me`, `${V1}/entitlements/me`, `${V1}/voice-profile`]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} answered ${response.status()}`).not.toBe(308);
      expect(response.status()).toBeGreaterThanOrEqual(400);
    }
  });
});

// ─── Compat removal — TASK-1004 ──────────────────────────────────────────

test.describe(' the removed v1 compat surfaces answer 404', () => {
  test('POST /api/smr/api/v1/presummary is gone', async ({ request }) => {
    const response = await request.post('/api/smr/api/v1/presummary', {
      headers: bearer(doctorToken),
      data: {},
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });

  test('POST /api/stt/start_session is gone', async ({ request }) => {
    const response = await request.post('/api/stt/start_session', {
      headers: bearer(doctorToken),
      data: {},
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });

  test('the ws /stt handshake path is gone', async ({ request }) => {
    const response = await request.get('/stt', { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });
});
