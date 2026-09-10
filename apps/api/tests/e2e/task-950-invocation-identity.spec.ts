/**
 * TASK-950 §C5 — an AGENT INVOCATION by a service account provisions the clinician the tenant's
 * context schema names.
 *
 * The ticket's claim on this plane, as HTTP calls, in the order an integrator actually makes
 * them:
 *
 *   publish a schema whose STRUCTURED kind marks one property as the user identity ->
 *   publish an agent bound to that schema -> invoke it as a MACHINE with a staff id the tenant
 *   has never seen -> a HOPE user now exists carrying that `staffId` on its profile ->
 *   invoke again with the same value -> the SAME user, none created ->
 *   invoke as a HUMAN with a fresh value -> nothing created (D-5).
 *
 * ─── What this spec does NOT cover, and why ────────────────────────────────
 *
 * The WORKFLOW half (`POST /workflows/:slug/runs`) is covered by UNIT tests only —
 * `packages/applications/src/services/workflow-exposure/__tests__/workflow-exposure.user-identity.task950.test.ts`.
 * Reaching it end to end needs a workflow whose `core.trigger` binds a context schema BY
 * REFERENCE, and authoring one over HTTP means composing a whole `core` graph, compiling it and
 * publishing it through the workflow-definition admin routes — several hundred lines of fixture
 * whose failure modes belong to the compiler, not to this ticket. The two planes share the same
 * resolver contract and the same three refusal families; the agent half below exercises them
 * against the live gateway, and the workflow half pins its own wiring (subject, sys-event,
 * consultation-bound exemption) against mocks.
 *
 * ─── How to run it ─────────────────────────────────────────────────────────
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-950
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed.)
 *
 * ─── Fixtures it needs ─────────────────────────────────────────────────────
 *
 * A seeded database, and nothing hand-made:
 *   · `arcaai_admin` (tenant key `ARCAAI`, password `password123`) — the tenant admin that
 *     authors the schema and the agent, and reads the provisioned user back;
 *   · the ArcaAI service account `hope_svc_a4ca1a11ad3141b0c0de0001` with its dev fixture secret
 *     (`SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN`, seeded only in development/test). Its
 *     scope list (`seed/94-service-account.ts`, `ARCAAI_TENANT_ADMIN_SVC_SCOPES`) carries
 *     `svc:agent:definition:read` and `svc:agent:invocation:write` — VERIFIED in that file at the
 *     "Renamespaced from the API-key scopes of the same name" block — which is exactly what the
 *     two agent routes below demand;
 *   · `GEN_ARCAAI` (`70000000-0000-0000-0001-000000000001`) as the department auto-provisioning
 *     places the new clinician in.
 *
 * Staff ids are generated per run, so the spec is re-runnable and never joins a user a previous
 * run provisioned.
 *
 * ─── Two deliberate tolerances ─────────────────────────────────────────────
 *
 *  1. **`apps/text` may be unreachable.** The identity is resolved BEFORE the model call, so a
 *     502/503 from the generation still proves the provisioning — the assertions that matter are
 *     about the USER, not about the completion. A 503 carrying
 *     `code: 'USER_IDENTITY_RESOLVER_UNAVAILABLE'` is NOT tolerated: that one is this ticket's
 *     own wiring failing, and it must never hide behind "TEXT is down".
 *  2. **Publishing the probe agent is fixture work, not the claim.** If the publish gate refuses
 *     it for a reason of its own, the spec SKIPS with the response body rather than reporting a
 *     TASK-950 failure. The schema publish (step 1) is a hard assertion — the marker being
 *     accepted at publish IS part of the contract.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginUser } from '../../../../tests/helpers';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';
const SEED_PASSWORD = 'password123';
const GEN_ARCAAI = '70000000-0000-0000-0001-000000000001';

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

const ADMIN_SCHEMAS = '/api/v1/admin/consultation-context-schemas';
const ADMIN_AGENTS = '/api/v1/admin/agents';
const ADMIN_USERS = '/api/v1/admin/users';

/** The kind key is the namespace root, so a caller may send the payload flat OR wrapped (J3-5). */
const KIND = 'context';
const IDENTITY_FIELD = 'consultant_id';

/**
 * One STRUCTURED kind carrying the D-1 marker. `fields` stays OPEN so this probe never fights the
 * payload validator over an unrelated property — the thing under test is the identity mapping.
 */
const definitionWithMarker = () => ({
  schemaVersion: '1.0',
  kinds: [
    {
      key: KIND,
      label: 'Consultation Context',
      primitive: 'STRUCTURED',
      phiClass: 'NON_PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      fields: {
        type: 'object',
        properties: { [IDENTITY_FIELD]: { type: 'string' } },
        additionalProperties: true,
      },
      userIdentity: { field: IDENTITY_FIELD },
    },
  ],
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const svcHeaders = (token: string) => ({ 'X-Service-Account-Token': token, 'Content-Type': 'application/json' });

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET },
  });
  expect(res.status(), `service-token exchange — body: ${await res.text()}`).toBe(200);
  return (await res.json()).accessToken as string;
}

/** A staff id unique to this run, so the resolver always takes its PROVISION branch first. */
const staffId = (suffix: string) => `DR-950E-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Every AUTO-PROVISIONED user in the ArcaAI tenant, as `{ id, username }`.
 *
 * There is no by-`staffId` filter on `GET admin/users` and adding one is not this lane's route to
 * add, so the probe is a BEFORE/AFTER diff over the `auto_<16 hex>` username shape D-8 mints —
 * which needs no new endpoint and cannot collide with a seeded user. `limit` is generous because
 * the set grows by one per run of this spec.
 */
async function autoProvisionedUsers(request: APIRequestContext, token: string): Promise<Map<string, string>> {
  const res = await request.get(`${ADMIN_USERS}?page=0&limit=500`, { headers: auth(token) });
  expect(res.status(), `list users — body: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { data: Array<{ id: string; username: string }> };
  return new Map(body.data.filter((user) => /^auto_[0-9a-f]{16}$/.test(user.username)).map((user) => [user.id, user.username]));
}

// ─── Suite ──────────────────────────────────────────────────────────────────

// SERIAL: the schema, the agent and the provisioned users are stateful setup that later tests
// read back by id. Under `fullyParallel: true` Playwright would re-run `beforeAll` per worker.
test.describe.configure({ mode: 'serial' });

test.describe('TASK-950 — a machine invocation resolves the schema’s user-identity field', () => {
  let adminToken: string;
  let svcToken: string;
  let schemaId = '';
  let agentId = '';
  let agentSlug = '';
  /** Set when the fixture agent could not be published; every dependent test skips with it. */
  let fixtureBlocked: string | null = null;

  const slug = `task950_identity_${Date.now().toString(36)}`;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, ARCAAI_TENANT_KEY);
    expect(admin, 'arcaai_admin login failed — is the stack seeded?').toBeTruthy();
    adminToken = admin!.token;
    svcToken = await serviceAccountToken(request);

    // D-9/OD-8 — auto-provisioning needs a department to put the new clinician in, and the
    // platform tier deliberately does not supply one (a tenant's department id cannot ride in a
    // SYSTEM row). Set ArcaAI's, and leave it set: the value is a real ArcaAI department and
    // writing it again is idempotent, so the spec stays re-runnable without a teardown that
    // would break a concurrent run.
    const setDepartment = await request.put('/api/v1/admin/settings/registry/identity.autoProvision.departmentId', {
      headers: auth(adminToken),
      data: { value: GEN_ARCAAI },
    });
    if (![200, 201].includes(setDepartment.status())) {
      fixtureBlocked = `identity.autoProvision.departmentId is not writable here (${setDepartment.status()}): ${await setDepartment.text()}`;
    }
  });

  test.afterAll(async ({ request }) => {
    if (agentId) await request.delete(`${ADMIN_AGENTS}/${agentId}`, { headers: auth(adminToken) }).catch(() => undefined);
    if (schemaId) await request.delete(`${ADMIN_SCHEMAS}/${schemaId}`, { headers: auth(adminToken) }).catch(() => undefined);
  });

  // ── 1. The marker survives a real publish ─────────────────────────────────

  test('publishes a context schema whose STRUCTURED kind marks one property as the user identity', async ({ request }) => {
    const created = await request.post(ADMIN_SCHEMAS, {
      headers: auth(adminToken),
      // NOT `isDefault` — this probe must never become the tenant's serving schema, which would
      // change what every other ArcaAI consultation validates against.
      data: { slug, name: 'TASK-950 identity probe', scope: 'TENANT', isDefault: false },
    });
    expect(created.status(), `create schema — body: ${await created.text()}`).toBe(201);
    schemaId = ((await created.json()) as { id: string }).id;

    const published = await request.post(`${ADMIN_SCHEMAS}/${schemaId}/publish`, {
      headers: auth(adminToken),
      data: { definition: definitionWithMarker(), changeReason: 'TASK-950 live verification' },
    });

    // A hard assertion: the publish gate ACCEPTING a well-formed marker is part of the contract.
    expect(published.status(), `publish schema — body: ${await published.text()}`).toBe(201);
    const schema = await published.json();
    expect(schema.status).toBe('PUBLISHED');
    expect(schema.pinnedVersionNumber).toBe(1);
  });

  // ── 2. An agent bound to it ───────────────────────────────────────────────

  test('publishes a TEXT_GENERATION agent bound to that schema', async ({ request }) => {
    test.skip(schemaId === '', 'the probe schema was not created');

    // Borrow a model this tenant already runs a TEXT_GENERATION agent on, rather than naming a
    // catalogue id here — a literal would rot with the seed.
    const agents = await request.get(`${ADMIN_AGENTS}?task=TEXT_GENERATION`, { headers: auth(adminToken) });
    expect(agents.status(), `list agents — body: ${await agents.text()}`).toBe(200);
    const modelId = ((await agents.json()) as Array<{ modelId: string }>)[0]?.modelId;
    test.skip(!modelId, 'ArcaAI has no TEXT_GENERATION agent to borrow a model id from');

    const created = await request.post(ADMIN_AGENTS, {
      headers: auth(adminToken),
      data: {
        slug,
        name: 'TASK-950 identity probe agent',
        task: 'TEXT_GENERATION',
        modelId,
        contextSchemaId: schemaId,
        contextSchemaVersionNumber: 1,
        // The inline instruction form: no template to approve, and no placeholder that could turn
        // an unrelated authoring gap into a 400 on the invocation below.
        instruction: { systemPrompt: 'Summarise the clinical note in one sentence.' },
      },
    });
    if (created.status() !== 201) {
      fixtureBlocked = `create agent (${created.status()}): ${await created.text()}`;
      test.skip(true, fixtureBlocked);
    }
    const agent = (await created.json()) as { id: string; slug: string };
    agentId = agent.id;
    agentSlug = agent.slug;

    const published = await request.post(`${ADMIN_AGENTS}/${agentId}/publish`, { headers: auth(adminToken), data: { activate: true } });
    if (published.status() !== 201 && published.status() !== 200) {
      fixtureBlocked = `publish agent (${published.status()}): ${await published.text()}`;
      test.skip(true, fixtureBlocked);
    }
    expect((await published.json()).status).toBe('PUBLISHED');
  });

  // ── 3. The claim ──────────────────────────────────────────────────────────

  const reusableStaffId = staffId('reuse');

  test('a MACHINE invocation with an unknown staff id provisions the clinician', async ({ request }) => {
    test.skip(fixtureBlocked !== null, fixtureBlocked ?? '');
    test.skip(agentSlug === '', 'the probe agent was not published');

    const before = await autoProvisionedUsers(request, adminToken);

    const response = await request.post(`/api/v1/agents/${agentSlug}/invocations`, {
      headers: svcHeaders(svcToken),
      data: { text: 'Patient reports a mild headache.', context: { [KIND]: { [IDENTITY_FIELD]: reusableStaffId } } },
    });

    // TOLERANCE 1 — and its one exception. Identity is resolved before the model call, so a dead
    // TEXT service does not invalidate what follows; an unwired identity resolver does.
    const body = await response.text();
    expect(body, 'the identity resolver must be wired — this 503 is not "TEXT is down"').not.toContain('USER_IDENTITY_RESOLVER_UNAVAILABLE');
    expect([200, 502, 503], `invoke — body: ${body}`).toContain(response.status());

    const after = await autoProvisionedUsers(request, adminToken);
    const created = [...after.keys()].filter((id) => !before.has(id));
    expect(created, `exactly one auto-provisioned user should have appeared (before ${before.size}, after ${after.size})`).toHaveLength(1);

    const profile = await request.get(`${ADMIN_USERS}/${created[0]}/profile`, { headers: auth(adminToken) });
    expect(profile.status(), `read the new user's profile — body: ${await profile.text()}`).toBe(200);
    expect((await profile.json()).staffId, 'the schema field lands on UserProfile.staffId (R2)').toBe(reusableStaffId);
  });

  test('a SECOND invocation with the same staff id reuses that user — nothing is created', async ({ request }) => {
    test.skip(fixtureBlocked !== null, fixtureBlocked ?? '');
    test.skip(agentSlug === '', 'the probe agent was not published');

    const before = await autoProvisionedUsers(request, adminToken);

    const response = await request.post(`/api/v1/agents/${agentSlug}/invocations`, {
      headers: svcHeaders(svcToken),
      data: { text: 'Follow-up.', context: { [KIND]: { [IDENTITY_FIELD]: reusableStaffId } } },
    });
    expect([200, 502, 503], `invoke — body: ${await response.text()}`).toContain(response.status());

    const after = await autoProvisionedUsers(request, adminToken);
    expect([...after.keys()].filter((id) => !before.has(id)), 'a known staff id must resolve, never re-provision').toHaveLength(0);
  });

  test('a HUMAN caller sending the same field provisions nobody (D-5)', async ({ request }) => {
    test.skip(fixtureBlocked !== null, fixtureBlocked ?? '');
    test.skip(agentSlug === '', 'the probe agent was not published');

    const before = await autoProvisionedUsers(request, adminToken);

    const response = await request.post(`/api/v1/agents/${agentSlug}/invocations`, {
      headers: auth(adminToken),
      data: { text: 'Human-driven call.', context: { [KIND]: { [IDENTITY_FIELD]: staffId('human') } } },
    });
    expect([200, 502, 503], `invoke — body: ${await response.text()}`).toContain(response.status());

    const after = await autoProvisionedUsers(request, adminToken);
    expect([...after.keys()].filter((id) => !before.has(id)), 'a human caller already IS the clinician — mapping a different one would be impersonation').toHaveLength(
      0,
    );
  });

  test('a blank staff id never mints a user', async ({ request }) => {
    test.skip(fixtureBlocked !== null, fixtureBlocked ?? '');
    test.skip(agentSlug === '', 'the probe agent was not published');

    const before = await autoProvisionedUsers(request, adminToken);

    const response = await request.post(`/api/v1/agents/${agentSlug}/invocations`, {
      headers: svcHeaders(svcToken),
      data: { text: 'Bad identity.', context: { [KIND]: { [IDENTITY_FIELD]: '   ' } } },
    });

    // Two answers are defensible and this spec deliberately accepts both: a whitespace-only value
    // may be REFUSED as a malformed identity (400 `USER_IDENTITY_INVALID`, D-10 normalisation) or
    // read as "no value supplied" and ignored (D-2). What is NOT defensible either way is
    // provisioning a clinician whose staff id is blank — a row nothing could ever match again.
    // The status is recorded in the message so a change of posture is visible when this runs.
    expect(
      [200, 400, 404, 502, 503],
      `invoke with a blank staff id answered ${response.status()} — body: ${await response.text()}`,
    ).toContain(response.status());

    const after = await autoProvisionedUsers(request, adminToken);
    expect([...after.keys()].filter((id) => !before.has(id)), 'a blank identity must provision nobody').toHaveLength(0);
  });

  test('the tenant that owns the probe is the one the machine acted in', async ({ request }) => {
    test.skip(fixtureBlocked !== null, fixtureBlocked ?? '');
    test.skip(schemaId === '', 'the probe schema was not created');

    // The service account binds its working tenant at EXCHANGE, so no `X-Tenant-Id` was ever
    // sent above. Pinning the schema's owner here is what makes that claim checkable: if the
    // machine had acted somewhere else, the users read back would have been another tenant's.
    const schema = await request.get(`${ADMIN_SCHEMAS}/${schemaId}`, { headers: auth(adminToken) });
    expect(schema.status()).toBe(200);
    expect((await schema.json()).tenantId).toBe(ARCAAI_TENANT_ID);
  });
});
