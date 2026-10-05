/**
 * TASK-1038 OD-35 (owner decision 2026-10-05) — business-plane run reads are bound to the STARTING
 * principal, for workflow runs AND agent runs.
 *
 *  - An API key / service account reads (status, result, events / stream, stream-ticket, cancel)
 *    only the runs it started — unless it holds `workflow:run:read-all` / `agent:run:read-all`
 *    (`svc:` twins for a service account). Two keys bound to the SAME human are two principals.
 *  - A human JWT that is a SUPER_ADMIN or a TENANT_ADMIN of the working tenant reads every run of the
 *    tenant; any other human (a doctor) reads only the runs it started.
 *  - A run that exists but belongs to another principal answers 404, indistinguishable from an
 *    unknown run id (404-over-403; the run's existence is never revealed).
 *  - The same `Idempotency-Key` from two principals starts two runs; B never joins A's run.
 *
 * Needs a PUBLISHED TEXT_GENERATION agent (agent cases) and an exposed published workflow (workflow
 * cases) in the seeded default tenant; a case SKIPS with that reason rather than passing vacuously.
 *
 * Prerequisites: API on the test DB (`pnpm test:up:api`), seeded. NOT executed by the lane that
 * wrote it (TASK-1038 OD35) — the orchestrator runs the e2e suite after the merge.
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

function rowsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  const wrapped = body as { data?: unknown[]; items?: unknown[] };
  return (wrapped.data ?? wrapped.items ?? []) as Array<Record<string, unknown>>;
}

async function findTextAgent(request: APIRequestContext, rawKey: string): Promise<string | null> {
  const response = await request.get('/api/v1/agents?task=TEXT_GENERATION', { headers: { 'X-API-Key': rawKey } });
  if (response.status() !== 200) return null;
  const first = rowsOf(await response.json()).find((row) => typeof row.slug === 'string');
  return (first?.slug as string | undefined) ?? null;
}

async function findWorkflow(request: APIRequestContext, rawKey: string): Promise<string | null> {
  const response = await request.get('/api/v1/workflows', { headers: { 'X-API-Key': rawKey } });
  if (response.status() !== 200) return null;
  const first = rowsOf(await response.json()).find((row) => typeof row.slug === 'string');
  return (first?.slug as string | undefined) ?? null;
}

/** Every business-plane read of one run, as one credential sees it: the status codes. */
async function readStatuses(
  request: APIRequestContext,
  base: string,
  headers: Record<string, string>,
  eventsPath: string,
): Promise<Record<string, number>> {
  return {
    status: (await request.get(base, { headers })).status(),
    result: (await request.get(`${base}/result`, { headers })).status(),
    events: (await request.get(`${base}/${eventsPath}`, { headers, timeout: 5_000 }).catch(() => ({ status: () => -1 }))).status(),
    ticket: (await request.post(`${base}/stream-ticket`, { headers })).status(),
  };
}

test.describe('OD-35 — run reads bound to the starting principal', () => {
  let adminToken: string;
  let doctorToken: string;
  const keyIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin?.token, 'tenant admin login failed').toBeTruthy();
    adminToken = admin!.token as string;
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor?.token, 'doctor login failed').toBeTruthy();
    doctorToken = doctor!.token as string;
  });

  test.afterAll(async ({ request }) => {
    for (const id of keyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } }).catch(() => {});
    }
  });

  const key = async (request: APIRequestContext, scopes: string[], name: string): Promise<CreatedApiKey> => {
    const created = await createScopedApiKey(request, adminToken, scopes, name);
    keyIds.push(created.id);
    return created;
  };

  test('agent runs: key B (same bound admin as key A) gets the unknown-run 404 on every read and on cancel; A, read-all, and the tenant admin read it', async ({
    request,
  }) => {
    const scopes = ['agent:definition:read', 'agent:invocation:write'];
    const keyA = await key(request, scopes, 'od35-agent-a');
    const keyB = await key(request, scopes, 'od35-agent-b');
    const keyAll = await key(request, [...scopes, 'agent:run:read-all'], 'od35-agent-all');
    const slug = await findTextAgent(request, keyA.rawKey);
    test.skip(slug === null, 'no published TEXT_GENERATION agent in the default tenant');

    const started = await request.post(`/api/v1/agents/${slug}/runs`, { headers: { 'X-API-Key': keyA.rawKey }, data: { message: 'OD-35 probe.' } });
    test.skip(started.status() !== 202, `the run start was refused before the 202 (${started.status()})`);
    const { runId } = (await started.json()) as { runId: string };
    const base = `/api/v1/agents/${slug}/runs/${runId}`;

    const asB = await readStatuses(request, base, { 'X-API-Key': keyB.rawKey }, 'events');
    const unknownAsB = await readStatuses(request, `/api/v1/agents/${slug}/runs/${UNKNOWN_RUN}`, { 'X-API-Key': keyB.rawKey }, 'events');
    expect(asB).toEqual({ status: 404, result: 404, events: 404, ticket: 404 });
    expect(asB, 'indistinguishable from an unknown run').toEqual(unknownAsB);
    const bodyB = await (await request.get(base, { headers: { 'X-API-Key': keyB.rawKey } })).json();
    const bodyUnknown = await (await request.get(`/api/v1/agents/${slug}/runs/${UNKNOWN_RUN}`, { headers: { 'X-API-Key': keyB.rawKey } })).json();
    expect(bodyB.message).toBe(bodyUnknown.message);
    expect((await request.post(`${base}/cancel`, { headers: { 'X-API-Key': keyB.rawKey } })).status()).toBe(404);

    expect((await request.get(base, { headers: { 'X-API-Key': keyA.rawKey } })).status()).toBe(200);
    expect((await request.get(base, { headers: { 'X-API-Key': keyAll.rawKey } })).status()).toBe(200);
    expect((await request.get(base, { headers: { Authorization: `Bearer ${adminToken}` } })).status()).toBe(200);
    expect((await request.get(base, { headers: { Authorization: `Bearer ${doctorToken}` } })).status(), 'a doctor did not start it').toBe(404);
  });

  test('agent runs: the same Idempotency-Key from two keys starts two runs', async ({ request }) => {
    const scopes = ['agent:definition:read', 'agent:invocation:write'];
    const keyA = await key(request, scopes, 'od35-agent-idem-a');
    const keyB = await key(request, scopes, 'od35-agent-idem-b');
    const slug = await findTextAgent(request, keyA.rawKey);
    test.skip(slug === null, 'no published TEXT_GENERATION agent in the default tenant');
    const idem = `od35-${Date.now()}`;
    const a = await request.post(`/api/v1/agents/${slug}/runs`, {
      headers: { 'X-API-Key': keyA.rawKey, 'Idempotency-Key': idem },
      data: { message: 'x' },
    });
    const b = await request.post(`/api/v1/agents/${slug}/runs`, {
      headers: { 'X-API-Key': keyB.rawKey, 'Idempotency-Key': idem },
      data: { message: 'x' },
    });
    test.skip(a.status() !== 202 || b.status() !== 202, 'a run start was refused before the 202');
    expect((await a.json()).runId).not.toBe((await b.json()).runId);
  });

  test('workflow runs: key B gets the unknown-run 404 on status, result, stream, stream-ticket and cancel; read-all and the tenant admin read it', async ({
    request,
  }) => {
    const scopes = ['workflow:definition:read', 'workflow:run:read', 'workflow:run:write'];
    const keyA = await key(request, scopes, 'od35-wf-a');
    const keyB = await key(request, scopes, 'od35-wf-b');
    const keyAll = await key(request, [...scopes, 'workflow:run:read-all'], 'od35-wf-all');
    const slug = await findWorkflow(request, keyA.rawKey);
    test.skip(slug === null, 'no exposed published workflow in the default tenant');

    const started = await request.post(`/api/v1/workflows/${slug}/runs`, { headers: { 'X-API-Key': keyA.rawKey }, data: { input: {} } });
    test.skip(started.status() !== 202, `the run start was refused before the 202 (${started.status()})`);
    const { runId } = (await started.json()) as { runId: string };
    const base = `/api/v1/workflows/${slug}/runs/${runId}`;

    const asB = await readStatuses(request, base, { 'X-API-Key': keyB.rawKey }, 'stream');
    const unknownAsB = await readStatuses(request, `/api/v1/workflows/${slug}/runs/${UNKNOWN_RUN}`, { 'X-API-Key': keyB.rawKey }, 'stream');
    expect(asB).toEqual({ status: 404, result: 404, events: 404, ticket: 404 });
    expect(asB, 'indistinguishable from an unknown run').toEqual(unknownAsB);
    expect((await request.post(`${base}/cancel`, { headers: { 'X-API-Key': keyB.rawKey } })).status()).toBe(404);

    expect((await request.get(base, { headers: { 'X-API-Key': keyA.rawKey } })).status()).toBe(200);
    expect((await request.get(base, { headers: { 'X-API-Key': keyAll.rawKey } })).status()).toBe(200);
    expect((await request.get(base, { headers: { Authorization: `Bearer ${adminToken}` } })).status()).toBe(200);
    expect((await request.get(base, { headers: { Authorization: `Bearer ${doctorToken}` } })).status(), 'a doctor did not start it').toBe(404);

    // The ticket minted by A opens A's stream (the reader rides on the ticket, not the bound human).
    const ticket = await request.post(`${base}/stream-ticket`, { headers: { 'X-API-Key': keyA.rawKey } });
    test.skip(ticket.status() !== 201, `the workflow does not admit a streaming connection (${ticket.status()})`);
    const { sseUrl } = (await ticket.json()) as { sseUrl: string };
    const opened = await request.get(sseUrl, { timeout: 5_000 }).catch(() => null);
    if (opened) expect(opened.status()).toBe(200);
  });

  test('workflow runs: the same Idempotency-Key from two keys never joins the other’s run', async ({ request }) => {
    const scopes = ['workflow:definition:read', 'workflow:run:read', 'workflow:run:write'];
    const keyA = await key(request, scopes, 'od35-wf-idem-a');
    const keyB = await key(request, scopes, 'od35-wf-idem-b');
    const slug = await findWorkflow(request, keyA.rawKey);
    test.skip(slug === null, 'no exposed published workflow in the default tenant');
    const idem = `od35-${Date.now()}`;
    const a = await request.post(`/api/v1/workflows/${slug}/runs`, {
      headers: { 'X-API-Key': keyA.rawKey, 'Idempotency-Key': idem },
      data: { input: {} },
    });
    const b = await request.post(`/api/v1/workflows/${slug}/runs`, {
      headers: { 'X-API-Key': keyB.rawKey, 'Idempotency-Key': idem },
      data: { input: {} },
    });
    test.skip(a.status() !== 202 || b.status() !== 202, 'a run start was refused before the 202');
    expect((await a.json()).runId).not.toBe((await b.json()).runId);
  });
});
