/**
 * business-plane URI normalization, verified over real HTTP.
 *
 * Two things are under test and they pull in opposite directions:
 *
 *  1. Every renamed route answers at its NEW URI, and every RETIRED URI
 *     answers **308 Permanent Redirect** with a `Location` pointing at the new
 *     one. 308 specifically: 301 and 302 permit a client to rewrite a POST
 *     into a GET, which silently drops the body — a summarization POST would
 *     arrive at the new path as an empty GET. Asserting "a 3xx" would let that
 *     regression through, so the exact code is asserted.
 *
 *  2. The v1 COMPAT surfaces (`api/smr/api/v1`, `api/stt`, `ws /stt`) are
 *     FENCED OUT of this ticket. They are frozen wire contracts with their own
 *     deprecation ticket. The fence describe below is green today and must
 *     stay green — it is the one block here that must never turn red.
 *
 * Every request that probes a redirect sets `maxRedirects: 0`; Playwright
 * follows redirects by default, which would make a shim indistinguishable from
 * a route that never moved.
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

// ─── The retired URIs answer 308 ─────────────────────────────────────────

interface Shim {
  method: 'get' | 'post' | 'patch' | 'delete';
  from: string;
  to: string;
}

const SHIMS: Shim[] = [
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

test.describe('every retired URI answers 308 with a Location', () => {
  for (const shim of SHIMS) {
    test(`${shim.method.toUpperCase()} ${shim.from} → 308 ${shim.to}`, async ({ request }) => {
      // A shim copies its target's auth posture verbatim, INCLUDING the CASL
      // ability — so it answers 403 to a caller who could not perform the write
      // at the new path either. That is the same answer the target gives, but it
      // means the 308 contract can only be observed by an authorised caller.
      // `PATCH tenants/me/config` needs `update:Tenant`, which a DOCTOR lacks.
      const response = await request[shim.method](shim.from, {
        headers: bearer(shim.asTenantAdmin ? tenantAdminToken : doctorToken),
        maxRedirects: 0,
        ...(shim.method === 'get' ? {} : { data: {} }),
      });

      expect(response.status(), `${shim.from} must answer 308 — 301/302 would let a client drop the request body`).toBe(308);
      expect(response.headers()['location']).toBe(shim.to);
    });
  }

  test('a shim preserves the query string verbatim', async ({ request }) => {
    const response = await request.get(`${V1}/tenant/me/context-schema?departmentId=dep-1&x=a%20b`, {
      headers: bearer(doctorToken),
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);
    expect(response.headers()['location']).toBe(`${V1}/tenants/me/context-schema?departmentId=dep-1&x=a%20b`);
  });

  test('a shim preserves a path parameter verbatim', async ({ request }) => {
    const response = await request.patch(`${V1}/voice-profile/1d0b0f1e-0000-4000-8000-000000000001/activate`, {
      headers: bearer(doctorToken),
      data: {},
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);
    expect(response.headers()['location']).toBe(`${V1}/voice-profiles/1d0b0f1e-0000-4000-8000-000000000001/activate`);
  });

  test('a shim never becomes a cheaper way in: an unauthenticated call 401s AT the shim', async ({ request }) => {
    for (const path of [`${V1}/user/me/settings`, `${V1}/tenant/me`, `${V1}/entitlements/me`, `${V1}/voice-profile`]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} redirected an anonymous caller instead of rejecting it`).toBe(401);
    }
  });

  test('a shim never becomes a cheaper way in: an unauthenticated POST 401s AT the shim', async ({ request }) => {
    const response = await request.post(`${V1}/rbac/check/my-permissions`, { data: {}, maxRedirects: 0 });
    expect(response.status()).toBe(401);
  });
});

// ─── Scope fence — must never turn red ───────────────────────────────────

test.describe(' scope fence — the frozen v1 compat surfaces are untouched', () => {
  test('POST /api/smr/api/v1/presummary still resolves at its exact path and is NOT redirected', async ({ request }) => {
    // This fence only proves ROUTING (not 404, not redirected), but the compat
    // route accepts `{}` and performs a REAL summarization behind it — ~6.5s
    // idle, and well past the 30s global timeout once the whole suite is
    // hammering apps/text in parallel. Raised per the house pattern
    // (`task-709-note-occ.spec.ts:189`, added by for the same cause:
    // a genuine summarization measured at 34.6s against the 30s default).
    test.setTimeout(180_000);

    const response = await request.post('/api/smr/api/v1/presummary', {
      headers: bearer(doctorToken),
      data: {},
      maxRedirects: 0,
    });
    expect(response.status(), 'the TEXT compat prefix must not 404').not.toBe(404);
    expect([301, 302, 307, 308]).not.toContain(response.status());
  });

  test('POST /api/stt/start_session still resolves at its exact path and is NOT redirected', async ({ request }) => {
    const response = await request.post('/api/stt/start_session', {
      headers: bearer(doctorToken),
      data: {},
      maxRedirects: 0,
    });
    expect(response.status(), 'the STT compat prefix must not 404').not.toBe(404);
    expect([301, 302, 307, 308]).not.toContain(response.status());
  });

  test('the ws /stt handshake path is not shadowed by any HTTP route this ticket added', async ({ request }) => {
    // A plain GET on the gateway's WS path must NOT be answered by a redirect
    // shim: `ws /stt` is a frozen handshake, and a 308 there would break a
    // client that upgrades rather than follows.
    const response = await request.get('/stt', { maxRedirects: 0 });
    expect([301, 302, 307, 308]).not.toContain(response.status());
  });
});
