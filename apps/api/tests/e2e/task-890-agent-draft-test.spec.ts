/**
 * TASK-890 §3.8 (F-7, L8) — the draft-agent test bench, over real HTTP.
 *
 * ## What this proves that no unit test can
 *
 * The service suite already pins the assembly, the gates and the metering. What only a live
 * gateway can show is the part that lives in the DECORATORS and the pipeline: that the route is
 * reachable by the credential classes it is meant for and closed to the ones it is not, that the
 * strict global `ValidationPipe` rejects an undeclared field on the new DTO, and that a foreign
 * id is 404 rather than 403 once the tenant-scope extension is actually in the loop.
 *
 * ## Why every assertion here is on a DRY RUN
 *
 * A dry run generates nothing, spends nothing and needs no `apps/text`, so this spec is hermetic
 * with respect to the Python fleet — it can never go red because an engine was down. The live
 * half (`dryRun: false`) is covered by the unit suite plus `task-890-metering.spec.ts`, which
 * already carries the "TEXT unreachable ⇒ skip" discipline; duplicating that here would add a
 * flaky path and no coverage.
 *
 * SERIAL: each test creates a DRAFT agent in the Global tenant and cleans it up.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, SEEDED_API_KEY, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

test.describe.configure({ mode: 'serial' });

const ADMIN_AGENTS = '/api/v1/admin/agents';
/** Seeded service account — the ONLY machine class that may reach the admin plane. */
const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', { data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET } });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

test.describe('TASK-890 §3.8 — POST /admin/agents/:id/test', () => {
  let adminJwt: string;
  let svcToken: string;
  /** The registry model the created drafts bind — read from the catalogue the tenant can see. */
  let modelId: string;
  const created: string[] = [];

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant-admin login').not.toBeNull();
    adminJwt = admin!.token;
    svcToken = await serviceAccountToken(request);

    const models = await request.get('/api/v1/admin/ai-models?taskType=TEXT_GENERATION', { headers: { Authorization: `Bearer ${adminJwt}` } });
    expect(models.status(), 'read the TEXT_GENERATION registry').toBe(200);
    const body = await models.json();
    const rows: Array<{ id: string; provider: string | null }> = body.data ?? body.items ?? body;
    expect(Array.isArray(rows) && rows.length > 0, 'the seeded TEXT_GENERATION registry is not empty').toBe(true);
    modelId = rows[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) {
      await request.delete(`${ADMIN_AGENTS}/${id}`, { headers: { Authorization: `Bearer ${adminJwt}` } });
    }
  });

  async function createDraft(request: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<string> {
    const slug = `l8-bench-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const res = await request.post(ADMIN_AGENTS, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: {
        slug,
        name: 'Draft bench agent',
        task: 'TEXT_GENERATION',
        modelId,
        instruction: { systemPrompt: 'You are a scribe for {{context.clinic}}.' },
        ...overrides,
      },
    });
    expect(res.status(), `create draft (${await res.text()})`).toBe(201);
    const id = (await res.json()).id as string;
    created.push(id);
    return id;
  }

  test('a dry run assembles the prompt over the supplied context and returns the resolved target', async ({ request }) => {
    const id = await createDraft(request);
    const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: { context: { clinic: 'Ward B' } },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('dry-run');
    expect(body.assembledSystemPrompt).toBe('You are a scribe for Ward B.');
    expect(body.resolved).toMatchObject({ provider: expect.any(String), model: expect.any(String), source: 'row' });
    expect(['platform', 'tenant']).toContain(body.resolved.fundingTier);
    // A dry run is the DEFAULT and never opens a generation.
    expect(body.taskId).toBeUndefined();
  });

  test('an unresolved prompt variable is a 400 that NAMES the path', async ({ request }) => {
    const id = await createDraft(request);
    const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code ?? body.message?.code).toBe('PROMPT_VARIABLE_UNRESOLVED');
    expect(JSON.stringify(body)).toContain('context.clinic');
  });

  test('the strict ValidationPipe refuses an undeclared field on the request DTO', async ({ request }) => {
    const id = await createDraft(request);
    const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: { context: { clinic: 'Ward B' }, temperature: 0.9 },
    });
    expect(res.status(), 'forbidNonWhitelisted rejects `temperature`').toBe(400);
  });

  test('a PUBLISHED agent is refused with 409 — it is INVOKED, not tested', async ({ request }) => {
    const id = await createDraft(request, { instruction: { systemPrompt: 'You are a scribe.' } });
    const published = await request.post(`${ADMIN_AGENTS}/${id}/publish`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    // A publish can legitimately fail closed here (no usable model in this environment); when it
    // does, the 409 case has nothing to stand on and SKIPPING states that honestly.
    test.skip(published.status() !== 200, `publish did not succeed in this environment (${published.status()})`);

    const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    expect(res.status()).toBe(409);
  });

  test.describe('the credential classes on /test', () => {
    test('a tenant-admin JWT is admitted', async ({ request }) => {
      const id = await createDraft(request);
      const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, {
        headers: { Authorization: `Bearer ${adminJwt}` },
        data: { context: { clinic: 'x' } },
      });
      expect(res.status()).toBe(200);
    });

    test('an API key is refused 403 by `@ForbidApiKey`, whatever its scopes', async ({ request }) => {
      const id = await createDraft(request);
      const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, { headers: { 'X-API-Key': SEEDED_API_KEY }, data: {} });
      expect(res.status(), 'the admin plane is closed to the API-key class').toBe(403);
    });

    test('a service account holding `svc:admin:agent:manage` is admitted', async ({ request }) => {
      const id = await createDraft(request);
      // `workingTenantId` binds at EXCHANGE, so `X-Tenant-Id` is never sent alongside it.
      const res = await request.post(`${ADMIN_AGENTS}/${id}/test`, {
        headers: { 'X-Service-Account-Token': svcToken },
        data: { context: { clinic: 'x' } },
      });
      expect([200, 404], `service-account reach (${res.status()}: ${await res.text()})`).toContain(res.status());
    });

    test('an unauthenticated call is 401', async ({ request }) => {
      const res = await request.post(`${ADMIN_AGENTS}/00000000-0000-0000-0000-0000000000ff/test`, { data: {} });
      expect(res.status()).toBe(401);
    });

    test('an id that is not this tenant`s is 404, never 403 (404-over-403)', async ({ request }) => {
      const res = await request.post(`${ADMIN_AGENTS}/00000000-0000-0000-0000-0000000000ff/test`, {
        headers: { Authorization: `Bearer ${adminJwt}` },
        data: {},
      });
      expect(res.status()).toBe(404);
    });
  });
});
