/**
 * MCP external-tools registry admin (Phase 7 E2E, Agentic SOTA).
 *
 * Probes `McpAdminController` at `/api/v1/admin/mcp-servers` (mirrors the
 * governance/OCC pattern; `@CanRead/@CanManage('HarnessPolicy')`, `If-Match` OCC,
 * `resolveScopedTenantIdOptional`).
 *
 * Locked contracts:
 *  1. Registry CRUD (SUPER_ADMIN) — POST creates a dormant SYSTEM registry row
 *     (`enabled: false`), GET/LIST read it back (`{ items, total }` envelope),
 *     PATCH mutates under OCC, DELETE soft-deletes under OCC.
 *  2. SECURITY — no response ever echoes secret material: `authRef` is a Vault
 *     PATH ONLY, and the projection carries no `secret`/`token`/`password`/
 *     `credential`/`apiKey` value key.
 *  3. The SYSTEM registry stays super-admin-owned — a tenant admin aiming a
 *     CREATE at it (`?tenantId=<SYSTEM>`), or PATCH/DELETE-ing a SYSTEM-owned
 *     row, gets 403 (the privilege wall, NOT the 404-over-403 tenancy posture;
 *     a valid `If-Match` is supplied on PATCH/DELETE so the 403 is the
 *     privilege verdict and not the 428 header gate). Owner decision OD-7
 *     (2026-09-01) let tenant admins CRUD connectors owned by their OWN tenant,
 *     so "a tenant admin may never write" is no longer the contract — only the
 *     shared SYSTEM tier is walled off.
 *  4. Cross-tenant / unknown → 404 — a server id a tenant caller cannot see is
 *     404 (absent and cross-tenant are indistinguishable, DEF-C3); a tenant
 *     admin passing a FOREIGN `?tenantId=` on the list is rejected ([403,404],
 *     never 200).
 *  5. OCC — PATCH without `If-Match` → 428; stale `If-Match: "999"` → 412; a
 *     correct `If-Match: "<version>"` succeeds and BUMPS `version`.
 *
 * EGRESS PRECONDITION. `baseUrl` is SSRF-guarded on write against the platform
 * allow-list `mcp.egress.allowedHosts` (`global-kv`, `failMode: 'closed'`), and
 * nothing seeds that key — an unset list denies EVERY connector, which is what
 * used to fail this spec's `beforeAll` with 400. The allow-list is therefore
 * platform state this spec must set up itself: `beforeAll` widens it by exactly
 * one entry and `afterAll` restores what it found.
 *
 * Fail-closed cuts both ways: with no row stored, READING the key through the
 * effective lane is a 400 too, not an empty list — so the setup treats 400 as
 * "nothing stored" instead of asserting 200 (see `beforeAll`).
 *
 * The fixture host is the IP LITERAL `203.0.113.10` (RFC 5737 TEST-NET-3), not a
 * name: the guard skips DNS for a literal (`isIP(host) !== 0`), and the
 * documentation ranges are deliberately absent from its blocked table, so the
 * fixture needs no resolver and can never actually be reached. A hostname here
 * would make the suite depend on live DNS — which is why the original
 * `terminology.internal` could not pass even once the list was set.
 *
 * Live-stack requirement: dev/test stack + seed (owner-run via
 * `pnpm test:api:up` + `pnpm test:e2e`). The spec creates a throwaway SYSTEM
 * registry row and soft-deletes it in `afterAll` — no seed rows are mutated.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

// These tests share mutable state (`serverId`, the tokens) set up once in
// `beforeAll` and consumed by every test in the file. Under the root config's
// `fullyParallel: true`, Playwright may run this describe block's tests across
// more than one worker, each getting its own `beforeAll` pass — two workers'
// `Date.now()`-based unique names can collide, and the second create then
// genuinely 400s on "already exists" (see `ai-model-discovery.spec.ts` for the
// same fix for the same reason). Run this file's tests strictly in order.
test.describe.configure({ mode: 'serial' });

const BASE = '/api/v1/admin/mcp-servers';

/** uuidv7-shaped server id no tenant has ever registered — its 404 mirrors the cross-tenant 404. */
const SYNTHETIC_SERVER_ID = '018f0000-0000-7000-8000-0000005160aa';

/** The shared platform registry tier. A tenant admin writing here is 403, by design. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The platform egress allow-list this spec must widen before any connector can be
 * written. `?tenantId=` is REQUIRED on the read: `resolveScopedTenantId` 400s a
 * platform admin that scopes neither by query nor by an elevated working tenant.
 * SYSTEM is the only correct scope here — the key is `globalOnly` / `maxScope: 'system'`.
 */
const EGRESS_ROUTE = `/api/v1/admin/settings/registry/mcp.egress.allowedHosts`;
const EGRESS_READ_ROUTE = `${EGRESS_ROUTE}?tenantId=00000000-0000-0000-0000-000000000000`;

/** RFC 5737 TEST-NET-3 literal — no DNS, never routable, not in the guard's blocked table. */
const FIXTURE_HOST = '203.0.113.10';
const FIXTURE_BASE_URL = `https://${FIXTURE_HOST}/mcp`;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Add `If-Match` only when a backing row actually exists (`version > 0`). */
const ifMatch = (headers: Record<string, string>, version?: number) =>
  version && version > 0 ? { ...headers, 'If-Match': `"${version}"` } : headers;

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

test.describe('MCP registry admin (CRUD + secret hygiene + SUPER_ADMIN + OCC)', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;

  const unique = Date.now();
  const AUTH_REF = `secret/data/mcp/e2e-${unique}`;
  let serverId: string;
  /** The allow-list as found, restored verbatim in `afterAll` — this is platform state. */
  let previousAllowedHosts: string[] = [];

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'super admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
    superAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    // Widen the egress allow-list by exactly one entry, remembering what was
    // there so `afterAll` can put it back.
    //
    // 400 IS AN EXPECTED ANSWER HERE, and it is the answer a freshly reset test
    // database always gives: the key is `failMode: 'closed'`, so when no row is
    // stored the cascade bottoms out in `applyDeclaredFailMode`, which REFUSES
    // to substitute the descriptor default and throws (→ 400). There is no
    // "unset reads as []" on this lane. Asserting 200 here therefore only ever
    // passed against a database some earlier run had already written to.
    const currentAllowList = await request.get(EGRESS_READ_ROUTE, { headers: bearer(superAdminToken) });
    expect([200, 400], `read mcp.egress.allowedHosts answered ${currentAllowList.status()}`).toContain(currentAllowList.status());
    const current = currentAllowList.status() === 200 ? ((await currentAllowList.json()) as { value?: unknown; version?: number }) : {};
    previousAllowedHosts = Array.isArray(current.value) ? (current.value as string[]) : [];

    const widened = await request.put(EGRESS_ROUTE, {
      // `version` is 0 while the value is still the code default — no row, so
      // nothing to precondition. Once a row exists the write lane applies the
      // precondition, and a PUT without `If-Match` would 428.
      headers: ifMatch(bearer(superAdminToken), current.version),
      data: { value: [...previousAllowedHosts.filter((host) => host !== FIXTURE_HOST), FIXTURE_HOST] },
    });
    expect(widened.status(), 'allow-list the fixture host').toBe(200);

    // The guard reads the list off the AppSettings cache, which the write
    // invalidates over pub/sub — near-instant in one process, but asynchronous.
    // Poll the read lane rather than racing it.
    await expect
      .poll(
        async () => {
          const probe = await request.get(EGRESS_READ_ROUTE, { headers: bearer(superAdminToken) });
          const value = probe.status() === 200 ? ((await probe.json()) as { value?: unknown }).value : null;
          return Array.isArray(value) && value.includes(FIXTURE_HOST);
        },
        { timeout: 5_000, message: 'the widened egress allow-list never became readable' },
      )
      .toBe(true);

    // SUPER_ADMIN registers a dormant SYSTEM registry row (default tenant = SYSTEM).
    const create = await request.post(BASE, {
      headers: bearer(superAdminToken),
      data: {
        name: `e2e-mcp-${unique}`,
        baseUrl: FIXTURE_BASE_URL,
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
    if (serverId) {
      const get = await request.get(`${BASE}/${serverId}`, { headers: bearer(superAdminToken) });
      if (get.status() === 200) {
        const current = (await get.json()) as McpServer;
        await request
          .delete(`${BASE}/${serverId}`, { headers: { ...bearer(superAdminToken), 'If-Match': `"${current.version}"` } })
          .catch(() => undefined);
      }
    }
    // Put the platform egress allow-list back as it was found. Leaving the
    // fixture host behind would be a security control this suite quietly
    // widened for every later run.
    //
    // One residue is unavoidable through this lane: when the key had NO row,
    // the restore writes `[]` rather than removing the row (the registry write
    // lane has no delete). Both states refuse every connector — only the
    // guard's stated reason changes, `allowlist_unavailable` → `host_not_allowed`
    // — and a managed run resets the database anyway.
    if (superAdminToken) {
      const now = await request.get(EGRESS_READ_ROUTE, { headers: bearer(superAdminToken) });
      const version = now.status() === 200 ? ((await now.json()) as { version?: number }).version : undefined;
      await request
        .put(EGRESS_ROUTE, { headers: ifMatch(bearer(superAdminToken), version), data: { value: previousAllowedHosts } })
        .catch(() => undefined);
    }
  });

  test('GET by id reads the registry row back and never echoes secret material', async ({ request }) => {
    const resp = await request.get(`${BASE}/${serverId}`, { headers: bearer(superAdminToken) });
    expect(resp.status()).toBe(200);
    const server = (await resp.json()) as McpServer;
    expect(server.id).toBe(serverId);
    assertNoSecretMaterial(server, AUTH_REF);
  });

  test('LIST returns the { items, total } envelope including the new server', async ({ request }) => {
    const resp = await request.get(BASE, { headers: bearer(superAdminToken) });
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
      headers: bearer(superAdminToken),
      data: { description: 'no if-match' },
    });
    expect(resp.status()).toBe(428);
  });

  test('OCC: PATCH with a stale If-Match → 412', async ({ request }) => {
    const resp = await request.patch(`${BASE}/${serverId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': '"999"' },
      data: { description: 'stale if-match' },
    });
    expect(resp.status()).toBe(412);
  });

  test('OCC: PATCH with the current If-Match succeeds, bumps version, keeps authRef a Vault path', async ({ request }) => {
    const get = await request.get(`${BASE}/${serverId}`, { headers: bearer(superAdminToken) });
    expect(get.status()).toBe(200);
    const before = (await get.json()) as McpServer;

    const resp = await request.patch(`${BASE}/${serverId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': `"${before.version}"` },
      data: { description: `e2e ${unique}` },
    });
    expect(resp.status()).toBe(200);
    const after = (await resp.json()) as McpServer;
    expect(after.version).toBeGreaterThan(before.version);
    assertNoSecretMaterial(after, AUTH_REF);
  });

  test('a tenant admin cannot CREATE in the SYSTEM registry → 403', async ({ request }) => {
    // OD-7 (2026-09-01): a tenant admin MAY create a connector owned by its own
    // tenant, so the wall is the SYSTEM tier, not the verb. Aiming at SYSTEM is
    // refused by `resolveScopedTenantIdOptional` (foreign `?tenantId=`) and
    // again by `assertCanWriteTenant` — 403 either way, never 404: the shared
    // registry is READABLE, so hiding its existence would be a lie.
    const resp = await request.post(`${BASE}?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: bearer(tenantAdminToken),
      data: { name: `ta-mcp-${unique}`, baseUrl: FIXTURE_BASE_URL },
    });
    expect(resp.status()).toBe(403);
  });

  test('SUPER_ADMIN-only: a tenant admin cannot PATCH → 403 (privilege wall, not the 428 gate)', async ({ request }) => {
    const resp = await request.patch(`${BASE}/${serverId}`, {
      // Valid If-Match so the 403 is the privilege verdict, not the 428 header gate.
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
      data: { description: 'tenant admin attempt' },
    });
    expect(resp.status()).toBe(403);
  });

  test('SUPER_ADMIN-only: a tenant admin cannot DELETE → 403', async ({ request }) => {
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
