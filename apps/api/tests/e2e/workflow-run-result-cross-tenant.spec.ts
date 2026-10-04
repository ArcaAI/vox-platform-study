/**
 * TASK-1038 D-I — `GET /api/v1/workflows/:slug/runs/:runId/result`: 404-over-403 across tenants.
 *
 * The route serves what a run DELIVERED (inline JSON, or a short-lived signed URL). The output is
 * PHI, so the cross-tenant posture matters more here than on the status route it mirrors:
 *
 *  1. an unknown run id is 404 for every tenant — and never 403, which would confirm existence;
 *  2. a REAL run owned by tenant A is 404 to tenant B (same answer as an unknown id), while
 *     tenant A gets a non-404 answer for the same URL (200 / 204 / 409 / 410);
 *  3. the route carries the status route's scope: a key without `workflow:run:read` is 403
 *     on its OWN tenant's id space, and no credential at all is 401.
 *
 * Case 2 needs a run row, and a run row is only written by `invoke` reaching the harness
 * dispatcher. Against the isolated e2e stack (no harness) `invoke` fails at that boundary, so
 * case 2 SKIPS with that reason rather than passing vacuously; against a full local stack
 * (`pnpm stack:dev`) it runs.
 *
 * Prerequisites: API on the test DB (`pnpm test:up:api`), seeded. Not executed by the lane that
 * wrote it (TASK-1038 A2) — the orchestrator runs the e2e suite after the merge.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

interface CreatedApiKey {
  id: string;
  rawKey: string;
}

const UNKNOWN_RUN = '00000000-0000-0000-0000-000000000000';

async function createScopedApiKey(request: APIRequestContext, token: string, scopes: string[], namePrefix: string): Promise<CreatedApiKey> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: { Authorization: `Bearer ${token}` },
    data: { keyName: `${namePrefix}-${Date.now()}`, keyType: 'SDK', scopes },
  });
  expect(response.status(), `API key creation failed for ${namePrefix}`).toBe(201);
  const body = await response.json();
  return { id: body.apiKey.id, rawKey: body.rawKey };
}

const VALID_GRAPH = {
  version: 1,
  nodes: [
    { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
    { id: 'n_output', type: 'core.output', config: { protocols: ['http'] } },
  ],
  edges: [{ id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_output', toPort: 'after' }],
};

async function createPublishedWorkflow(request: APIRequestContext, token: string, slug: string): Promise<void> {
  const created = await request.post('/api/v1/admin/workflow-definitions', {
    headers: { Authorization: `Bearer ${token}` },
    data: { slug, name: `E2E ${slug}`, paletteKey: 'core', graph: VALID_GRAPH },
  });
  expect(created.status(), `create workflow definition '${slug}'`).toBe(201);
  const definition = await created.json();
  const published = await request.post(`/api/v1/admin/workflow-definitions/${definition.id}/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'If-Match': `"${definition.version}"` },
    data: {},
  });
  expect(published.status(), `publish workflow definition '${slug}'`).toBe(200);
}

test.describe('GET /api/v1/workflows/:slug/runs/:runId/result — cross-tenant', () => {
  let ownerAdminToken: string;
  let foreignAdminToken: string;
  const ownerKeyIds: string[] = [];
  const foreignKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const owner = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(owner?.token, 'owner-tenant admin login failed').toBeTruthy();
    ownerAdminToken = owner!.token as string;
    // ARCAAI is the super admin's own tenant in the seed — used purely as "a foreign tenant",
    // exactly as `task-722-workflow-exposure.spec.ts` does.
    const foreign = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(foreign?.token, 'foreign-tenant login failed').toBeTruthy();
    foreignAdminToken = foreign!.token as string;
  });

  test.afterAll(async ({ request }) => {
    for (const id of ownerKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: { Authorization: `Bearer ${ownerAdminToken}` } }).catch(() => {});
    }
    for (const id of foreignKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: { Authorization: `Bearer ${foreignAdminToken}` } }).catch(() => {});
    }
  });

  test('an unknown run id is 404 for both tenants — never 403', async ({ request }) => {
    const ownerKey = await createScopedApiKey(request, ownerAdminToken, ['workflow:run:read'], 'task-1038-result-unknown-owner');
    ownerKeyIds.push(ownerKey.id);
    const foreignKey = await createScopedApiKey(request, foreignAdminToken, ['workflow:run:read'], 'task-1038-result-unknown-foreign');
    foreignKeyIds.push(foreignKey.id);

    for (const key of [ownerKey, foreignKey]) {
      const response = await request.get(`/api/v1/workflows/any_slug_e2e/runs/${UNKNOWN_RUN}/result`, { headers: { 'X-API-Key': key.rawKey } });
      expect(response.status()).toBe(404);
    }
  });

  test('a run owned by tenant A is 404 to tenant B, and not 404 to tenant A', async ({ request }) => {
    const slug = `e2e_result_${Date.now()}`;
    await createPublishedWorkflow(request, ownerAdminToken, slug);
    const writer = await createScopedApiKey(request, ownerAdminToken, ['workflow:run:write'], 'task-1038-result-writer');
    ownerKeyIds.push(writer.id);

    const started = await request.post(`/api/v1/workflows/${slug}/runs`, { headers: { 'X-API-Key': writer.rawKey }, data: { input: {} } });
    test.skip(started.status() !== 202, `no harness dispatcher reachable (invoke answered ${started.status()}); a run row cannot be created here`);
    const { runId } = (await started.json()) as { runId: string };

    const ownerReader = await createScopedApiKey(request, ownerAdminToken, ['workflow:run:read'], 'task-1038-result-owner');
    ownerKeyIds.push(ownerReader.id);
    const foreignReader = await createScopedApiKey(request, foreignAdminToken, ['workflow:run:read'], 'task-1038-result-foreign');
    foreignKeyIds.push(foreignReader.id);

    const asForeign = await request.get(`/api/v1/workflows/${slug}/runs/${runId}/result`, { headers: { 'X-API-Key': foreignReader.rawKey } });
    expect(asForeign.status(), 'a foreign tenant must not learn the run exists').toBe(404);
    const unknownAsForeign = await request.get(`/api/v1/workflows/${slug}/runs/${UNKNOWN_RUN}/result`, {
      headers: { 'X-API-Key': foreignReader.rawKey },
    });
    expect(asForeign.status(), 'foreign answer is indistinguishable from an unknown id').toBe(unknownAsForeign.status());

    const asOwner = await request.get(`/api/v1/workflows/${slug}/runs/${runId}/result`, { headers: { 'X-API-Key': ownerReader.rawKey } });
    expect([200, 204, 409, 410]).toContain(asOwner.status());
    if (asOwner.status() === 409) {
      const body = await asOwner.json();
      expect(JSON.stringify(body)).toContain('RUN_NOT_TERMINAL');
    }
  });

  test('a key without workflow:run:read is 403 on its own tenant; no credential is 401', async ({ request }) => {
    const writeOnly = await createScopedApiKey(request, ownerAdminToken, ['workflow:run:write'], 'task-1038-result-noscope');
    ownerKeyIds.push(writeOnly.id);
    const scoped = await request.get(`/api/v1/workflows/any_slug_e2e/runs/${UNKNOWN_RUN}/result`, { headers: { 'X-API-Key': writeOnly.rawKey } });
    expect(scoped.status()).toBe(403);

    const anonymous = await request.get(`/api/v1/workflows/any_slug_e2e/runs/${UNKNOWN_RUN}/result`);
    expect(anonymous.status()).toBe(401);
  });
});
