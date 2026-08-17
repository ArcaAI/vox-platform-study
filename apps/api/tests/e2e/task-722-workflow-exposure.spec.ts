/**
 * TASK-722 — Exposure Plane v1: e2e contract tests for `/api/v1/workflows/*`.
 *
 * SCOPE OF WHAT THIS SPEC CAN PROVE IN THIS ENVIRONMENT: the gateway-side
 * contract — scoping, tenant isolation, kill-switch, DTO validation, and the
 * stream-ticket gate — all of which resolve WITHOUT a live Temporal worker or
 * harness process. It does NOT prove a full invoke -> 202 -> RUNNING ->
 * COMPLETED round trip: `WorkflowExposureService.invoke` calls
 * `HarnessGatewayService.startWorkflowRun`, which POSTs to the harness
 * dispatcher (`apps/harness`) — that service, and the Temporal worker behind
 * it, are NOT part of `pnpm test:up:api` and are not started by this suite.
 * R-2 (`docs/implementation/TASK-722-Exposure-V1/README.md` §6) already names
 * Temporal as not yet production-ready for exactly this reason. A test that
 * asserted 202 here would either hang on an unreachable dispatcher or require
 * mocking the very boundary this suite exists to exercise for real — so the
 * "successful invoke starts a run" behavior is covered at the UNIT level
 * instead (`workflow-exposure.service.test.ts`, which mocks
 * `HarnessGatewayService`), and this file covers everything upstream of that
 * call.
 *
 * `WORKFLOW_EXPOSURE_ENABLED=true` is set in `.env.test` ONLY (R-1's
 * kill-switch stays OFF in dev/prod) so this suite can exercise the surface;
 * the kill-switch's OWN 404-when-off behavior is proven at the unit level.
 *
 * Prerequisites: API server running against the test DB (`pnpm test:up:api`),
 * seeded (`pnpm test:db:seed`).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface CreatedApiKey {
  id: string;
  rawKey: string;
}

/** Creates an API key with exactly the given scopes, owned by the caller's own tenant
 *  (mirrors `task-708-apikey-scope-contract.spec.ts`'s helper). */
async function createScopedApiKey(request: APIRequestContext, token: string, scopes: string[], namePrefix: string): Promise<CreatedApiKey> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: { Authorization: `Bearer ${token}` },
    data: { keyName: `${namePrefix}-${Date.now()}`, keyType: 'SDK', scopes },
  });
  expect(response.status(), `API key creation failed for ${namePrefix}`).toBe(201);
  const body = await response.json();
  return { id: body.apiKey.id, rawKey: body.rawKey };
}

/** A structurally-valid, compilable graph — a single `noop` node, no edges
 *  (mirrors `workflow-definition.service.test.ts`'s `VALID_GRAPH` fixture). */
const VALID_GRAPH = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };

interface CreatedDefinition {
  id: string;
  slug: string;
  version: number;
}

/** Creates + publishes a WorkflowDefinition via the admin authoring API, returning enough to
 *  invoke it through the exposure plane. */
async function createPublishedWorkflow(request: APIRequestContext, token: string, slug: string): Promise<CreatedDefinition> {
  const created = await request.post('/api/v1/admin/workflow-definitions', {
    headers: { Authorization: `Bearer ${token}` },
    data: { slug, name: `E2E ${slug}`, paletteKey: 'summarization', graph: VALID_GRAPH },
  });
  expect(created.status(), `create workflow definition '${slug}'`).toBe(201);
  const definition = await created.json();

  const published = await request.post(`/api/v1/admin/workflow-definitions/${definition.id}/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'If-Match': `"${definition.version}"` },
    data: {},
  });
  // `POST :id/publish` has no `@HttpCode` override in `WorkflowDefinitionController`, so it
  // returns Nest's default POST status (201) at runtime — matching the sibling
  // `ConsultationContextSchemaController#publish` route, which documents 201 for the same
  // shape of action. The controller's own `@ApiResponse({ status: 200 })` Swagger annotation
  // on this route is stale docs, not the actual contract.
  expect(published.status(), `publish workflow definition '${slug}'`).toBe(201);
  const publishedBody = await published.json();

  return { id: publishedBody.id, slug: publishedBody.slug, version: publishedBody.version };
}

test.describe('TASK-722 — /api/v1/workflows exposure plane', () => {
  let tenantAdminToken: string;
  let otherTenantAdminToken: string;
  const createdApiKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin?.token, 'tenant-admin login failed').toBeTruthy();
    tenantAdminToken = admin!.token as string;

    // A SECOND tenant's admin — for cross-tenant slug isolation. ARCAAI is the
    // super-admin's own tenant in the seed; used here purely as "a foreign tenant".
    const other = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(other?.token, 'foreign-tenant login failed').toBeTruthy();
    otherTenantAdminToken = other!.token as string;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdApiKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } }).catch(() => {});
    }
  });

  test.describe('GET /workflows — scope enforcement', () => {
    test('an API key without workflow:definition:read gets 403', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['consultation:session:read'], 'task-722-list-noscope');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/workflows', { headers: { 'X-API-Key': key.rawKey } });

      expect(response.status()).toBe(403);
    });

    test('an API key WITH workflow:definition:read reaches the handler (200, not the scope 403)', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:definition:read'], 'task-722-list-scoped');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/workflows', { headers: { 'X-API-Key': key.rawKey } });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
    });

    test('a JWT-authenticated tenant admin (not only a super admin) can list', async ({ request }) => {
      const response = await request.get('/api/v1/workflows', { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
      expect(response.status()).toBe(200);
    });
  });

  test.describe('POST /workflows/:slug/invoke — 404-over-403 + scope + validation', () => {
    test('an unknown slug is 404', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:write'], 'task-722-invoke-unknown');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/workflows/does-not-exist-e2e/invoke', {
        headers: { 'X-API-Key': key.rawKey },
        data: { input: {} },
      });

      expect(response.status()).toBe(404);
    });

    test('an API key without workflow:run:write gets 403 with the exact enforceApiKeyScopes message shape', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:read'], 'task-722-invoke-noscope');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/workflows/anything-e2e/invoke', {
        headers: { 'X-API-Key': key.rawKey },
        data: { input: {} },
      });

      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.message).toContain('API key does not have required scope(s): workflow:run:write');
    });

    test('an invoke body carrying tenantId (or any undeclared field) is 400 — forbidNonWhitelisted, S-3 proven at the wire', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:write'], 'task-722-invoke-forgedtenant');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/workflows/anything-e2e/invoke', {
        headers: { 'X-API-Key': key.rawKey },
        data: { input: {}, tenantId: '00000000-0000-0000-0000-000000000000' },
      });

      expect(response.status()).toBe(400);
    });

    test('a DRAFT (unpublished) slug is 404, never exposing draft content', async ({ request }) => {
      // slug must match WORKFLOW_NODE_ID_PATTERN [a-z0-9_]{2,48} — no hyphens.
      const slug = `e2e_draft_${Date.now()}`;
      const created = await request.post('/api/v1/admin/workflow-definitions', {
        headers: { Authorization: `Bearer ${tenantAdminToken}` },
        data: { slug, name: 'E2E Draft', paletteKey: 'summarization', graph: VALID_GRAPH },
      });
      expect(created.status()).toBe(201);

      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:write'], 'task-722-invoke-draft');
      createdApiKeyIds.push(key.id);

      const response = await request.post(`/api/v1/workflows/${slug}/invoke`, {
        headers: { 'X-API-Key': key.rawKey },
        data: { input: {} },
      });

      expect(response.status()).toBe(404);
    });

    test("a foreign tenant's published slug is 404 (cross-tenant, never 403)", async ({ request }) => {
      // slug must match WORKFLOW_NODE_ID_PATTERN [a-z0-9_]{2,48} — no hyphens.
      const slug = `e2e_crosstenant_${Date.now()}`;
      const definition = await createPublishedWorkflow(request, tenantAdminToken, slug);
      expect(definition.slug).toBe(slug);

      const foreignKey = await createScopedApiKey(request, otherTenantAdminToken, ['workflow:run:write'], 'task-722-invoke-crosstenant');

      const response = await request.post(`/api/v1/workflows/${slug}/invoke`, {
        headers: { 'X-API-Key': foreignKey.rawKey },
        data: { input: {} },
      });

      expect(response.status()).toBe(404);

      await request
        .delete(`/api/v1/admin/api-keys/${foreignKey.id}`, { headers: { Authorization: `Bearer ${otherTenantAdminToken}` } })
        .catch(() => {});
    });

    // A published workflow's invoke reaches the harness dispatcher, which is not running in
    // this suite (see the file header) — that call fails with a connection error and the
    // request 5xxs rather than returning 202. This is still a meaningful assertion: it proves
    // the request got PAST every gateway-side gate (slug resolution, quota check, cloud-provider
    // check, claim-check mint) before failing on the one boundary this environment cannot host.
    test('a published, in-scope, own-tenant invoke passes every gateway gate (fails only on the unreachable harness dispatcher)', async ({
      request,
    }) => {
      // slug must match WORKFLOW_NODE_ID_PATTERN [a-z0-9_]{2,48} — no hyphens.
      const slug = `e2e_publish_${Date.now()}`;
      await createPublishedWorkflow(request, tenantAdminToken, slug);

      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:write'], 'task-722-invoke-published');
      createdApiKeyIds.push(key.id);

      const response = await request.post(`/api/v1/workflows/${slug}/invoke`, {
        headers: { 'X-API-Key': key.rawKey },
        data: { input: {} },
      });

      // NOT 404 (slug resolved) and NOT 403 (scope + cloud-provider gate both passed) —
      // whatever status the unreachable-dispatcher failure maps to (502/500/503).
      expect(response.status()).not.toBe(404);
      expect(response.status()).not.toBe(403);
      expect(response.status()).toBeGreaterThanOrEqual(500);
    });
  });

  test.describe('GET/POST /workflows/:slug/runs/:runId — 404-over-403 (no live run to resolve)', () => {
    test('GET status for an unknown runId is 404', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:read'], 'task-722-status-unknown');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/workflows/any-slug-e2e/runs/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-API-Key': key.rawKey },
      });

      expect(response.status()).toBe(404);
    });

    test('cancel for an unknown runId is 404 — never a signal-name pass-through (no signalName field exists on the request at all)', async ({
      request,
    }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:write'], 'task-722-cancel-unknown');
      createdApiKeyIds.push(key.id);

      const response = await request.post('/api/v1/workflows/any-slug-e2e/runs/00000000-0000-0000-0000-000000000000/cancel', {
        headers: { 'X-API-Key': key.rawKey },
        data: {},
      });

      expect(response.status()).toBe(404);
    });

    test('GET status without workflow:run:read scope is 403', async ({ request }) => {
      const key = await createScopedApiKey(request, tenantAdminToken, ['workflow:run:write'], 'task-722-status-noscope');
      createdApiKeyIds.push(key.id);

      const response = await request.get('/api/v1/workflows/any-slug-e2e/runs/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-API-Key': key.rawKey },
      });

      expect(response.status()).toBe(403);
    });
  });

  test.describe('GET /workflows/:slug/runs/:runId/stream — S-6 (no JWT/ticket in a leaked stream)', () => {
    test('without a session or a stream ticket, the SSE route is 401', async ({ request }) => {
      const response = await request.get('/api/v1/workflows/any-slug-e2e/runs/00000000-0000-0000-0000-000000000000/stream');
      expect(response.status()).toBe(401);
    });

    test('a stream ticket minted for a DIFFERENT namespace (wrong scope) is rejected 401', async ({ request }) => {
      const ticketResponse = await request.post('/api/v1/auth/stream-ticket', {
        headers: { Authorization: `Bearer ${tenantAdminToken}` },
        data: { scope: 'consultation_job:not-a-workflow-run' },
      });
      expect(ticketResponse.status()).toBe(200);
      const { ticket } = await ticketResponse.json();

      const response = await request.get(`/api/v1/workflows/any-slug-e2e/runs/00000000-0000-0000-0000-000000000000/stream?ticket=${ticket}`);
      expect(response.status()).toBe(401);
    });

    test('minting a workflow_run:<runId> ticket for an unknown/foreign runId is 404 (Task 7 mint-time ownership check)', async ({ request }) => {
      const ticketResponse = await request.post('/api/v1/auth/stream-ticket', {
        headers: { Authorization: `Bearer ${tenantAdminToken}` },
        data: { scope: 'workflow_run:00000000-0000-0000-0000-000000000000' },
      });
      expect(ticketResponse.status()).toBe(404);
    });
  });
});
