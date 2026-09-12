/**
 * TASK-958 — two accounts of ONE vendor, end to end over live HTTP.
 *
 * The ticket's claim is that a tenant admin can hold several
 * `AiProviderConnection` rows for one `(service, provider)` and BIND an agent to a
 * chosen one. The binding a tenant actually makes is `AiModel.sourceConnectionId`
 * — "the model row names the connection" (D-3) — so what has to hold over the wire
 * is:
 *
 *   1. two `llm`/`openai` rows coexist, one DEFAULT and one named sibling, and
 *      `GET admin/providers/llm` lists both with `isDefault` correct (D-1/D-2);
 *   2. the SAME wire model id declared on both mints two DISTINCT rows, each
 *      pointing at its own connection — the slug is namespaced by the connection
 *      slug, so account #2's deployment is not account #1's under another name (D-5);
 *   3. the catalogue returns ONE picker entry per CONNECTION, carrying
 *      `connectionSlug`/`connectionName`/`isDefault`, with each model filed under
 *      the connection it was declared on — which is the only thing that tells an
 *      author which key an agent will spend (D-5/D-10);
 *   4. the DEFAULT connection keeps today's id (`byo:llm:openai`) and today's
 *      label, so nothing that worked before this ticket moved.
 *
 * NOT asserted here: the ledger row's `connectionId` after a real invocation
 * (§4.6 case 28's second half). That needs a generation to actually happen, and a
 * live TEXT call would spend a vendor credential this suite must never hold. The
 * repo's one precedent for proving a credential reaches TEXT —
 * `byo-llm-credentials.spec.ts` — is ENV-GATED behind an operator step (the
 * gateway resolves `TEXT_URL` once at bootstrap, so a Playwright worker cannot
 * redirect an already-running gateway at a stub it owns). The equivalent proof
 * lives in the unit suites instead, where the whole chain is observable:
 * `agent/__tests__/binding.task958.test.ts` (the candidate carries #2's
 * `connection_id`, a disabled #2 is skipped, a foreign id is 404) and
 * `usageLedger/__tests__/connection-attribution.task958.test.ts` (the id reaches
 * `AiUsageEvent.connectionId` from each usage path).
 *
 * TWO THINGS ABOUT THE SEEDED DATABASE this suite writes into, both learned the
 * hard way:
 *
 *   - a NAMED SIBLING is created with `If-Match: "0"` and NO prior read. A slug
 *     that is not a provider id has no `version: 0` placeholder to read — `GET`
 *     404s until the row exists — so the read-then-write helper failed on its
 *     own first assertion before any of this was exercised.
 *   - everything it writes is undone in `afterAll`: the sibling is deleted (with
 *     the models declared on it), and the DEFAULT connection's model list — which
 *     `declareModels` REPLACES rather than appends — is captured in `beforeAll`
 *     and re-declared. The whole e2e run shares one database.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { loginUser } from '../../../../tests/helpers';

const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';
const SEED_PASSWORD = 'password123';

const PROVIDERS = '/api/v1/admin/providers';
const CATALOGUE = '/api/v1/admin/ai-models/catalogue';

/** The tenant's DEFAULT openai connection: `slug === provider`, which is what keeps its id stable. */
const DEFAULT_SLUG = 'openai';
/** A named sibling. Its slug is the tenant's own and is immutable after create (OQ-7). */
const SIBLING_SLUG = 'openai-t958-research';
const SIBLING_NAME = 'TASK-958 research account';

/** One wire id, declared on BOTH connections — the collision the connection slug resolves. */
const WIRE_MODEL = { wireModelId: 'task958-e2e-gpt', name: 'TASK-958 e2e model', taskType: 'TEXT_GENERATION' };

interface ConnectionRow {
  id: string;
  slug: string;
  provider: string;
  name: string | null;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
  version: number;
  models?: Array<{ slug: string; wireModelId: string; name: string; taskType: string }>;
}

/** One entry of `PUT :service/:slug/models` — `slug` is sent only to KEEP a generated name. */
interface DeclaredModel {
  wireModelId: string;
  name: string;
  taskType: string;
  slug?: string;
}

interface CatalogueBody {
  providers: Array<{
    id: string;
    group: string;
    name: string;
    connectionId: string | null;
    connectionSlug?: string | null;
    connectionName?: string | null;
    isDefault?: boolean | null;
  }>;
  models: Array<{ slug: string; providerId: string; providerClass: string }>;
}

const auth = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });

async function token(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, ARCAAI_TENANT_KEY);
  expect(login, 'the ARCAAI tenant admin must log in').not.toBeNull();
  return login!.token;
}

/**
 * Upsert the PROVIDER-NAMED connection — the tenant's default for that vendor.
 *
 * The pre-read is sound for THIS slug and only this one: a provider id always
 * answers 200, with a `version: 0` placeholder when no row is stored, which is
 * where the OCC token comes from. That is what makes the helper idempotent
 * against a seeded database.
 */
async function upsertDefault(request: APIRequestContext, bearer: string, slug: string, body: Record<string, unknown>): Promise<ConnectionRow> {
  const current = await request.get(`${PROVIDERS}/llm/${slug}`, { headers: auth(bearer) });
  expect(current.status(), await current.text()).toBe(200);
  const row = (await current.json()) as ConnectionRow;
  const saved = await request.put(`${PROVIDERS}/llm/${slug}`, {
    headers: { ...auth(bearer), 'If-Match': `"${row.version}"` },
    data: { expectedVersion: row.version, ...body, ...(row.hasKey ? {} : { apiKey: 'task958-e2e-not-a-real-key' }) },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  return (await saved.json()) as ConnectionRow;
}

/**
 * Create a NAMED SIBLING — and do NOT read it first.
 *
 * A slug that is not a provider id has no placeholder to read: `GET` on a
 * sibling that does not exist yet is a **404**, which is the final semantics of
 * the route (only the message wording is still moving). `If-Match: "0"` IS the
 * documented create precondition, exactly as `task-958-provider-connections.spec.ts`
 * uses it — a pre-read here failed the suite on its own first assertion.
 *
 * The 409/412 branch is for re-runs: a previous run that died before its cleanup
 * leaves the row behind, and THEN the read is valid because the row exists.
 */
async function createSibling(request: APIRequestContext, bearer: string, slug: string, body: Record<string, unknown>): Promise<ConnectionRow> {
  const created = await request.put(`${PROVIDERS}/llm/${slug}`, {
    headers: { ...auth(bearer), 'If-Match': '"0"' },
    data: { expectedVersion: 0, apiKey: 'task958-e2e-not-a-real-key', ...body },
  });
  if (created.status() === 200) return (await created.json()) as ConnectionRow;

  // Left over from an interrupted run: adopt it at its current version.
  expect([409, 412], await created.text()).toContain(created.status());
  const existing = await request.get(`${PROVIDERS}/llm/${slug}`, { headers: auth(bearer) });
  expect(existing.status(), await existing.text()).toBe(200);
  const row = (await existing.json()) as ConnectionRow;
  const saved = await request.put(`${PROVIDERS}/llm/${slug}`, {
    headers: { ...auth(bearer), 'If-Match': `"${row.version}"` },
    data: { expectedVersion: row.version, ...body },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  return (await saved.json()) as ConnectionRow;
}

// SERIAL: both cases declare on the same two connections, and a declaration REPLACES
// a connection's model list — under `fullyParallel: true` they would clobber each
// other and the failure would read as "the declared model is missing".
test.describe.configure({ mode: 'serial' });

test.describe('TASK-958 — several connections of one vendor, and the models bound to each', () => {
  /**
   * CLEANUP, and why it is `afterAll` rather than `afterEach`: the three cases
   * are one story told in order — create, declare, read back — so the sibling
   * has to survive between them. What must not survive the SUITE is anything it
   * wrote, because the whole e2e run shares one seeded database and a stray
   * `openai-t958-research` connection (or a replaced model list on the DEFAULT
   * one) changes what the catalogue and provider-list specs see.
   *
   * `declareModels` REPLACES a connection's list, so the default's original list
   * is captured up front and re-declared here. Cleanup asserts nothing: a
   * failure to tidy must not turn a passing suite red, and it is reported by the
   * assertions of whatever it would have disturbed.
   */
  let defaultModelsBefore: DeclaredModel[] | null = null;

  test.beforeAll(async ({ request }) => {
    const bearer = await token(request);
    const read = await request.get(`${PROVIDERS}/llm/${DEFAULT_SLUG}`, { headers: auth(bearer) });
    if (read.status() !== 200) return;
    const row = (await read.json()) as ConnectionRow;
    defaultModelsBefore = (row.models ?? []).map((model) => ({
      wireModelId: model.wireModelId,
      name: model.name,
      taskType: model.taskType,
      // Re-declaring with the ORIGINAL slug is what makes the restore a restore:
      // the generator would otherwise mint a fresh name for the same wire id.
      slug: model.slug,
    }));
  });

  test.afterAll(async ({ request }) => {
    const bearer = await token(request);

    // The sibling, and with it every model declared on it.
    const read = await request.get(`${PROVIDERS}/llm/${SIBLING_SLUG}`, { headers: auth(bearer) });
    if (read.status() === 200) {
      const row = (await read.json()) as ConnectionRow;
      if (row.version > 0) await request.delete(`${PROVIDERS}/llm/${SIBLING_SLUG}`, { headers: auth(bearer) });
    }

    // The default connection's model list, which this suite replaced in place.
    if (defaultModelsBefore) {
      await request.put(`${PROVIDERS}/llm/${DEFAULT_SLUG}/models`, { headers: auth(bearer), data: { models: defaultModelsBefore } });
    }
  });

  test('a tenant holds a DEFAULT openai connection and a named sibling; both are listed, one is default', async ({ request }) => {
    const bearer = await token(request);

    await upsertDefault(request, bearer, DEFAULT_SLUG, { enabled: true, baseUrl: 'https://api.openai.com/v1' });
    const sibling = await createSibling(request, bearer, SIBLING_SLUG, {
      // REQUIRED on a slug that is not itself a provider id (`CONNECTION_PROVIDER_REQUIRED`).
      provider: 'openai',
      name: SIBLING_NAME,
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(sibling.provider).toBe('openai');
    expect(sibling.name).toBe(SIBLING_NAME);
    expect(sibling.isDefault, 'a sibling is never the default merely by existing').toBe(false);

    const listed = (await (await request.get(`${PROVIDERS}/llm`, { headers: auth(bearer) })).json()) as ConnectionRow[];
    const openai = listed.filter((r) => r.provider === 'openai');
    expect(openai.map((r) => r.slug).sort()).toEqual([DEFAULT_SLUG, SIBLING_SLUG].sort());
    // Exactly ONE default per provider — the DB's second unique index, seen from the API.
    expect(openai.filter((r) => r.isDefault)).toHaveLength(1);
    expect(openai.find((r) => r.isDefault)!.slug).toBe(DEFAULT_SLUG);
  });

  test('the SAME wire model declared on both connections mints two rows, one per connection', async ({ request }) => {
    const bearer = await token(request);

    const onDefault = await request.put(`${PROVIDERS}/llm/${DEFAULT_SLUG}/models`, { headers: auth(bearer), data: { models: [WIRE_MODEL] } });
    expect(onDefault.status(), await onDefault.text()).toBe(200);
    const onSibling = await request.put(`${PROVIDERS}/llm/${SIBLING_SLUG}/models`, { headers: auth(bearer), data: { models: [WIRE_MODEL] } });
    expect(onSibling.status(), await onSibling.text()).toBe(200);

    const defaultSlugs = ((await onDefault.json()).models ?? []).map((m: { slug: string }) => m.slug);
    const siblingSlugs = ((await onSibling.json()).models ?? []).map((m: { slug: string }) => m.slug);
    // Namespaced by the CONNECTION slug, so one vendor id on two accounts is two rows
    // rather than a silent overwrite of the first account's deployment.
    expect(defaultSlugs).toContain(`${DEFAULT_SLUG}-${WIRE_MODEL.wireModelId}`);
    expect(siblingSlugs).toContain(`${SIBLING_SLUG}-${WIRE_MODEL.wireModelId}`);
    expect(defaultSlugs).not.toEqual(siblingSlugs);
  });

  test('the catalogue offers ONE entry per connection, and files each model under the connection it was declared on', async ({ request }) => {
    const bearer = await token(request);
    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(bearer) })).json()) as CatalogueBody;

    const def = catalogue.providers.find((p) => p.id === `byo:llm:${DEFAULT_SLUG}`);
    const sib = catalogue.providers.find((p) => p.id === `byo:llm:${SIBLING_SLUG}`);
    expect(def, 'the default connection keeps the id it has always had').toBeTruthy();
    expect(sib, 'the sibling gets an entry of its own — otherwise an author cannot pick it').toBeTruthy();

    expect(def!.isDefault).toBe(true);
    expect(def!.connectionSlug).toBe(DEFAULT_SLUG);
    expect(sib!.isDefault).toBe(false);
    expect(sib!.connectionSlug).toBe(SIBLING_SLUG);
    expect(sib!.connectionName).toBe(SIBLING_NAME);
    expect(sib!.connectionId).not.toBe(def!.connectionId);
    // The VENDOR label is the same on both — the connection fields carry the whole
    // difference, which is what the console renders as `<name> (BYO) · <connection>`.
    expect(sib!.name).toBe(def!.name);

    const onDefault = catalogue.models.find((m) => m.slug === `${DEFAULT_SLUG}-${WIRE_MODEL.wireModelId}`);
    const onSibling = catalogue.models.find((m) => m.slug === `${SIBLING_SLUG}-${WIRE_MODEL.wireModelId}`);
    expect(onDefault!.providerId).toBe(`byo:llm:${DEFAULT_SLUG}`);
    expect(onSibling!.providerId).toBe(`byo:llm:${SIBLING_SLUG}`);
    expect(onSibling!.providerClass).toBe('cloud-byo');
  });

  test('the `hope` group still names no connection at all — a platform model spends no tenant key', async ({ request }) => {
    const bearer = await token(request);
    const catalogue = (await (await request.get(CATALOGUE, { headers: auth(bearer) })).json()) as CatalogueBody;
    const hope = catalogue.providers.find((p) => p.group === 'hope');
    expect(hope).toBeTruthy();
    expect(hope!.connectionId).toBeNull();
    expect(hope!.connectionSlug ?? null).toBeNull();
    expect(hope!.isDefault ?? null).toBeNull();
  });
});
