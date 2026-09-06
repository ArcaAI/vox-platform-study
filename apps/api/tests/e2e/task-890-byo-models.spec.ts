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
      ...(row.hasKey ? {} : { apiKey: 'task890-e2e-not-a-real-key' }),
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

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

  test('a generated slug that would shadow a platform model is REFUSED, and nothing is written (P-29)', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    // `azure-gpt-5.4-mini` is a seeded SYSTEM row; the generated slug for the
    // wire id `gpt-5.4-mini` on the `azure` provider is exactly its name.
    const shadow = await request.put(`${PROVIDERS}/llm/azure/models`, {
      headers: auth(bearer),
      data: { models: [{ wireModelId: 'gpt-5.4-mini', name: 'Shadowing the platform', taskType: 'TEXT_GENERATION' }] },
    });
    expect(shadow.status()).toBe(409);
    const body = await shadow.json();
    expect(body.code ?? body.message?.code).toBe('BYO_SLUG_SHADOWS_PLATFORM');
    expect(body.slug ?? body.message?.slug).toBe('azure-gpt-5.4-mini');
    expect(body.suggestedSlug ?? body.message?.suggestedSlug).toBe('byo-azure-gpt-5.4-mini');
    expect(body.systemModelId ?? body.message?.systemModelId).toBeTruthy();

    // The refusal is total: the earlier declaration is untouched, and no row
    // was created under the shadowing name.
    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(bearer) })).json()) as CatalogueBody;
    const shadowed = catalogue.models.filter((m) => m.slug === 'azure-gpt-5.4-mini');
    expect(shadowed.every((m) => m.providerClass !== 'cloud-byo')).toBe(true);
  });

  test('the suggested `byo-` name is accepted, so the tenant can keep both models', async ({ request }) => {
    const bearer = await token(request, ARCAAI_ADMIN_USERNAME, ARCAAI_TENANT_KEY);
    await ensureConnection(request, bearer);

    const accepted = await request.put(`${PROVIDERS}/llm/azure/models`, {
      headers: auth(bearer),
      data: {
        models: [
          DECLARED,
          { wireModelId: 'gpt-5.4-mini', name: 'Our own GPT-5.4 mini', taskType: 'TEXT_GENERATION', slug: 'byo-azure-gpt-5.4-mini' },
        ],
      },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect((await accepted.json()).models.map((m: { slug: string }) => m.slug)).toContain('byo-azure-gpt-5.4-mini');

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

    // 404-over-403: a foreign row is ABSENT, never forbidden.
    const byId = await request.get(`${REGISTRY}/${modelId}`, { headers: auth(stranger) });
    expect(byId.status()).toBe(404);
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
