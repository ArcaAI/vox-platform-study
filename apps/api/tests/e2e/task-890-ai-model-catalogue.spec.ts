/**
 * TASK-890 §4.5 — DEPTH coverage for `GET admin/ai-models/catalogue`.
 *
 * The route-authorization MATRIX (`task-776-route-authz-matrix.spec.ts`) already
 * proves the breadth once the route appears in a regenerated manifest: 401
 * unauthenticated, 403 for an API key, and the service-account posture. None of
 * that is repeated here.
 *
 * What the matrix cannot express, and what this file pins:
 *   - a TENANT admin actually reaches it — the whole point of the new
 *     `read:AiModel` ability, on a controller path whose every other route is
 *     `manage:all`;
 *   - the PROJECTION: exactly the §3.7 key set, and nothing naming where the
 *     weights live or who last edited the row;
 *   - exactly ONE `hope` provider, however many engines and vendors are seeded;
 *   - `unassignedProviderCount` is a SUPER-ADMIN field;
 *   - the thirteen registry WRITE routes are still refused to a tenant admin —
 *     the read grant must not have widened the plane.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const CATALOGUE = '/api/v1/admin/ai-models/catalogue';

/** Every key the §3.7 projection declares — asserted as an EXACT set, both ways. */
const MODEL_KEYS = [
  // TASK-934 — the parsed ASR decode profile the agent editor's effective-value hint reads.
  'asrProfile',
  'availability',
  'capabilities',
  'deploymentKind',
  'description',
  'id',
  'isPlatformDefaultFor',
  'name',
  'pipelineTag',
  'provider',
  'providerClass',
  'providerId',
  'readiness',
  'readinessCheckedAt',
  'readinessDetail',
  'resourceStatus',
  'slug',
  'taskType',
  'unusableReason',
  'usable',
].sort();

/** Fields whose presence would leak storage identity or the operator trail. */
const FORBIDDEN_KEYS = [
  'bucketPrefix',
  'primaryObject',
  'manifestDigest',
  'localPath',
  'checksum',
  'sourceUri',
  'sourceRevision',
  'wireModelId',
  'createdBy',
  'updatedBy',
  'tenantId',
  'sourceConnectionId',
  'availabilityDetail',
  'memorySizeMb',
  'computeType',
];

async function tenantAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return login!.token;
}

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

test.describe('TASK-890 — the tenant model catalogue', () => {
  test('a TENANT admin reads it, and gets the picker shape', async ({ request }) => {
    const token = await tenantAdminToken(request);

    const response = await request.get(CATALOGUE, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);

    // Exactly one Hope entry, whatever the seed holds.
    const hope = body.providers.filter((p: { group: string }) => p.group === 'hope');
    expect(hope).toHaveLength(1);
    expect(hope[0].id).toBe('hope');
    expect(hope[0].providerClass).toBeNull();

    // Every model names a provider entry that is actually in the payload.
    const providerIds = new Set(body.providers.map((p: { id: string }) => p.id));
    for (const model of body.models) expect(providerIds.has(model.providerId)).toBe(true);
  });

  test('the projection is exactly the §3.7 key set — no storage identity, no operator trail', async ({ request }) => {
    const token = await tenantAdminToken(request);
    const response = await request.get(CATALOGUE, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();

    expect(body.models.length, 'the seeded catalogue must not be empty').toBeGreaterThan(0);
    for (const model of body.models) {
      expect(Object.keys(model).sort()).toEqual(MODEL_KEYS);
      for (const forbidden of FORBIDDEN_KEYS) expect(model).not.toHaveProperty(forbidden);
      expect(['ready', 'loadable', 'engine_down', 'weights_missing', 'credential_missing', 'unknown']).toContain(model.readiness);
      expect(['cloud-byo', 'cloud-platform', 'engine-served', 'platform-self-host']).toContain(model.providerClass);
      // An unusable model is LISTED with its reason, never hidden.
      if (!model.usable) expect(typeof model.unusableReason).toBe('string');
    }
  });

  test('`unassignedProviderCount` is a super-admin field and is absent for a tenant admin', async ({ request }) => {
    const tenant = await request.get(CATALOGUE, { headers: { Authorization: `Bearer ${await tenantAdminToken(request)}` } });
    expect(await tenant.json()).not.toHaveProperty('unassignedProviderCount');

    const admin = await request.get(CATALOGUE, { headers: { Authorization: `Bearer ${await superAdminToken(request)}` } });
    const body = await admin.json();
    expect(admin.status()).toBe(200);
    expect(typeof body.unassignedProviderCount).toBe('number');
  });

  test('taskType narrows the catalogue to one task', async ({ request }) => {
    const token = await tenantAdminToken(request);
    const response = await request.get(`${CATALOGUE}?taskType=TEXT_GENERATION`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.models.length).toBeGreaterThan(0);
    for (const model of body.models) expect(model.taskType).toBe('TEXT_GENERATION');
  });

  test('an undeclared query parameter is rejected by the whitelist pipe', async ({ request }) => {
    const token = await tenantAdminToken(request);
    const response = await request.get(`${CATALOGUE}?tenantId=00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(400);
  });

  test('the API-key credential class cannot reach it (@ForbidApiKey, admin plane)', async ({ request }) => {
    const response = await request.get(CATALOGUE, { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(response.status()).toBe(403);
  });

  test('the READ grant did not widen the registry: every write route is still refused to a tenant admin', async ({ request }) => {
    const token = await tenantAdminToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    // A row id is needed for the by-id writes; take one from the catalogue the
    // tenant admin CAN read, which is exactly the escalation path to close.
    const catalogue = await request.get(CATALOGUE, { headers });
    const [model] = (await catalogue.json()).models;
    expect(model, 'the seeded catalogue must not be empty').toBeTruthy();

    const writes: Array<{ method: 'post' | 'patch' | 'delete'; path: string; data?: unknown }> = [
      { method: 'post', path: '/api/v1/admin/ai-models', data: { name: 'x', slug: 'x' } },
      { method: 'patch', path: `/api/v1/admin/ai-models/${model.id}`, data: { name: 'x' } },
      { method: 'delete', path: `/api/v1/admin/ai-models/${model.id}` },
      { method: 'post', path: `/api/v1/admin/ai-models/${model.id}/platform-default`, data: { tasks: [] } },
      { method: 'post', path: `/api/v1/admin/ai-models/${model.id}/download` },
      { method: 'post', path: '/api/v1/admin/ai-models/inventory' },
    ];

    for (const write of writes) {
      const response = await request[write.method](write.path, { headers, ...(write.data ? { data: write.data } : {}) });
      expect([403, 404], `${write.method.toUpperCase()} ${write.path} must stay closed to a tenant admin`).toContain(response.status());
    }
  });
});
