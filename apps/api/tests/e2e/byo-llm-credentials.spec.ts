/**
 * Tenant BYO cloud credential → TEXT generate round-trip (gap).
 *
 * `ai-provider-connections-cross-tenant.spec.ts` already locks down
 * `AiProviderConnectionController` itself: secret-never-echoed, self-host-403,
 * and the cross-tenant read/write posture — exclusively against the `azure`
 * row. NONE of that proves the credential actually reaches TEXT — that only
 * happens inside `TextProxyController#generate` via
 * `applyTenantProviderOverrides` (see
 * `apps/api/src/modules/streaming/__tests__/text-proxy-tenant-byo.controller.test.ts`
 * for the equivalent unit-level proof of the same fold-in logic). This spec is
 * the live HTTP round trip, exercised against `bedrock` instead of `azure` so
 * it never contends with the other spec file's writes to the same tenant's
 * `azure` row:
 *
 *   1. Tenant A sets an ENABLED bedrock BYO credential, then calls
 *      `POST /api/v1/text-generations/generate` with `provider: 'bedrock'`. The
 *      credential the gateway forwards downstream as
 *      `provider_overrides.bedrock` must match exactly what tenant A
 *      configured.
 *   2. Tenant B (no credential of its own) calling the same route never
 *      receives tenant A's override — isolation holds through the CLS tenant
 *      context, not merely through the admin read surface.
 *   3. The admin read surface (`GET admin/ai-providers/bedrock`) still never
 *      echoes the plaintext key — reinforced here because this is the one
 *      spec that deliberately writes a real plaintext key and exercises it.
 *
 * ENV-GATED — SKIPPED BY DEFAULT (a visible skip count in the report, never a
 * silent omission). Proving (1)/(2) needs the gateway's own `TEXT_URL` to point
 * at a listener this spec can inspect, and the gateway resolves `TEXT_URL` ONCE
 * at bootstrap (`text-proxy.controller.ts#getTextBaseUrl`) — this Playwright
 * worker cannot redirect an already-running gateway process. That makes this
 * an OPERATOR setup step, not something the spec can arrange on its own:
 *
 *   1. Pick a free local port, e.g. 8899.
 *   2. Start (or restart) the API with `TEXT_URL=http://127.0.0.1:8899`.
 *   3. Run this suite with `E2E_TEXT_STUB=1 E2E_TEXT_URL=http://127.0.0.1:8899`.
 *
 * Given that, this spec binds a tiny HTTP listener at that exact address for
 * the run and services `POST /api/v1/generate` itself, echoing back the JSON
 * body it received (including any `provider_overrides`) as its own response.
 * That echo is TEST-ONLY verification plumbing: a real TEXT never echoes
 * credentials back in its response — it uses them to call the cloud provider
 * and returns generated text. The echo is what lets this spec see, from the
 * outside, exactly what the gateway forwarded downstream, without a second
 * inspection channel.
 */
import { test, expect } from '@playwright/test';
import * as http from 'node:http';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const ADMIN_BASE = '/api/v1/admin/ai-providers';
const GENERATE_ROUTE = '/api/v1/text-generations/generate';
const ARCAAI_TENANT_KEY = 'ARCAAI';

const TEXT_STUB_ENABLED = process.env.E2E_TEXT_STUB === '1';
const TEXT_STUB_URL = process.env.E2E_TEXT_URL ?? '';

interface StubGenerateEcho {
  content: string;
  provider: string | null;
  provider_overrides: Record<string, { api_key: string; region?: string; base_url?: string }> | null;
}

// `.serial`: this describe binds a real local HTTP listener on a FIXED port
// (E2E_TEXT_URL) in `beforeAll`. The suite runs `fullyParallel: true`
// (root `playwright.config.ts`), so without `.serial` a second worker could be
// assigned a test from this same describe and run its OWN copy of `beforeAll`
// concurrently — a second `listen()` on the same port throws EADDRINUSE. No
// other spec in this folder binds a port, so no other file needs this.
test.describe.serial('tenant BYO cloud credential reaches TEXT (generate round-trip)', () => {
  test.skip(
    !TEXT_STUB_ENABLED || !TEXT_STUB_URL,
    'requires a stub TEXT listener this spec binds at E2E_TEXT_URL, with the LIVE gateway’s own TEXT_URL pointed at ' +
      'that same address before boot (set E2E_TEXT_STUB=1 + E2E_TEXT_URL=http://127.0.0.1:<port> for BOTH the gateway ' +
      'process and this suite — see the file header for the full sequence)',
  );

  const unique = Date.now();
  const TENANT_A_SECRET = `e2e-byo-bedrock-secret-${unique}`;
  const TENANT_A_REGION = 'us-east-1';

  let stubServer: http.Server;
  let tenantAToken: string;
  let tenantBToken: string;
  let tenantACredentialWritten = false;

  test.beforeAll(async ({ request }) => {
    const url = new URL(TEXT_STUB_URL);
    stubServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          parsed = {};
        }
        const echo: StubGenerateEcho = {
          content: 'stub-generated',
          provider: (parsed.provider as string | undefined) ?? null,
          provider_overrides: (parsed.provider_overrides as StubGenerateEcho['provider_overrides']) ?? null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(echo));
      });
    });
    await new Promise<void>((resolve, reject) => {
      stubServer.once('error', reject);
      stubServer.listen(Number(url.port), url.hostname, () => resolve());
    });

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAToken = ta!.token;

    // Tenant B is a second REAL tenant (not merely a second user in the same
    // tenant): a SUPER_ADMIN logged in against the secondary cross-tenant
    // fixture tenant acts under ITS OWN CLS context, same pattern
    // `ai-provider-connections-cross-tenant.spec.ts` uses for `foreignTenantId`.
    const tb = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, ARCAAI_TENANT_KEY);
    expect(tb, `super admin login (${ARCAAI_TENANT_KEY}) failed`).toBeTruthy();
    tenantBToken = tb!.token;

    const current = await request.get(`${ADMIN_BASE}/bedrock`, { headers: { Authorization: `Bearer ${tenantAToken}` } });
    expect(current.status()).toBe(200);
    const { version } = (await current.json()) as { version: number };

    const put = await request.put(`${ADMIN_BASE}/bedrock`, {
      headers: { Authorization: `Bearer ${tenantAToken}`, 'If-Match': `"${version}"` },
      data: { apiKey: TENANT_A_SECRET, region: TENANT_A_REGION, enabled: true },
    });
    // 400 is a legitimate outcome with no Vault Transit provider in this
    // environment (the write rejects rather than storing plaintext) — the
    // same tolerance `ai-provider-connections-cross-tenant.spec.ts` applies.
    // The round-trip tests below skip individually when that happened.
    expect([200, 400]).toContain(put.status());
    tenantACredentialWritten = put.status() === 200;
  });

  test.afterAll(async ({ request }) => {
    if (stubServer) {
      await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    }
    if (!tenantACredentialWritten) return;
    const current = await request.get(`${ADMIN_BASE}/bedrock`, { headers: { Authorization: `Bearer ${tenantAToken}` } });
    if (current.status() !== 200) return;
    const { version } = (await current.json()) as { version: number };
    await request
      .delete(`${ADMIN_BASE}/bedrock`, { headers: { Authorization: `Bearer ${tenantAToken}`, 'If-Match': `"${version}"` } })
      .catch(() => undefined);
  });

  test('the written credential is never echoed by the admin read surface', async ({ request }) => {
    test.skip(!tenantACredentialWritten, 'no Vault Transit provider in this environment — see beforeAll');

    const resp = await request.get(`${ADMIN_BASE}/bedrock`, { headers: { Authorization: `Bearer ${tenantAToken}` } });
    expect(resp.status()).toBe(200);
    const raw = await resp.text();
    expect(raw).not.toContain(TENANT_A_SECRET);
    const body = JSON.parse(raw) as { hasKey: boolean };
    expect(body.hasKey).toBe(true);
  });

  test('a generate request from tenant A carries its BYO bedrock credential through to TEXT', async ({ request }) => {
    test.skip(!tenantACredentialWritten, 'no Vault Transit provider in this environment — see beforeAll');

    const resp = await request.post(GENERATE_ROUTE, {
      headers: { Authorization: `Bearer ${tenantAToken}` },
      data: { prompt: 'ping', provider: 'bedrock', model: 'test-model', stream: false },
    });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as StubGenerateEcho;

    expect(body.provider_overrides, 'the stub must have received a provider_overrides.bedrock entry').toBeTruthy();
    const bedrockOverride = body.provider_overrides!.bedrock;
    expect(bedrockOverride, 'the bedrock entry specifically must be present').toBeTruthy();
    expect(bedrockOverride.api_key).toBe(TENANT_A_SECRET);
    expect(bedrockOverride.region).toBe(TENANT_A_REGION);

    // Independent raw-text scan closes off a JSON.parse projection hiding a
    // second copy. This string appears ONLY because the stub deliberately
    // echoes it for this spec's own verification (see the file header) — the
    // opposite must hold for `admin/ai-providers` responses (previous test).
    expect(JSON.stringify(body)).toContain(TENANT_A_SECRET);
  });

  test('a generate request from tenant B (no credential of its own) never receives tenant A credential', async ({ request }) => {
    const resp = await request.post(GENERATE_ROUTE, {
      headers: { Authorization: `Bearer ${tenantBToken}` },
      data: { prompt: 'ping', provider: 'bedrock', model: 'test-model', stream: false },
    });
    expect(resp.status()).toBe(200);
    const raw = await resp.text();
    expect(raw).not.toContain(TENANT_A_SECRET);
    const body = JSON.parse(raw) as StubGenerateEcho;
    expect(body.provider_overrides).toBeFalsy();
  });
});
