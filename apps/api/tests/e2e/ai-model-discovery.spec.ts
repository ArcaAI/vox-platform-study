/**
 * `admin/ai-models/discovery` (merge view) and
 * `admin/ai-models/discovery/register` (explicit register).
 *
 * The e2e job needs a live
 * gateway + seeded DB (`pnpm test:api:up`, then `pnpm test:e2e`); TEXT itself may
 * be DOWN — that is a covered case, not a skip condition, because a failed probe
 * must degrade the response, never 5xx it.
 *
 * Locked contracts:
 *  1. GLOBAL-ADMIN ONLY — the discovery routes join the `manage:all` registry
 *     plane. A tenant admin is refused (403/404, never 200 with data).
 *  2. NEVER 5xx ON A DEAD ENGINE — with TEXT or an engine unreachable the merge
 *     still returns 200 and degrades the affected provider's rows to
 *     `registered` / `loadState: unknown`; a `registered-missing-on-server` tag
 *     must never appear for a provider whose probe did not succeed.
 *  3. DISCOVERY NEVER MUTATES — repeating GET discovery leaves the registry row
 *     count unchanged; only `POST discovery/register` creates.
 *  4. REGISTER VALIDATION — cloud/unknown providers are rejected (400), a
 *     duplicate slug is a 400 naming the taken slug (no silent suffixing), and
 *     undeclared body fields are rejected by the global whitelist pipe.
 *  5. CROSS-TENANT — a row created by one tenant is invisible to another; a
 *     tenant-scoped caller probing the route gets the 404-over-403 posture
 *     rather than another tenant's registry contents.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

// These tests share mutable state (the registry row count,
// `createdIds` ordering between the register and cross-tenant tests). Under the
// root config's `fullyParallel: true` they interleaved across workers and
// failed on each other's writes; run this file's tests strictly in order.
test.describe.configure({ mode: 'serial' });

const BASE = '/api/v1/admin/ai-models';
const DISCOVERY = `${BASE}/discovery`;

interface DiscoveryEntry {
  provider: string;
  modelName: string;
  status: 'registered' | 'discovered' | 'registered-missing-on-server';
  loadState: 'loaded' | 'not-loaded' | 'unknown';
  registeredModel?: { id: string; slug: string; resourceStatus: string };
  engineMeta?: Record<string, unknown>;
}

interface DiscoveryProbe {
  provider: string;
  probeStatus: 'ok' | 'timeout' | 'error' | 'skipped';
  latencyMs?: number;
  error?: string;
}

interface DiscoveryResponse {
  entries: DiscoveryEntry[];
  probes: DiscoveryProbe[];
  probedAt: string;
}

// REVISED (owner decision 2026-08-17): Ollama's provider logic stays
// available, so it is still a server-managed, discoverable engine and the DTO
// allow-list accepts it. Only its MODEL CATALOG rows were purged — which is why
// discovery matters for it: a tenant running its own Ollama has no seeded rows
// and registers what its server actually reports.
const SERVER_MANAGED = ['ollama', 'lm-studio', 'vllm', 'llama-cpp'];

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function discover(request: APIRequestContext, token: string, provider?: string) {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  return request.get(`${DISCOVERY}${qs}`, { headers: auth(token) });
}

test.describe('AI model discovery', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  const createdIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'super admin login (ARCAAI) failed').toBeTruthy();
    superAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${BASE}/${id}`, { headers: auth(superAdminToken) });
    }
  });

  // ── 1. Guard ───────────────────────────────────────────────────────────────

  test('discovery is super-admin only — a tenant admin is refused', async ({ request }) => {
    const resp = await discover(request, tenantAdminToken);
    expect([403, 404]).toContain(resp.status());
  });

  test('register is super-admin only — a tenant admin is refused', async ({ request }) => {
    const resp = await request.post(`${DISCOVERY}/register`, {
      headers: auth(tenantAdminToken),
      data: { provider: 'vllm', modelName: 'e2e-guard-probe' },
    });
    expect([403, 404]).toContain(resp.status());
  });

  test('unauthenticated callers are rejected', async ({ request }) => {
    const resp = await request.get(DISCOVERY);
    expect(resp.status()).toBe(401);
  });

  // ── 2. Merge view degrades, never 5xx ──────────────────────────────────────

  test('returns 200 with a well-formed envelope even when engines are down', async ({ request }) => {
    const resp = await discover(request, superAdminToken);
    expect(resp.status()).toBe(200);

    const body = (await resp.json()) as DiscoveryResponse;
    expect(Array.isArray(body.entries)).toBe(true);
    expect(Array.isArray(body.probes)).toBe(true);
    expect(Number.isNaN(Date.parse(body.probedAt))).toBe(false);

    for (const entry of body.entries) {
      expect(SERVER_MANAGED).toContain(entry.provider);
      expect(['registered', 'discovered', 'registered-missing-on-server']).toContain(entry.status);
      expect(['loaded', 'not-loaded', 'unknown']).toContain(entry.loadState);
    }
  });

  test('a provider whose probe failed never yields a false registered-missing-on-server', async ({ request }) => {
    const body = (await (await discover(request, superAdminToken)).json()) as DiscoveryResponse;
    const failed = new Set(body.probes.filter((p) => p.probeStatus !== 'ok').map((p) => p.provider));

    for (const entry of body.entries) {
      if (failed.has(entry.provider)) {
        expect(entry.status, `${entry.provider}/${entry.modelName} must not be tagged missing on a failed probe`).not.toBe(
          'registered-missing-on-server',
        );
        expect(entry.loadState).toBe('unknown');
      }
    }
  });

  test('the provider filter narrows the result to that provider', async ({ request }) => {
    const body = (await (await discover(request, superAdminToken, 'vllm')).json()) as DiscoveryResponse;
    for (const entry of body.entries) expect(entry.provider).toBe('vllm');
    for (const probe of body.probes) expect(probe.provider).toBe('vllm');
  });

  test('discovery is read-only — repeating it does not change the registry', async ({ request }) => {
    const before = await (await request.get(BASE, { headers: auth(superAdminToken) })).json();
    await discover(request, superAdminToken);
    await discover(request, superAdminToken);
    const after = await (await request.get(BASE, { headers: auth(superAdminToken) })).json();

    expect((after as unknown[]).length).toBe((before as unknown[]).length);
  });

  // ── 3. Register ────────────────────────────────────────────────────
  //
  // TASK-860: discovery is READ-ONLY. `POST …/discovery/register` answers 410 Gone once its
  // replacement (`POST admin/ai-models`, fed by the inventory report) ships, so the four
  // registration-dependent cases this section used to carry (slug derivation, merge-view
  // status, duplicate-slug 400, explicit-slug escape hatch) moved with the surface. The route
  // stays mounted for one release so an old console build gets an actionable error.

  test('register is 410 Gone — discovery is read-only, registration goes through POST admin/ai-models', async ({ request }) => {
    const resp = await request.post(`${DISCOVERY}/register`, {
      headers: auth(superAdminToken),
      data: { provider: 'vllm', modelName: `e2e-528:8b-instruct_Q4_K_M-${Date.now()}` },
    });
    expect(resp.status()).toBe(410);
    const message = JSON.stringify(await resp.json());
    expect(message).toContain('admin/ai-models');
  });

  test('rejects cloud and unknown providers (nothing to discover there)', async ({ request }) => {
    for (const provider of ['azure', 'bedrock', 'not-a-provider']) {
      const resp = await request.post(`${DISCOVERY}/register`, {
        headers: auth(superAdminToken),
        data: { provider, modelName: 'x' },
      });
      expect(resp.status(), `provider '${provider}' must be rejected`).toBe(400);
    }
  });

  test('rejects undeclared body fields (global whitelist pipe)', async ({ request }) => {
    const resp = await request.post(`${DISCOVERY}/register`, {
      headers: auth(superAdminToken),
      data: { provider: 'vllm', modelName: 'e2e-528-whitelist', tenantId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(resp.status()).toBe(400);
  });

  // ── 4. Cross-tenant ───────────────────────────────────────────────
  //
  // The former case read back a row this spec had registered through discovery. With
  // registration retired (410 above) there is nothing to read; the 404-over-403 posture of
  // `GET admin/ai-models/:id` is a TASK-860 follow-up to cover through `POST admin/ai-models`.
});
