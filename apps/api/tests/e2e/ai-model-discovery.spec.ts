/**
 * `admin/ai-models/discovery` (merge view) and
 * `admin/ai-models/discovery/register` (explicit register).
 *
 * The e2e job needs a live
 * gateway + seeded DB (`pnpm test:api:up`, then `pnpm test:e2e`); SMR itself may
 * be DOWN — that is a covered case, not a skip condition, because a failed probe
 * must degrade the response, never 5xx it.
 *
 * Locked contracts:
 *  1. GLOBAL-ADMIN ONLY — the discovery routes join the `manage:all` registry
 *     plane. A tenant admin is refused (403/404, never 200 with data).
 *  2. NEVER 5xx ON A DEAD ENGINE — with SMR or an engine unreachable the merge
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

const SERVER_MANAGED = ['ollama', 'lm-studio', 'vllm', 'llama-cpp'];

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function discover(request: APIRequestContext, token: string, provider?: string) {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  return request.get(`${DISCOVERY}${qs}`, { headers: auth(token) });
}

test.describe('AI model discovery', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string;
  const createdIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login (ARCAAI) failed').toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${BASE}/${id}`, { headers: auth(globalAdminToken) });
    }
  });

  // ── 1. Guard ───────────────────────────────────────────────────────────────

  test('discovery is global-admin only — a tenant admin is refused', async ({ request }) => {
    const resp = await discover(request, tenantAdminToken);
    expect([403, 404]).toContain(resp.status());
  });

  test('register is global-admin only — a tenant admin is refused', async ({ request }) => {
    const resp = await request.post(`${DISCOVERY}/register`, {
      headers: auth(tenantAdminToken),
      data: { provider: 'ollama', modelName: 'e2e-guard-probe' },
    });
    expect([403, 404]).toContain(resp.status());
  });

  test('unauthenticated callers are rejected', async ({ request }) => {
    const resp = await request.get(DISCOVERY);
    expect(resp.status()).toBe(401);
  });

  // ── 2. Merge view degrades, never 5xx ──────────────────────────────────────

  test('returns 200 with a well-formed envelope even when engines are down', async ({ request }) => {
    const resp = await discover(request, globalAdminToken);
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
    const body = (await (await discover(request, globalAdminToken)).json()) as DiscoveryResponse;
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
    const body = (await (await discover(request, globalAdminToken, 'ollama')).json()) as DiscoveryResponse;
    for (const entry of body.entries) expect(entry.provider).toBe('ollama');
    for (const probe of body.probes) expect(probe.provider).toBe('ollama');
  });

  test('discovery is read-only — repeating it does not change the registry', async ({ request }) => {
    const before = await (await request.get(BASE, { headers: auth(globalAdminToken) })).json();
    await discover(request, globalAdminToken);
    await discover(request, globalAdminToken);
    const after = await (await request.get(BASE, { headers: auth(globalAdminToken) })).json();

    expect((after as unknown[]).length).toBe((before as unknown[]).length);
  });

  // ── 3. Register ────────────────────────────────────────────────────────────

  test('registers a model, deriving a slug from the engine-reported name', async ({ request }) => {
    const modelName = `e2e-528:8b-instruct_Q4_K_M-${Date.now()}`;
    const resp = await request.post(`${DISCOVERY}/register`, {
      headers: auth(globalAdminToken),
      data: { provider: 'ollama', modelName },
    });
    expect(resp.status()).toBe(201);

    const body = (await resp.json()) as { id: string; slug: string; sourceUri: string; provider: string };
    createdIds.push(body.id);

    expect(body.provider).toBe('ollama');
    expect(body.sourceUri).toBe(modelName);
    expect(body.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(body.slug).not.toContain(':');
    expect(body.slug).not.toContain('_');
  });

  test('a registered model shows up in the merge view as registered', async ({ request }) => {
    const body = (await (await discover(request, globalAdminToken, 'ollama')).json()) as DiscoveryResponse;
    const created = body.entries.find((e) => e.registeredModel?.id === createdIds[0]);
    expect(created, 'the freshly-registered row must appear in the merge view').toBeTruthy();
    expect(created!.status).not.toBe('discovered');
  });

  test('a duplicate slug is a 400 naming the taken slug — never a silent suffix', async ({ request }) => {
    const modelName = `e2e-528-dup-${Date.now()}`;
    const first = await request.post(`${DISCOVERY}/register`, {
      headers: auth(globalAdminToken),
      data: { provider: 'ollama', modelName },
    });
    expect(first.status()).toBe(201);
    createdIds.push(((await first.json()) as { id: string }).id);

    const second = await request.post(`${DISCOVERY}/register`, {
      headers: auth(globalAdminToken),
      data: { provider: 'ollama', modelName },
    });
    expect(second.status()).toBe(400);
    const message = JSON.stringify(await second.json());
    expect(message).toContain(modelName.toLowerCase());
    expect(message.toLowerCase()).toContain('slug');
  });

  test('an explicit slug is the escape hatch for a collision', async ({ request }) => {
    const modelName = `e2e-528-explicit-${Date.now()}`;
    const first = await request.post(`${DISCOVERY}/register`, {
      headers: auth(globalAdminToken),
      data: { provider: 'ollama', modelName },
    });
    createdIds.push(((await first.json()) as { id: string }).id);

    const second = await request.post(`${DISCOVERY}/register`, {
      headers: auth(globalAdminToken),
      data: { provider: 'ollama', modelName, slug: `${modelName.toLowerCase()}-v2` },
    });
    expect(second.status()).toBe(201);
    createdIds.push(((await second.json()) as { id: string }).id);
  });

  test('rejects cloud and unknown providers (nothing to discover there)', async ({ request }) => {
    for (const provider of ['azure', 'bedrock', 'not-a-provider']) {
      const resp = await request.post(`${DISCOVERY}/register`, {
        headers: auth(globalAdminToken),
        data: { provider, modelName: 'x' },
      });
      expect(resp.status(), `provider '${provider}' must be rejected`).toBe(400);
    }
  });

  test('rejects undeclared body fields (global whitelist pipe)', async ({ request }) => {
    const resp = await request.post(`${DISCOVERY}/register`, {
      headers: auth(globalAdminToken),
      data: { provider: 'ollama', modelName: 'e2e-528-whitelist', tenantId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(resp.status()).toBe(400);
  });

  // ── 4. Cross-tenant ────────────────────────────────────────────────────────

  test('cross-tenant — a row registered under one tenant is not readable from another', async ({ request }) => {
    const id = createdIds[0];
    expect(id, 'a row must have been registered by the earlier test').toBeTruthy();

    // The global admin created the row under the ARCAAI working tenant; the
    // DEFAULT-tenant admin must get the 404-over-403 posture, never the row.
    const resp = await request.get(`${BASE}/${id}`, { headers: auth(tenantAdminToken) });
    expect([403, 404]).toContain(resp.status());
    if (resp.status() === 200) {
      throw new Error('cross-tenant read of a registered model leaked');
    }
  });
});
