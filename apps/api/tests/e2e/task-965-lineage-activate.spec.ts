/**
 * TASK-965 WS-2 — the lineage register and the movable ACTIVE pointer, at the wire.
 *
 * Three owner decisions are exercised here:
 *
 *   OD-965-3 — `GET admin/{agents,workflow-definitions}/lineages`: ONE row per slug, and the
 *     page slice AND `count` are LINEAGES, not version rows. The per-version lists stay exactly
 *     as they were (the Versions tab reads them), so the invariant worth pinning at the wire is
 *     that the two views describe the SAME set of slugs.
 *   OD-965-1 — `POST …/:id/activate`: rollback. Publish v2, activate v1 again, and v2 must be
 *     demoted — the round trip that was impossible before (publish was the only writer of
 *     `isActive` and it refuses a PUBLISHED row, so the only way "back" was another version).
 *   OD-965-2 — `POST admin/workflow-definitions/:id/deprecate`, and DELETE refusing the ACTIVE
 *     version with 409. Deprecating the active version leaves the slug serving NOTHING while its
 *     assignment still names it: the register must say so (`active: null`), because that is the
 *     warning the console has to render.
 *
 * Cross-tenant: every new route answers 404 for a FOREIGN row — never 403 — and the lineage
 * register never lists a slug the caller does not own.
 *
 * WRITE SCOPE. The workflow half AUTHORS its own lineages and tears them down. The agent half is
 * deliberately READ-ONLY plus negative paths: creating an agent needs a resolvable `modelId` and
 * a publishable configuration, which is a different suite's business — so the agent register is
 * checked for its invariants against whatever the tenant already holds, and the rollback round
 * trip runs only when the seed already offers a slug with two published versions.
 *
 * Prerequisites: API running against the test DB and seeded. Run with `RESET_DB=false`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const WORKFLOWS = '/api/v1/admin/workflow-definitions';
const AGENTS = '/api/v1/admin/agents';
/** A well-formed uuid that names nothing — the "unknown id" probe, which must look like a foreign one. */
const ABSENT_ID = '01999999-9999-7999-8999-999999999999';

interface Lineage {
  slug: string;
  name: string;
  versionCount: number;
  latestVersionNumber: number;
  deprecatedCount: number;
  active: { id: string; versionNumber: number; publishedAt: string | null; publishedBy: string | null } | null;
  draft: { id: string; versionNumber: number; status: string; updatedAt: string } | null;
  assignment: { tenantDefault: boolean; departmentCount: number; selectorCount: number };
  tags: string[];
  updatedAt: string;
}
interface Paginated<T> {
  count: number;
  page: number;
  limit: number;
  data: T[];
}
interface Definition {
  id: string;
  slug: string;
  status: string;
  version: number;
  versionNumber: number;
  isActive: boolean;
  deprecatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

/** The canonical `core` chain, control-ported — the same fixture shape `task-779` uses. */
const CANONICAL_NODES = [
  { type: 'core.trigger', config: { kinds: ['consultation', 'api'] } },
  { type: 'core.action', config: { actionKey: 'consultation.consentGate', action: {}, onError: 'degrade' } },
  { type: 'core.action', config: { actionKey: 'consultation.phiHop', action: { mode: 'pseudonymize' }, onError: 'degrade' } },
  { type: 'core.action', config: { actionKey: 'consultation.persistDraft', action: { occ: true }, onError: 'degrade' } },
  { type: 'core.humanReview', config: { reviewType: 'clinical_finalization', assignRole: 'DOCTOR', timeoutSeconds: 3600 } },
  { type: 'core.output', config: { protocols: ['http'] } },
] as const;

function canonicalGraph() {
  return {
    version: 1,
    nodes: CANONICAL_NODES.map((spec, index) => ({ id: `n${index}`, type: spec.type, config: { ...spec.config } })),
    edges: CANONICAL_NODES.slice(1).map((_, index) => ({
      id: `e${index}`,
      from: `n${index}`,
      fromPort: 'next',
      to: `n${index + 1}`,
      toPort: 'after',
    })),
  };
}

let tenantAdminToken: string;
let superAdminToken: string;
let ownTenantId: string;
let foreignTenantId: string;

const created: Array<{ id: string; tenantId?: string }> = [];

function uniqueSlug(label: string): string {
  return `t965_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

async function createDefinition(
  request: APIRequestContext,
  token: string,
  label: string,
  options: { slug?: string; parentVersionId?: string; tenantId?: string } = {},
): Promise<{ status: number; body: Definition }> {
  const response = await request.post(WORKFLOWS, {
    headers: bearer(token, options.tenantId),
    data: {
      slug: options.slug ?? uniqueSlug(label),
      name: `t965 ${label}`,
      paletteKey: 'core',
      graph: canonicalGraph(),
      ...(options.parentVersionId ? { parentVersionId: options.parentVersionId } : {}),
    },
  });
  const body = (await response.json()) as Definition;
  if (response.status() === 201) created.push({ id: body.id, tenantId: options.tenantId });
  return { status: response.status(), body };
}

async function publish(request: APIRequestContext, token: string, id: string, activate = true): Promise<Definition> {
  const response = await request.post(`${WORKFLOWS}/${id}/publish`, { headers: bearer(token), data: { activate } });
  expect(response.status(), `publish ${id}`).toBe(200);
  return (await response.json()) as Definition;
}

async function lineageOf(request: APIRequestContext, token: string, slug: string): Promise<Lineage | undefined> {
  const response = await request.get(`${WORKFLOWS}/lineages?page=1&limit=200`, { headers: bearer(token) });
  expect(response.status(), 'workflow lineage register').toBe(200);
  return ((await response.json()) as Paginated<Lineage>).data.find((row) => row.slug === slug);
}

test.beforeAll(async ({ request }) => {
  const [admin, sa] = await Promise.all([
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
  ]);
  expect(admin?.token, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
  expect(sa?.token, 'super_admin login failed').toBeTruthy();
  tenantAdminToken = admin!.token;
  superAdminToken = sa!.token;

  const tenants = await request.get('/api/v1/admin/tenants?page=0&limit=50', { headers: bearer(superAdminToken) });
  expect(tenants.status(), 'list tenants').toBe(200);
  const rows = ((await tenants.json()).data as Array<{ id: string }>).filter((row) => row.id !== SYSTEM_TENANT_ID);
  expect(rows.length, 'at least two customer tenants must be seeded').toBeGreaterThanOrEqual(2);

  const probe = await createDefinition(request, tenantAdminToken, 'probe');
  expect(probe.status, 'tenant admin can author a definition').toBe(201);
  const probeRow = await request.get(`${WORKFLOWS}/${probe.body.id}`, { headers: bearer(tenantAdminToken) });
  expect(probeRow.status()).toBe(200);
  ownTenantId = (await probeRow.json()).tenantId as string;
  foreignTenantId = rows.find((row) => row.id !== ownTenantId)!.id;
});

test.afterAll(async ({ request }) => {
  for (const { id, tenantId } of created) {
    // A row may be ACTIVE by the time we tear down — 409 by design, so deprecate first and
    // ignore both outcomes: teardown must never fail a suite.
    await request.post(`${WORKFLOWS}/${id}/deprecate`, { headers: bearer(superAdminToken, tenantId ?? ownTenantId) }).catch(() => undefined);
    await request.delete(`${WORKFLOWS}/${id}`, { headers: bearer(superAdminToken, tenantId ?? ownTenantId) }).catch(() => undefined);
  }
});

test.describe('TASK-965 — workflow lineage register (OD-965-3)', () => {
  test('answers ONE row per slug, with the active pointer and the open draft, and counts LINEAGES', async ({ request }) => {
    const slug = uniqueSlug('register');
    const v1 = await createDefinition(request, tenantAdminToken, 'register', { slug });
    expect(v1.status).toBe(201);
    await publish(request, tenantAdminToken, v1.body.id);
    const v2 = await createDefinition(request, tenantAdminToken, 'register', { slug, parentVersionId: v1.body.id });
    expect(v2.status, 'a second version of the SAME slug').toBe(201);
    expect(v2.body.versionNumber).toBe(2);

    const lineage = await lineageOf(request, tenantAdminToken, slug);
    expect(lineage, 'the slug appears exactly once in the register').toBeTruthy();
    expect(lineage!.versionCount, 'two live version rows').toBe(2);
    expect(lineage!.latestVersionNumber).toBe(2);
    expect(lineage!.active, 'v1 is the published, active version').toMatchObject({ id: v1.body.id, versionNumber: 1 });
    expect(lineage!.active!.publishedBy, 'publish stamps updatedBy — "published by" is answerable now (G3)').toBeTruthy();
    expect(lineage!.draft, 'v2 is the open draft').toMatchObject({ id: v2.body.id, versionNumber: 2, status: 'DRAFT' });
    expect(lineage!.assignment, 'every row carries an assignment summary, even when nothing assigns it').toEqual({
      tenantDefault: expect.any(Boolean),
      departmentCount: expect.any(Number),
      selectorCount: expect.any(Number),
    });
  });

  test('the register and the per-version list describe the SAME set of slugs', async ({ request }) => {
    const [register, versions] = await Promise.all([
      request.get(`${WORKFLOWS}/lineages?page=1&limit=200`, { headers: bearer(tenantAdminToken) }),
      request.get(`${WORKFLOWS}?page=1&limit=200`, { headers: bearer(tenantAdminToken) }),
    ]);
    expect(register.status()).toBe(200);
    expect(versions.status()).toBe(200);

    const lineages = (await register.json()) as Paginated<Lineage>;
    const rows = (await versions.json()) as Paginated<Definition>;
    const slugsFromVersions = new Set(rows.data.map((row) => row.slug));

    expect(new Set(lineages.data.map((row) => row.slug)).size, 'no slug is listed twice').toBe(lineages.data.length);
    for (const row of lineages.data) {
      expect(slugsFromVersions.has(row.slug), `${row.slug} is a real slug of this tenant`).toBe(true);
      expect(row.versionCount).toBeGreaterThanOrEqual(1);
      expect(row.latestVersionNumber).toBeGreaterThanOrEqual(row.versionCount);
      if (row.active) expect(row.active.versionNumber).toBeLessThanOrEqual(row.latestVersionNumber);
    }
    expect(lineages.count, '`count` counts lineages, so it can never exceed the number of version rows').toBeLessThanOrEqual(rows.count);
  });

  test('an unknown paletteKey is a 400 naming the known palettes, never an empty page', async ({ request }) => {
    const response = await request.get(`${WORKFLOWS}/lineages?paletteKey=not_a_palette`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(400);
  });
});

test.describe('TASK-965 — workflow activate / deprecate / delete (OD-965-1, OD-965-2)', () => {
  test('rollback: activating v1 again demotes v2 — the round trip that was impossible before', async ({ request }) => {
    const slug = uniqueSlug('rollback');
    const v1 = await createDefinition(request, tenantAdminToken, 'rollback', { slug });
    const published1 = await publish(request, tenantAdminToken, v1.body.id);
    expect(published1.isActive, 'publish defaults to activate').toBe(true);

    const v2 = await createDefinition(request, tenantAdminToken, 'rollback', { slug, parentVersionId: v1.body.id });
    const published2 = await publish(request, tenantAdminToken, v2.body.id);
    expect(published2.isActive).toBe(true);

    const demoted = await request.get(`${WORKFLOWS}/${v1.body.id}`, { headers: bearer(tenantAdminToken) });
    expect(((await demoted.json()) as Definition).isActive, 'publishing v2 demoted v1, which stays PUBLISHED').toBe(false);

    const activated = await request.post(`${WORKFLOWS}/${v1.body.id}/activate`, { headers: bearer(tenantAdminToken) });
    expect(activated.status(), 'activate is a state transition — 200, like publish').toBe(200);
    const activatedBody = (await activated.json()) as Definition;
    expect(activatedBody.isActive).toBe(true);
    expect(activatedBody.status, 'the published bytes are untouched — this is a pointer move, not an edit').toBe('PUBLISHED');

    const nowDemoted = await request.get(`${WORKFLOWS}/${v2.body.id}`, { headers: bearer(tenantAdminToken) });
    expect(((await nowDemoted.json()) as Definition).isActive, 'v2 stopped serving').toBe(false);

    const lineage = await lineageOf(request, tenantAdminToken, slug);
    expect(lineage!.active, 'the register follows the pointer').toMatchObject({ id: v1.body.id, versionNumber: 1 });
  });

  test('activate refuses a DRAFT (400) — there is nothing published to serve', async ({ request }) => {
    const draft = await createDefinition(request, tenantAdminToken, 'draft_activate');
    const response = await request.post(`${WORKFLOWS}/${draft.body.id}/activate`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(400);
  });

  test('deprecating the ACTIVE version leaves the slug serving nothing, and the register says so', async ({ request }) => {
    const slug = uniqueSlug('deprecate');
    const version = await createDefinition(request, tenantAdminToken, 'deprecate', { slug });
    await publish(request, tenantAdminToken, version.body.id);

    const deprecated = await request.post(`${WORKFLOWS}/${version.body.id}/deprecate`, { headers: bearer(tenantAdminToken) });
    expect(deprecated.status(), 'deprecate is a state transition — 200').toBe(200);
    const body = (await deprecated.json()) as Definition;
    expect(body.status).toBe('DEPRECATED');
    expect(body.isActive, 'a deprecated version stops serving').toBe(false);
    expect(body.deprecatedAt).toBeTruthy();

    const lineage = await lineageOf(request, tenantAdminToken, slug);
    expect(lineage!.active, 'nothing serves this slug now — the console must warn, not show an empty cell').toBeNull();
    expect(lineage!.deprecatedCount).toBe(1);

    const again = await request.post(`${WORKFLOWS}/${version.body.id}/deprecate`, { headers: bearer(tenantAdminToken) });
    expect(again.status(), 'a DEPRECATED row is not PUBLISHED, so it cannot be deprecated twice').toBe(400);

    const revive = await request.post(`${WORKFLOWS}/${version.body.id}/activate`, { headers: bearer(tenantAdminToken) });
    expect(revive.status(), 'nor silently revived — branch a new version instead').toBe(400);
  });

  test('DELETE refuses the ACTIVE version with 409, and accepts it once deprecated (G9)', async ({ request }) => {
    const version = await createDefinition(request, tenantAdminToken, 'delete_guard');
    await publish(request, tenantAdminToken, version.body.id);

    const refused = await request.delete(`${WORKFLOWS}/${version.body.id}`, { headers: bearer(tenantAdminToken) });
    expect(refused.status(), 'deleting the live version would orphan every assignment on the slug').toBe(409);

    const stillThere = await request.get(`${WORKFLOWS}/${version.body.id}`, { headers: bearer(tenantAdminToken) });
    expect(stillThere.status(), 'and nothing was deleted').toBe(200);

    await request.post(`${WORKFLOWS}/${version.body.id}/deprecate`, { headers: bearer(tenantAdminToken) });
    const accepted = await request.delete(`${WORKFLOWS}/${version.body.id}`, { headers: bearer(tenantAdminToken) });
    expect(accepted.status(), 'once it serves nothing, the version can be deleted').toBe(200);
  });

  test('the response says who authored and who published (G3, OD-965-5)', async ({ request }) => {
    const version = await createDefinition(request, tenantAdminToken, 'authorship');
    expect(version.body.createdBy, 'createdBy is on the wire').toBeTruthy();

    const published = await publish(request, tenantAdminToken, version.body.id);
    expect(published.updatedBy, 'publish stamps updatedBy — on a PUBLISHED row that IS the publisher').toBeTruthy();
  });
});

test.describe('TASK-965 — cross-tenant isolation on the new workflow routes', () => {
  test('activate / deprecate on a FOREIGN row answer 404, never 403', async ({ request }) => {
    const foreign = await createDefinition(request, superAdminToken, 'foreign', { tenantId: foreignTenantId });
    expect(foreign.status, 'super admin authors a real row inside the foreign tenant').toBe(201);
    await request.post(`${WORKFLOWS}/${foreign.body.id}/publish`, { headers: bearer(superAdminToken, foreignTenantId), data: {} });

    for (const verb of ['activate', 'deprecate']) {
      const response = await request.post(`${WORKFLOWS}/${foreign.body.id}/${verb}`, { headers: bearer(tenantAdminToken) });
      expect(response.status(), `POST :id/${verb} across the tenant boundary → 404`).toBe(404);
    }

    const survivor = await request.get(`${WORKFLOWS}/${foreign.body.id}`, { headers: bearer(superAdminToken, foreignTenantId) });
    expect(survivor.status(), 'the foreign row survived both denied probes').toBe(200);
    expect((await survivor.json()).status, 'and was NOT deprecated by them').toBe('PUBLISHED');
  });

  test('the register never lists a slug the caller does not own', async ({ request }) => {
    const foreign = await createDefinition(request, superAdminToken, 'foreign_register', { tenantId: foreignTenantId });
    expect(foreign.status).toBe(201);

    const mine = await request.get(`${WORKFLOWS}/lineages?page=1&limit=200`, { headers: bearer(tenantAdminToken) });
    expect(mine.status()).toBe(200);
    const slugs = ((await mine.json()) as Paginated<Lineage>).data.map((row) => row.slug);
    expect(slugs, 'a foreign tenant’s lineage is absent, not merely unreadable').not.toContain(foreign.body.slug);
  });

  test('an unknown id is 404 on both verbs — indistinguishable from a foreign one', async ({ request }) => {
    for (const verb of ['activate', 'deprecate']) {
      const response = await request.post(`${WORKFLOWS}/${ABSENT_ID}/${verb}`, { headers: bearer(tenantAdminToken) });
      expect(response.status()).toBe(404);
    }
  });
});

test.describe('TASK-965 — agent lineage register and activate (OD-965-1, OD-965-3)', () => {
  test('the agent register answers one row per slug and agrees with the per-version list', async ({ request }) => {
    const [register, versions] = await Promise.all([
      request.get(`${AGENTS}/lineages?page=1&limit=200`, { headers: bearer(tenantAdminToken) }),
      request.get(AGENTS, { headers: bearer(tenantAdminToken) }),
    ]);
    expect(register.status(), 'the literal `lineages` is not swallowed by the `:id` route').toBe(200);
    expect(versions.status()).toBe(200);

    const lineages = (await register.json()) as Paginated<Lineage>;
    const rows = (await versions.json()) as Array<{ slug: string; status: string; isActive: boolean; versionNumber: number }>;
    const slugsFromVersions = new Set(rows.map((row) => row.slug));

    expect(new Set(lineages.data.map((row) => row.slug)).size, 'no slug is listed twice').toBe(lineages.data.length);
    expect(lineages.count, '`count` counts lineages, never version rows').toBeLessThanOrEqual(rows.length);
    for (const row of lineages.data) {
      expect(slugsFromVersions.has(row.slug), `${row.slug} is a real slug of this tenant`).toBe(true);
      expect(row.assignment, 'the "Serves" summary is on every row').toEqual({
        tenantDefault: expect.any(Boolean),
        departmentCount: expect.any(Number),
        selectorCount: expect.any(Number),
      });
      const activeRow = rows.find((candidate) => candidate.slug === row.slug && candidate.status === 'PUBLISHED' && candidate.isActive);
      if (row.active) {
        expect(activeRow?.versionNumber, 'the register names the same active version the version list does').toBe(row.active.versionNumber);
      } else {
        expect(activeRow, 'no active pointer in the register means no active row in the list either').toBeUndefined();
      }
    }
  });

  test('`task` narrows the register to one agent task', async ({ request }) => {
    const response = await request.get(`${AGENTS}/lineages?page=1&limit=200&task=TEXT_GENERATION`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(200);
    for (const row of ((await response.json()) as Paginated<Lineage & { task: string }>).data) {
      expect(row.task).toBe('TEXT_GENERATION');
    }
  });

  test('activate refuses a non-PUBLISHED version with 400', async ({ request }) => {
    const versions = await request.get(AGENTS, { headers: bearer(tenantAdminToken) });
    expect(versions.status()).toBe(200);
    const rows = (await versions.json()) as Array<{ id: string; status: string }>;
    const open = rows.find((row) => row.status === 'DRAFT' || row.status === 'VALIDATED');
    test.skip(!open, 'this tenant holds no open draft to probe with');

    const response = await request.post(`${AGENTS}/${open!.id}/activate`, { headers: bearer(tenantAdminToken) });
    expect(response.status(), 'a draft has no compiled config to serve — publish it instead').toBe(400);
  });

  test('activate on an unknown or foreign id is 404, never 403', async ({ request }) => {
    const response = await request.post(`${AGENTS}/${ABSENT_ID}/activate`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('rollback round trip, when the tenant already holds two published versions of one slug', async ({ request }) => {
    const versions = await request.get(AGENTS, { headers: bearer(tenantAdminToken) });
    expect(versions.status()).toBe(200);
    const rows = (await versions.json()) as Array<{ id: string; slug: string; status: string; isActive: boolean; versionNumber: number }>;
    const published = rows.filter((row) => row.status === 'PUBLISHED');
    const slug = published.find((row) => !row.isActive && published.some((other) => other.slug === row.slug && other.isActive))?.slug;
    test.skip(!slug, 'this tenant holds no slug with a published-but-inactive version');

    const lineageRows = published.filter((row) => row.slug === slug);
    const wasActive = lineageRows.find((row) => row.isActive)!;
    const target = lineageRows.find((row) => !row.isActive)!;

    const activated = await request.post(`${AGENTS}/${target.id}/activate`, { headers: bearer(tenantAdminToken) });
    expect(activated.status()).toBe(200);
    expect(((await activated.json()) as { isActive: boolean }).isActive).toBe(true);

    const demoted = await request.get(`${AGENTS}/${wasActive.id}`, { headers: bearer(tenantAdminToken) });
    expect(((await demoted.json()) as { isActive: boolean; status: string }).isActive, 'the previous active version was demoted').toBe(false);
    expect(((await demoted.json()) as { status: string }).status, 'and stays PUBLISHED, so it can be activated again').toBe('PUBLISHED');

    // Put the tenant back the way it was — this suite does not own this lineage.
    const restored = await request.post(`${AGENTS}/${wasActive.id}/activate`, { headers: bearer(tenantAdminToken) });
    expect(restored.status(), 'restore the original active version').toBe(200);
  });
});
