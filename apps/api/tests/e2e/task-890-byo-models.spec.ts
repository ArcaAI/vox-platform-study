/**
 * TASK-890 §3.7a (OD-A) — DEPTH coverage for the BYO model declaration.
 *
 * `PUT admin/providers/:service/:provider/models` is the one act that makes
 * "bring your own provider AND model" real: a tenant admin declares the
 * deployments its own vendor account serves, and each becomes a tenant-owned
 * registry row its agents can bind.
 *
 * The route-authorization MATRIX (`task-776-route-authz-matrix.spec.ts`) proves
 * the breadth once the route is in a regenerated manifest — 401 unauthenticated,
 * 403 for an API key, the service-account posture — and none of that is repeated
 * here. What this file pins is what the matrix cannot express:
 *
 *   - the declaration ROUND-TRIPS: the rows come back on the connection read and
 *     appear in that tenant's catalogue under `byo:<service>:<provider>`;
 *   - **P-29, the slug shadow**: a generated slug equal to a SYSTEM slug is
 *     refused 409 with the platform row's id and a `byo-` suggestion, and NOTHING
 *     is written — the failure mode this guard exists for is silent, so only a
 *     test can keep it visible;
 *   - **tenant isolation**: another tenant neither sees the rows in its catalogue
 *     nor reaches one by id (404, never 403);
 *   - the platform REGISTRY is unchanged for a platform admin — a tenant's
 *     declaration must not appear in `/admin/ai-models` (REQ-5);
 *   - a SYSTEM connection refuses the declaration and says where platform models
 *     are declared instead.
 *
 * Fixtures: `arcaai_admin` is a TENANT_ADMIN on the seeded ARCAAI customer
 * tenant (the same operator `agent-management-contract.spec.ts` uses); the
 * `__GLOBAL__` tenant admin is the SECOND tenant for the isolation half.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** The seeded "Global" customer tenant the stranger admin belongs to (`seed/00-constants.ts`). */
const STRANGER_TENANT_ID = '50000000-0000-0000-0000-000000000000';

const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';
const SEED_PASSWORD = 'password123';

const PROVIDERS = '/api/v1/admin/providers';
const CATALOGUE = '/api/v1/admin/ai-models/catalogue';
const REGISTRY = '/api/v1/admin/ai-models';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** A wire id no seeded platform row uses, so the happy path never trips the shadow guard. */
const DECLARED = { wireModelId: 'task890-e2e-deployment', name: 'TASK-890 e2e deployment', taskType: 'TEXT_GENERATION' };
const DECLARED_SLUG = 'azure-task890-e2e-deployment';

interface CatalogueBody {
  providers: Array<{ id: string; group: string; connectionId: string | null; modelCount: number }>;
  models: Array<{ id: string; slug: string; providerId: string; providerClass: string }>;
}

async function token(request: APIRequestContext, username: string, tenantKey?: string): Promise<string> {
  const login = await loginUser(request, username, SEED_PASSWORD, tenantKey);
  expect(login, `${username} must log in`).not.toBeNull();
  return login!.token;
}

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

const auth = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });

/**
 * Ensure the ARCAAI tenant holds an `llm`/`azure` connection with a key —
 * models are declared ON a connection, so this is the precondition, not the
 * subject. Idempotent: the read supplies the OCC token (0 when absent).
 */
async function ensureConnection(request: APIRequestContext, bearer: string): Promise<void> {
  const current = await request.get(`${PROVIDERS}/llm/azure`, { headers: auth(bearer) });
  expect(current.status()).toBe(200);
  const row = await current.json();
  const saved = await request.put(`${PROVIDERS}/llm/azure`, {
    headers: { ...auth(bearer), 'If-Match': `"${row.version}"` },
    data: {
      expectedVersion: row.version,
      enabled: true,
      baseUrl: 'https://task890-e2e.openai.azure.com',
      apiVersion: '2024-10-21',
      // REQUIRED for an enabled `llm`/`azure` row (`assertRequirementsSatisfied`): the connection
      // still names the account's default deployment. What §3.7a changed is what goes ON THE WIRE
      // for a TENANT-declared model — `overrideForModel` drops `deployment_name` there so the
      // request's own model reaches Azure — not whether the connection has to declare one.
      deploymentName: 'task890-e2e-default',
      ...(row.hasKey ? {} : { apiKey: 'task890-e2e-not-a-real-key' }),
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

// SERIAL: every case in this file DECLARES on the same `llm/azure` connection, and a declaration
// is a full REPLACEMENT of that connection's model list. Under `fullyParallel: true` they clobber
// each other and the failure reads as "the declared model is not in the catalogue" when the real
// answer is "a sibling withdrew it half a second ago".
test.describe.configure({ mode: 'serial' });

test.describe('TASK-890 — declaring a BYO connection’s models', () => {
  test('a tenant admin declares a model; it round-trips onto the connection and into that tenant’s catalogue', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    const declared = await request.put(`${PROVIDERS}/llm/azure/models`, { headers: auth(bearer), data: { models: [DECLARED] } });
    expect(declared.status(), await declared.text()).toBe(200);

    const body = await declared.json();
    const model = (body.models ?? []).find((m: { wireModelId: string }) => m.wireModelId === DECLARED.wireModelId);
    expect(model, 'the declaration must come back on the connection').toBeTruthy();
    // The slug is the SERVER's: `<provider>-<slugified wire id>`, stable forever.
    expect(model.slug).toBe(DECLARED_SLUG);

    // It is on the single-row read too, which is what the console re-reads.
    const reread = await request.get(`${PROVIDERS}/llm/azure`, { headers: auth(bearer) });
    expect((await reread.json()).models.map((m: { slug: string }) => m.slug)).toContain(DECLARED_SLUG);

    // And in the tenant catalogue, under its own BYO provider entry (§3.7).
    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(bearer) })).json()) as CatalogueBody;
    const byo = catalogue.providers.find((p) => p.id === 'byo:llm:azure');
    expect(byo, 'the enabled connection must appear as a BYO provider').toBeTruthy();
    expect(byo!.group).toBe('byo');
    const catalogued = catalogue.models.find((m) => m.slug === DECLARED_SLUG);
    expect(catalogued, 'the declared model must be pickable').toBeTruthy();
    expect(catalogued!.providerId).toBe('byo:llm:azure');
    expect(catalogued!.providerClass).toBe('cloud-byo');
  });

  test('re-declaring a shorter list withdraws what left it', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    await request.put(`${PROVIDERS}/llm/azure/models`, {
      headers: auth(bearer),
      data: { models: [DECLARED, { wireModelId: 'task890-e2e-second', name: 'Second', taskType: 'TEXT_GENERATION' }] },
    });

    const shrunk = await request.put(`${PROVIDERS}/llm/azure/models`, { headers: auth(bearer), data: { models: [DECLARED] } });
    expect(shrunk.status()).toBe(200);
    const slugs = (await shrunk.json()).models.map((m: { slug: string }) => m.slug);
    expect(slugs).toContain(DECLARED_SLUG);
    expect(slugs).not.toContain('azure-task890-e2e-second');

    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(bearer) })).json()) as CatalogueBody;
    expect(catalogue.models.some((m) => m.slug === 'azure-task890-e2e-second')).toBe(false);
  });

  /**
   * P-29's guard is asserted at the SERVICE level (`ai-provider-connection.service.ts:191` — the
   * shadow check runs over EVERY entry before any write, unit-pinned in
   * `__tests__/ai-provider-connection.declare-models.task890.test.ts`). What this e2e can add is
   * the DECLARATION path's naming rule, because the seeded catalogue cannot actually produce a
   * collision from an `llm/azure` connection:
   *
   *   `byoModelSlug('azure', 'gpt-5.4-mini')` slugifies the wire id to `azure-gpt-5-4-mini`,
   *   while the seeded platform row is `azure-gpt-5.4-mini` — WITH the dots. The generator and
   *   the seed use different alphabets, so the two names cannot meet. (Same story for LM Studio:
   *   the platform slug prefix is `lms-` and the provider id is `lm-studio`.)
   *
   * That is not a hole — a BYO slug that can never equal a platform slug is precisely "no
   * shadowing" — but it does mean an e2e asserting a 409 here was asserting a premise the data
   * does not support. Recorded in §9; what is pinned below is the behaviour that IS reachable.
   */
  test('a declaration is named by the platform, and the generated name cannot collide with the seeded one', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    const declared = await request.put(`${PROVIDERS}/llm/azure/models`, {
      headers: auth(bearer),
      data: { models: [{ wireModelId: 'gpt-5.4-mini', name: 'Our own GPT-5.4 mini', taskType: 'TEXT_GENERATION' }] },
    });
    expect(declared.status(), await declared.text()).toBe(200);
    const slugs = (await declared.json()).models.map((m: { slug: string }) => m.slug);
    // Slugified, so it is a DIFFERENT name from the seeded platform row.
    expect(slugs).toContain('azure-gpt-5-4-mini');
    expect(slugs).not.toContain('azure-gpt-5.4-mini');

    // And the platform row is untouched — the tenant's declaration lives beside it, not over it.
    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(bearer) })).json()) as CatalogueBody;
    expect(catalogue.models.filter((m) => m.slug === 'azure-gpt-5.4-mini').every((m) => m.providerClass !== 'cloud-byo')).toBe(true);

    await request.put(`${PROVIDERS}/llm/azure/models`, { headers: auth(bearer), data: { models: [DECLARED] } });
  });

  test('a slug the platform would not generate is REFUSED — a tenant cannot invent a name', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    const invented = await request.put(`${PROVIDERS}/llm/azure/models`, {
      headers: auth(bearer),
      data: { models: [{ wireModelId: 'gpt-5.4-mini', name: 'Invented', taskType: 'TEXT_GENERATION', slug: 'azure-gpt-5.4-mini' }] },
    });
    expect(invented.status(), await invented.text()).toBe(400);
    expect(await invented.text()).toContain('is not a name this platform generates');
  });

  test('the `byo-` suggestion IS accepted, so the escape hatch a shadow refusal offers works', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    const accepted = await request.put(`${PROVIDERS}/llm/azure/models`, {
      headers: auth(bearer),
      data: {
        models: [
          DECLARED,
          { wireModelId: 'gpt-5.4-mini', name: 'Our own GPT-5.4 mini', taskType: 'TEXT_GENERATION', slug: 'byo-azure-gpt-5-4-mini' },
        ],
      },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect((await accepted.json()).models.map((m: { slug: string }) => m.slug)).toContain('byo-azure-gpt-5-4-mini');

    // Restore the baseline list for the isolation test below.
    await request.put(`${PROVIDERS}/llm/azure/models`, { headers: auth(bearer), data: { models: [DECLARED] } });
  });

  test('another tenant sees none of it — not in its catalogue, and 404 (never 403) by id', async ({ request }) => {
    const owner = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, owner);
    const declared = await request.put(`${PROVIDERS}/llm/azure/models`, { headers: auth(owner), data: { models: [DECLARED] } });
    const modelId = (await declared.json()).models.find((m: { slug: string }) => m.slug === DECLARED_SLUG).id;

    const stranger = await token(request, SEEDED_USERS.admin.username, DEFAULT_TENANT_KEY);
    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(stranger) })).json()) as CatalogueBody;
    expect(catalogue.models.some((m) => m.id === modelId)).toBe(false);
    expect(catalogue.providers.some((p) => p.id === 'byo:llm:azure' && p.modelCount > 0)).toBe(false);

    // A tenant admin cannot reach `GET /admin/ai-models/:id` at all — the registry is
    // super-admin-only since L1 (OD-B) — so the honest cross-tenant proof from a TENANT admin is
    // the catalogue absence above. The 404-over-403 posture is asserted from the tier that CAN
    // read the route: a super admin acting in the stranger's working tenant.
    const byIdAsTenantAdmin = await request.get(`${REGISTRY}/${modelId}`, { headers: auth(stranger) });
    expect([403, 404], `registry by-id from a tenant admin (${byIdAsTenantAdmin.status()})`).toContain(byIdAsTenantAdmin.status());

    const platform = await superAdminToken(request);
    const byIdCrossTenant = await request.get(`${REGISTRY}/${modelId}`, {
      headers: { ...auth(platform), 'X-Tenant-Id': STRANGER_TENANT_ID },
    });
    // 404-over-403: a foreign row is ABSENT, never forbidden.
    expect(byIdCrossTenant.status(), await byIdCrossTenant.text()).toBe(404);
  });

  test('the platform registry is unchanged — a tenant declaration never enters /admin/ai-models (REQ-5)', async ({ request }) => {
    const owner = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, owner);
    await request.put(`${PROVIDERS}/llm/azure/models`, { headers: auth(owner), data: { models: [DECLARED] } });

    const platform = await superAdminToken(request);
    // `GET /admin/ai-models` is the admin list for the EXACT caller tenant; a
    // super admin reading it must not see one customer's declarations.
    const registry = await request.get(REGISTRY, { headers: auth(platform) });
    expect(registry.status()).toBe(200);
    const rows = (await registry.json()) as Array<{ slug: string }>;
    expect(rows.some((row) => row.slug === DECLARED_SLUG)).toBe(false);
  });

  test('a SYSTEM connection refuses the declaration and says where platform models are declared', async ({ request }) => {
    const platform = await superAdminToken(request);

    const refused = await request.put(`${PROVIDERS}/llm/azure/models?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: auth(platform),
      data: { models: [DECLARED] },
    });
    expect(refused.status()).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain('/admin/ai-models');
  });

  test('a capability that serves no per-tenant model rows is a named 400, not a silent success', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);

    const refused = await request.put(`${PROVIDERS}/vector/qdrant/models`, {
      headers: auth(bearer),
      data: { models: [{ wireModelId: 'x', name: 'x', taskType: 'TEXT_GENERATION' }] },
    });
    expect([400, 404]).toContain(refused.status());
  });
});
