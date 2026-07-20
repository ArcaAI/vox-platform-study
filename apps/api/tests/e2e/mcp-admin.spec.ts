/**
 * MCP external-tools registry admin (Phase 7 E2E, Agentic SOTA).
 *
 * Probes `McpAdminController` at `/api/v1/admin/mcp-servers` (mirrors the task-506
 * governance/OCC pattern; `@CanRead/@CanManage('HarnessPolicy')`, `If-Match` OCC,
 * `resolveScopedTenantIdOptional`).
 *
 * Locked contracts:
 *  1. Registry CRUD (GLOBAL_ADMIN) — POST creates a dormant SYSTEM registry row
 *     (`enabled: false`), GET/LIST read it back (`{ items, total }` envelope),
 *     PATCH mutates under OCC, DELETE soft-deletes under OCC.
 *  2. SECURITY — no response ever echoes secret material: `authRef` is a Vault
 *     PATH ONLY, and the projection carries no `secret`/`token`/`password`/
 *     `credential`/`apiKey` value key.
 *  3. GLOBAL_ADMIN-only writes — a tenant admin CREATE/PATCH/DELETE → 403 (the
 *     service privilege wall, NOT the 404-over-403 tenancy posture; a valid
 *     `If-Match` is supplied on PATCH/DELETE so the 403 is the privilege verdict
 *     and not the 428 header gate).
 *  4. Cross-tenant / unknown → 404 — a server id a tenant caller cannot see is
 *     404 (absent and cross-tenant are indistinguishable, DEF-C3); a tenant
 *     admin passing a FOREIGN `?tenantId=` on the list is rejected ([403,404],
 *     never 200).
 *  5. OCC — PATCH without `If-Match` → 428; stale `If-Match: "999"` → 412; a
 *     correct `If-Match: "<version>"` succeeds and BUMPS `version`.
 *
 * Live-stack requirement: dev/test stack + seed (owner-run via
 * `pnpm test:api:up` + `pnpm test:e2e`). The spec creates a throwaway SYSTEM
 * registry row and soft-deletes it in `afterAll` — no seed rows are mutated.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/mcp-servers';

/** uuidv7-shaped server id no tenant has ever registered — its 404 mirrors the cross-tenant 404. */
const SYNTHETIC_SERVER_ID = '018f0000-0000-7000-8000-0000005160aa';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface McpServer {
  id: string;
  tenantId: string;
  name: string;
  baseUrl: string;
  transport: string;
  authRef?: string | null;
  phiBoundary: string;
  enabled: boolean;
  version: number;
  [key: string]: unknown;
}
interface McpServerList {
  items: McpServer[];
  total: number;
}

/** No response property (other than the Vault-path `authRef`) may look like secret material. */
function assertNoSecretMaterial(server: Record<string, unknown>, expectedAuthRef: string): void {
  expect(server.authRef, 'authRef is echoed as the Vault path verbatim').toBe(expectedAuthRef);
  expect(String(server.authRef), 'authRef is path-shaped (no whitespace / inline secret)').not.toMatch(/\s/);
  const secretish = /(secret|token|password|credential|apikey|api_key)/i;
  for (const key of Object.keys(server)) {
    if (key === 'authRef') continue; // the Vault PATH, not a secret value
    expect(secretish.test(key), `response must not surface a secret-material key: ${key}`).toBe(false);
  }
}

test.describe('MCP registry admin (CRUD + secret hygiene + GLOBAL_ADMIN + OCC)', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string;

  const unique = Date.now();
  const AUTH_REF = `secret/data/mcp/e2e-${unique}`;
  let serverId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    // GLOBAL_ADMIN registers a dormant SYSTEM registry row (default tenant = SYSTEM).
    const create = await request.post(BASE, {
      headers: bearer(globalAdminToken),
      data: {
        name: `e2e-mcp-${unique}`,
        baseUrl: 'https://terminology.internal/mcp',
        transport: 'streamable-http',
        authRef: AUTH_REF,
        phiBoundary: 'external',
      },
    });
    expect(create.status(), 'create MCP server').toBe(201);
    const created = (await create.json()) as McpServer;
    serverId = created.id;
    expect(serverId).toBeTruthy();
    expect(created.enabled, 'a new server is dormant by default').toBe(false);
    expect(typeof created.version).toBe('number');
    assertNoSecretMaterial(created, AUTH_REF);
  });

  test.afterAll(async ({ request }) => {
    if (!serverId) return;
    const get = await request.get(`${BASE}/${serverId}`, { headers: bearer(globalAdminToken) });
    if (get.status() !== 200) return;
    const current = (await get.json()) as McpServer;
    await request
      .delete(`${BASE}/${serverId}`, { headers: { ...bearer(globalAdminToken), 'If-Match': `"${current.version}"` } })
      .catch(() => undefined);
  });

  test('GET by id reads the registry row back and never echoes secret material', async ({ request }) => {
    const resp = await request.get(`${BASE}/${serverId}`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(200);
    const server = (await resp.json()) as McpServer;
    expect(server.id).toBe(serverId);
    assertNoSecretMaterial(server, AUTH_REF);
  });

  test('LIST returns the { items, total } envelope including the new server', async ({ request }) => {
    const resp = await request.get(BASE, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as McpServerList;
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    const mine = body.items.find((s) => s.id === serverId);
    expect(mine, 'the created SYSTEM server appears in the registry list').toBeTruthy();
    if (mine) assertNoSecretMaterial(mine, AUTH_REF);
  });

  test('OCC: PATCH without If-Match → 428', async ({ request }) => {
    const resp = await request.patch(`${BASE}/${serverId}`, {
      headers: bearer(globalAdminToken),
      data: { description: 'no if-match' },
    });
    expect(resp.status()).toBe(428);
  });

  test('OCC: PATCH with a stale If-Match → 412', async ({ request }) => {
    const resp = await request.patch(`${BASE}/${serverId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': '"999"' },
      data: { description: 'stale if-match' },
    });
    expect(resp.status()).toBe(412);
  });

  test('OCC: PATCH with the current If-Match succeeds, bumps version, keeps authRef a Vault path', async ({ request }) => {
    const get = await request.get(`${BASE}/${serverId}`, { headers: bearer(globalAdminToken) });
    expect(get.status()).toBe(200);
    const before = (await get.json()) as McpServer;

    const resp = await request.patch(`${BASE}/${serverId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${before.version}"` },
      data: { description: `e2e ${unique}` },
    });
    expect(resp.status()).toBe(200);
    const after = (await resp.json()) as McpServer;
    expect(after.version).toBeGreaterThan(before.version);
    assertNoSecretMaterial(after, AUTH_REF);
  });

  test('GLOBAL_ADMIN-only: a tenant admin cannot CREATE → 403', async ({ request }) => {
    const resp = await request.post(BASE, {
      headers: bearer(tenantAdminToken),
      data: { name: `ta-mcp-${unique}`, baseUrl: 'https://x.internal/mcp' },
    });
    expect(resp.status()).toBe(403);
  });

  test('GLOBAL_ADMIN-only: a tenant admin cannot PATCH → 403 (privilege wall, not the 428 gate)', async ({ request }) => {
    const resp = await request.patch(`${BASE}/${serverId}`, {
      // Valid If-Match so the 403 is the privilege verdict, not the 428 header gate.
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
      data: { description: 'tenant admin attempt' },
    });
    expect(resp.status()).toBe(403);
  });

  test('GLOBAL_ADMIN-only: a tenant admin cannot DELETE → 403', async ({ request }) => {
    const resp = await request.delete(`${BASE}/${serverId}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
    });
    expect(resp.status()).toBe(403);
  });

  test('cross-tenant / unknown server id → 404 (never 403), body leaks no tenant', async ({ request }) => {
    const resp = await request.get(`${BASE}/${SYNTHETIC_SERVER_ID}`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(404);
    const body = await resp.json().catch(() => ({}));
    expect(String((body as { message?: string }).message ?? '')).not.toMatch(/tenant/i);
  });

  test('a tenant admin passing a FOREIGN ?tenantId= on the list is rejected (never 200)', async ({ request }) => {
    const foreignTenantId = '018f0000-0000-7000-8000-0000005160bb';
    const resp = await request.get(`${BASE}?tenantId=${foreignTenantId}`, { headers: bearer(tenantAdminToken) });
    expect([403, 404]).toContain(resp.status());
    const body = await resp.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toContain(foreignTenantId);
  });
});
