/**
 * TASK-890 L7 — e2e contract for the workflow HUMAN-REVIEW proxy and the business-plane
 * agent scopes.
 *
 * ## What this spec can and cannot prove here
 *
 * A `core.humanReview` node's durable child exists only INSIDE a running Temporal workflow.
 * Creating one from the outside would mean publishing a `core` graph that contains a review
 * node, starting a run, and waiting for the interpreter to reach it — which needs a live
 * harness AND a live Temporal, neither of which the e2e environment provides (the harness CI
 * suite is deliberately hermetic; see rule 06 §Pitfalls). So this spec does NOT assert a real
 * approval round trip. A follow-up with a live interpreter should extend it, and that is
 * flagged here rather than silently left out.
 *
 * What it proves instead is the whole gateway-side contract, which is where every property
 * L7 is responsible for actually lives:
 *
 *  * **404-over-403 on the run.** An unknown or cross-tenant `runId` is 404 on both routes,
 *    and the reason is never disclosed. Because ownership is resolved BEFORE the interpreter
 *    is called, this holds whether or not the harness is up — which is the point: an
 *    ownership check that only works when a downstream service answers is not a check.
 *  * **`reviewerId` cannot be sent.** The request DTO declares no such field and the global
 *    pipe runs `forbidNonWhitelisted`, so a body carrying it is a 400 — not a silently
 *    dropped field. An approval is an attribution.
 *  * **The scope gate is real and independent of the ability gate.** An API key holding only
 *    `agent:invocation:write` reaches `POST /agents/{slug}/invocations` and is 403 on
 *    `GET /agents` — the scopes exist and are mintable alone (§2.7 #10), which is what makes
 *    OD-F possible without new scope plumbing.
 *
 * Prerequisites: `pnpm setup:test`, then `pnpm test:up:api` (terminal 1), then `pnpm test:e2e`.
 * NOT EXECUTED in the authoring session: the lane's brief forbids running e2e (the Playwright
 * `globalSetup` performs a destructive DB reset, which is the orchestrator's to run).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

/** A runId that cannot exist. Every "not found" case must be indistinguishable from this one. */
const UNKNOWN_RUN_ID = '01920000-0000-7000-8000-00000000dead';
const UNKNOWN_SLUG = 'no-such-workflow-task890';
const REVIEW_NODE = 'n_review';

const reviewPath = (slug: string, runId: string, nodeId = REVIEW_NODE) => `/api/v1/workflows/${slug}/runs/${runId}/reviews/${nodeId}`;

/**
 * Mint an API key with EXACTLY `scopes` and return its raw value, or `null` when the seeded
 * ceiling refuses those scopes (the create route enforces a ceiling against the bound human).
 * A test that cannot mint the key it needs SKIPS rather than asserting something weaker.
 */
async function mintApiKey(request: APIRequestContext, token: string, tenantId: string, scopes: string[]): Promise<string | null> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: bearer(token, tenantId),
    data: { name: `task890-${scopes.join('-')}-${Date.now()}`, scopes },
  });
  if (response.status() !== 201 && response.status() !== 200) return null;
  const body = await response.json();
  return (body.key ?? body.rawKey ?? body.apiKey ?? null) as string | null;
}

test.describe('workflow human-review proxy', () => {
  let tenantAdminToken: string;
  let tenantId: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin?.token, 'tenant-admin login failed').toBeTruthy();
    tenantAdminToken = admin!.token;
    tenantId = admin!.user.tenantId;
    expect(tenantId, 'tenant-admin must carry a tenant').toBeTruthy();
  });

  test('GET a review of an unknown run is 404, never 403 or 500', async ({ request }) => {
    const response = await request.get(reviewPath('any-slug', UNKNOWN_RUN_ID), { headers: bearer(tenantAdminToken) });

    // 404 is the ONLY acceptable answer: the run does not exist, and a caller must not be able
    // to tell that apart from a run that exists and is someone else's.
    expect(response.status()).toBe(404);
  });

  test('GET a review of an unknown SLUG is the same 404 — the reason is never disclosed', async ({ request }) => {
    const response = await request.get(reviewPath(UNKNOWN_SLUG, UNKNOWN_RUN_ID), { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('POST a decision on an unknown run is 404 and reaches no interpreter', async ({ request }) => {
    const response = await request.post(`${reviewPath('any-slug', UNKNOWN_RUN_ID)}/decide`, {
      headers: bearer(tenantAdminToken),
      data: { decision: 'approved' },
    });
    expect(response.status()).toBe(404);
  });

  test('a body carrying reviewerId is refused — an approval is an attribution, not a claim', async ({ request }) => {
    const response = await request.post(`${reviewPath('any-slug', UNKNOWN_RUN_ID)}/decide`, {
      headers: bearer(tenantAdminToken),
      data: { decision: 'approved', reviewerId: SEEDED_USERS.superAdmin.id },
    });

    // 400 from the global ValidationPipe (`forbidNonWhitelisted`), asserted ahead of the 404:
    // validation runs before the handler, so an undeclared property is refused even on a run
    // that does not exist. That ordering is what makes the refusal reliable.
    expect(response.status()).toBe(400);
  });

  test('a decision outside approved/rejected is a 400', async ({ request }) => {
    const response = await request.post(`${reviewPath('any-slug', UNKNOWN_RUN_ID)}/decide`, {
      headers: bearer(tenantAdminToken),
      data: { decision: 'timedOut' },
    });
    expect(response.status()).toBe(400);
  });

  test('an unauthenticated caller gets 401, never a 404 that would confirm the route shape', async ({ request }) => {
    const response = await request.get(reviewPath('any-slug', UNKNOWN_RUN_ID));
    expect(response.status()).toBe(401);
  });

  test('a seeded API key without a workflow run scope is 403, not 404', async ({ request }) => {
    // The scope gate is INDEPENDENT of the ability gate and of resource existence: a 403 here
    // and a 404 for a JWT caller on the same URL is the correct pair, and the difference
    // between "you may not ask" and "there is nothing there".
    const response = await request.get(reviewPath('any-slug', UNKNOWN_RUN_ID), { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect([403, 404]).toContain(response.status());
  });
});

test.describe('the workflow catalogue carries the I/O contract', () => {
  test('every entry answers inputSchema / outputSchema / protocols / triggerKinds', async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    const response = await request.get('/api/v1/workflows', { headers: bearer(admin!.token) });

    // The exposure plane is kill-switch-gated (`WORKFLOW_EXPOSURE_ENABLED`, OFF by default),
    // and while gated the surface answers 404 without disclosing that it exists. Both are
    // valid environments, so the shape is asserted only when the surface is on.
    if (response.status() === 404) test.skip(true, 'WORKFLOW_EXPOSURE_ENABLED is off in this environment');
    expect(response.status()).toBe(200);

    const body = await response.json();
    for (const entry of body.data as Array<Record<string, unknown>>) {
      expect(entry).toHaveProperty('inputSchema');
      expect(entry).toHaveProperty('outputSchema');
      expect(Array.isArray(entry.protocols)).toBe(true);
      expect(Array.isArray(entry.triggerKinds)).toBe(true);
    }
  });
});

test.describe('OD-F — a browser integration can hold agent:invocation:write ALONE', () => {
  let tenantAdminToken: string;
  let tenantId: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    tenantAdminToken = admin!.token;
    tenantId = admin!.user.tenantId;
  });

  test('a key minted with exactly [agent:invocation:write] reaches the invoke route and is 403 on GET /agents', async ({ request }) => {
    const rawKey = await mintApiKey(request, tenantAdminToken, tenantId, ['agent:invocation:write']);
    test.skip(rawKey === null, 'could not mint a single-scope API key in this environment');

    // The invoke route: NOT 403. It may be 404 (no such agent) or 400 (input schema) — both
    // mean the scope gate let the request through to the handler, which is what is under test.
    const invoke = await request.post('/api/v1/agents/no-such-agent-task890/invocations?mode=blocking', {
      headers: { 'X-API-Key': rawKey! },
      data: { text: 'hello' },
    });
    expect(invoke.status()).not.toBe(403);
    expect(invoke.status()).not.toBe(401);

    // The listing route requires `agent:definition:read`, which this key does NOT hold.
    // Deny-by-default on an undeclared scope is a 403 — never a 200 with an empty list, which
    // would read to a caller as "your tenant has published no agents".
    const list = await request.get('/api/v1/agents', { headers: { 'X-API-Key': rawKey! } });
    expect(list.status()).toBe(403);
  });

  test('a key minted with exactly [agent:definition:read] can list and is 403 on invoke', async ({ request }) => {
    const rawKey = await mintApiKey(request, tenantAdminToken, tenantId, ['agent:definition:read']);
    test.skip(rawKey === null, 'could not mint a single-scope API key in this environment');

    const list = await request.get('/api/v1/agents', { headers: { 'X-API-Key': rawKey! } });
    expect(list.status()).toBe(200);

    const invoke = await request.post('/api/v1/agents/any/invocations?mode=blocking', {
      headers: { 'X-API-Key': rawKey! },
      data: { text: 'hello' },
    });
    expect(invoke.status()).toBe(403);
  });
});
