/**
 * TASK-1038 OD-26 (lane B6a) — `/api/v1/agents/:slug/runs/:runId{,/result,/cancel,/events}`:
 * 404-over-403 across tenants, against the DURABLE run record.
 *
 * An agent run is a `WorkflowRun` row with `kind = AGENT` (it used to be a Redis document). Its
 * result is the agent's output — PHI — so:
 *
 *  1. an unknown run id is 404 on every by-id route, for every tenant — never 403;
 *  2. a REAL run owned by tenant A is 404 to tenant B on every by-id route (the same answer as an
 *     unknown id), the foreign cancel changes nothing, and tenant A still reads its run;
 *  3. an agent run never appears in the WORKFLOW runs list (`GET admin/workflow-runs`) and is not
 *     addressable as a workflow run (`GET workflows/:slug/runs/:runId` → 404).
 *
 * Case 2 needs a PUBLISHED TEXT_GENERATION agent in the owner tenant. The start answers 202 before
 * the model is called, so the row exists even when no model is reachable (the run then ends
 * FAILED — which is still a run). When the seed carries no such agent, or the start is refused
 * before the 202, the case SKIPS with that reason rather than passing vacuously.
 *
 * Prerequisites: API on the test DB (`pnpm test:up:api`), seeded, migration
 * `task_1038_agent_run_read_model` applied. NOT executed by the lane that wrote it (TASK-1038 B6a)
 * — the orchestrator runs the e2e suite after the merge.
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

/** The slug of one published TEXT_GENERATION agent visible to the key's tenant, or `null`. */
async function findTextAgent(request: APIRequestContext, rawKey: string): Promise<string | null> {
  const response = await request.get('/api/v1/agents?task=TEXT_GENERATION', { headers: { 'X-API-Key': rawKey } });
  if (response.status() !== 200) return null;
  const body = (await response.json()) as unknown;
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown[]; items?: unknown[] }).data ?? (body as { items?: unknown[] }).items ?? []);
  const first = rows.find((row) => typeof (row as { slug?: unknown }).slug === 'string') as { slug: string } | undefined;
  return first?.slug ?? null;
}

test.describe('Agent runs — cross-tenant (404-over-403)', () => {
  let ownerAdminToken: string;
  let foreignAdminToken: string;
  const ownerKeyIds: string[] = [];
  const foreignKeyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const owner = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(owner?.token, 'owner-tenant admin login failed').toBeTruthy();
    ownerAdminToken = owner!.token as string;
    // ARCAAI is the super admin's own tenant in the seed — used purely as "a foreign tenant",
    // as `workflow-run-result-cross-tenant.spec.ts` does.
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

  test('an unknown run id is 404 on every by-id route, for both tenants — never 403', async ({ request }) => {
    const ownerKey = await createScopedApiKey(request, ownerAdminToken, ['agent:invocation:write'], 'task-1038-agentrun-unknown-owner');
    ownerKeyIds.push(ownerKey.id);
    const foreignKey = await createScopedApiKey(request, foreignAdminToken, ['agent:invocation:write'], 'task-1038-agentrun-unknown-foreign');
    foreignKeyIds.push(foreignKey.id);

    for (const key of [ownerKey, foreignKey]) {
      const headers = { 'X-API-Key': key.rawKey };
      expect((await request.get(`/api/v1/agents/any_agent_e2e/runs/${UNKNOWN_RUN}`, { headers })).status()).toBe(404);
      expect((await request.get(`/api/v1/agents/any_agent_e2e/runs/${UNKNOWN_RUN}/result`, { headers })).status()).toBe(404);
      expect((await request.post(`/api/v1/agents/any_agent_e2e/runs/${UNKNOWN_RUN}/cancel`, { headers })).status()).toBe(404);
      expect((await request.get(`/api/v1/agents/any_agent_e2e/runs/${UNKNOWN_RUN}/events`, { headers })).status()).toBe(404);
    }
  });

  test('a run owned by tenant A is 404 to tenant B on every by-id route; tenant A still reads it', async ({ request }) => {
    const ownerKey = await createScopedApiKey(request, ownerAdminToken, ['agent:definition:read', 'agent:invocation:write'], 'task-1038-agentrun-owner');
    ownerKeyIds.push(ownerKey.id);
    const slug = await findTextAgent(request, ownerKey.rawKey);
    test.skip(slug === null, 'the owner tenant has no published TEXT_GENERATION agent; an agent run cannot be created here');

    const started = await request.post(`/api/v1/agents/${slug}/runs`, { headers: { 'X-API-Key': ownerKey.rawKey }, data: { message: 'E2E probe.' } });
    test.skip(started.status() !== 202, `the run start was refused before the 202 (${started.status()}); no run row exists`);
    const { runId } = (await started.json()) as { runId: string };

    const foreignKey = await createScopedApiKey(request, foreignAdminToken, ['agent:invocation:write'], 'task-1038-agentrun-foreign');
    foreignKeyIds.push(foreignKey.id);
    const foreign = { 'X-API-Key': foreignKey.rawKey };

    const status = await request.get(`/api/v1/agents/${slug}/runs/${runId}`, { headers: foreign });
    const unknown = await request.get(`/api/v1/agents/${slug}/runs/${UNKNOWN_RUN}`, { headers: foreign });
    expect(status.status(), 'a foreign tenant must not learn the run exists').toBe(404);
    expect(status.status(), 'foreign answer is indistinguishable from an unknown id').toBe(unknown.status());
    expect((await request.get(`/api/v1/agents/${slug}/runs/${runId}/result`, { headers: foreign })).status()).toBe(404);
    expect((await request.post(`/api/v1/agents/${slug}/runs/${runId}/cancel`, { headers: foreign })).status()).toBe(404);
    expect((await request.get(`/api/v1/agents/${slug}/runs/${runId}/events`, { headers: foreign })).status()).toBe(404);

    const asOwner = await request.get(`/api/v1/agents/${slug}/runs/${runId}`, { headers: { 'X-API-Key': ownerKey.rawKey } });
    expect(asOwner.status()).toBe(200);
    const body = (await asOwner.json()) as { runId: string; agentSlug: string; status: string };
    expect(body).toMatchObject({ runId, agentSlug: slug });
    // The refused foreign cancel changed nothing (a race with the run's own end is fine).
    expect(['RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT']).toContain(body.status);

    const ownerResult = await request.get(`/api/v1/agents/${slug}/runs/${runId}/result`, { headers: { 'X-API-Key': ownerKey.rawKey } });
    expect([200, 204, 409]).toContain(ownerResult.status());
  });

  test('an agent run is not a workflow run: absent from the runs list, 404 on the workflow route', async ({ request }) => {
    const ownerKey = await createScopedApiKey(
      request,
      ownerAdminToken,
      ['agent:definition:read', 'agent:invocation:write', 'workflow:run:read'],
      'task-1038-agentrun-kind',
    );
    ownerKeyIds.push(ownerKey.id);
    const slug = await findTextAgent(request, ownerKey.rawKey);
    test.skip(slug === null, 'the owner tenant has no published TEXT_GENERATION agent; an agent run cannot be created here');

    const started = await request.post(`/api/v1/agents/${slug}/runs`, { headers: { 'X-API-Key': ownerKey.rawKey }, data: { message: 'E2E probe.' } });
    test.skip(started.status() !== 202, `the run start was refused before the 202 (${started.status()}); no run row exists`);
    const { runId } = (await started.json()) as { runId: string };

    const list = await request.get('/api/v1/admin/workflow-runs?limit=100&includeSandbox=true', { headers: { Authorization: `Bearer ${ownerAdminToken}` } });
    expect(list.status()).toBe(200);
    const page = (await list.json()) as { data: Array<{ runId: string }> };
    expect(page.data.map((row) => row.runId)).not.toContain(runId);

    const asWorkflow = await request.get(`/api/v1/workflows/${slug}/runs/${runId}`, { headers: { 'X-API-Key': ownerKey.rawKey } });
    expect(asWorkflow.status()).toBe(404);
  });
});
