/**
 * area 2 — WORKFLOW: the authoring plane `/api/v1/admin/workflow-definitions`.
 *
 * The two existing workflow suites cover the surfaces AROUND this one and say so
 * explicitly: `task-722-workflow-exposure.spec.ts` covers the read/invoke exposure
 * plane, `task-723-workflow-runs-cross-tenant.spec.ts` covers the (empty) runs read
 * model. The AUTHORING plane — the one a Workflow Studio user actually drives — had
 * no e2e at all. This file covers it:
 *
 *   - the lifecycle DRAFT → VALIDATED → PUBLISHED, plus the version lineage;
 *   - the rule catalogue AT THE WIRE (`WF-CONS-*` mandatory-node and reachability
 *     rules, `WF-S-*` bookends) and, importantly, which findings BLOCK and which
 *     do not;
 *   - `If-Match`/`ETag` optimistic concurrency (missing → 428, drift → 412);
 *   - cross-tenant isolation → 404, never 403.
 *
 * Graph fixtures mirror `packages/workflow-contract/src/__tests__/palette-canonical-graphs.test.ts`
 * so the wire-level expectations and the unit-level ones cannot drift apart.
 *
 * NOTE ON STATUS CODES ( fixed finding F-2): `POST :id/validate` and
 * `POST :id/publish` are state transitions on an EXISTING resource, not creations of
 * a new one, so they now carry `@HttpCode(HttpStatus.OK)` and answer 200, matching
 * their `@ApiResponse` — and therefore `openapi.json` — which always declared 200.
 * The assertions below pin the CORRECTED behaviour.
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

interface GraphNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}
interface Graph {
  version: number;
  nodes: GraphNode[];
  edges: Array<{ id: string; from: string; fromPort: string; to: string; toPort: string }>;
}

/** Satisfies the palette-agnostic invariants WF-I-004 (trajectory stated) and WF-I-010 (bounded retry). */
const BASE_CONFIG = { emitsTrajectory: true, retry: { maximumAttempts: 3 } };
/** The consultation palette's non-abort error policy (CR-16 / WF-CONS-019). */
const DEGRADE = 'degrade';

const NODE_CONFIG: Record<string, Record<string, unknown>> = {
  'consultation.captureBinding': { action: 'start', onError: DEGRADE },
  'consultation.extractEntities': { requiresFinalized: true, onError: DEGRADE },
  'consultation.bindTerminology': { purposeScope: 'terminology_validation', unmappedOutputKey: 'unmappedTerms', onError: DEGRADE },
  'consultation.phiHop': { mode: 'pseudonymize', onError: DEGRADE },
  'consultation.synthesize': { taskKey: 'text.finalize', producesCode: false, onError: DEGRADE },
  'consultation.sensors': { onError: DEGRADE },
  'consultation.persistDraft': { occ: true, onError: DEGRADE },
};

const CANONICAL_TYPES = [
  'core.start',
  'consultation.consentGate',
  'consultation.captureBinding',
  'consultation.extractEntities',
  'consultation.bindTerminology',
  'consultation.phiHop',
  'consultation.synthesize',
  'consultation.sensors',
  'consultation.persistDraft',
  'consultation.hitlGate',
  'core.end',
] as const;

/** A linear graph over `types`, matching the unit fixture's `chain()` helper exactly. */
function chain(types: readonly string[]): Graph {
  return {
    version: 1,
    nodes: types.map((type, index) => ({ id: `n${index}`, type, config: { ...BASE_CONFIG, ...(NODE_CONFIG[type] ?? {}) } })),
    edges: types.slice(1).map((_, index) => ({ id: `e${index}`, from: `n${index}`, fromPort: 'out', to: `n${index + 1}`, toPort: 'in' })),
  };
}

const canonicalGraph = (): Graph => chain(CANONICAL_TYPES);

function nodeIdOfType(graph: Graph, type: string): string {
  const node = graph.nodes.find((n) => n.type === type);
  expect(node, `fixture must contain a ${type} node`).toBeTruthy();
  return node!.id;
}

interface Finding {
  ruleId: string;
  severity: string;
  message?: string;
}
interface ValidationReport {
  ok: boolean;
  findings: Finding[];
}
interface Definition {
  id: string;
  slug: string;
  status: string;
  version: number;
  versionNumber: number;
  isActive: boolean;
  compiledConfig: Record<string, unknown> | null;
  validationReport: ValidationReport | null;
  validatedAt: string | null;
  publishedAt: string | null;
}

let tenantAdminToken: string;
let superAdminToken: string;
let ownTenantId: string;
let foreignTenantId: string;

/** [id, tenantId-to-delete-as] pairs, torn down in afterAll. */
const created: Array<{ id: string; tenantId?: string }> = [];

function uniqueSlug(label: string): string {
  // slug grammar is [a-z0-9_]{2,48}
  return `t779_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

async function createDefinition(
  request: APIRequestContext,
  token: string,
  graph: Graph,
  label: string,
  tenantId?: string,
): Promise<{ status: number; body: Definition & { message?: string } }> {
  const response = await request.post('/api/v1/admin/workflow-definitions', {
    headers: bearer(token, tenantId),
    data: { slug: uniqueSlug(label), name: `t779 ${label}`, paletteKey: 'consultation', graph },
  });
  const body = await response.json();
  if (response.status() === 201) created.push({ id: body.id, tenantId });
  return { status: response.status(), body };
}

/** The set of ERROR-severity rule ids in a report — the shape the assertions below reason about. */
function errorRuleIds(report: ValidationReport | null): string[] {
  return [...new Set((report?.findings ?? []).filter((f) => f.severity === 'ERROR').map((f) => f.ruleId))].sort();
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
  const rows = ((await tenants.json()).data as Array<{ id: string }>).filter((t) => t.id !== SYSTEM_TENANT_ID);
  expect(rows.length, 'at least two customer tenants must be seeded').toBeGreaterThanOrEqual(2);

  // Learn the tenant admin's own tenant from a row it authors, rather than assuming a seed id.
  const probe = await createDefinition(request, tenantAdminToken, canonicalGraph(), 'tenant_probe');
  expect(probe.status, 'tenant admin can author a definition').toBe(201);
  const probeRow = await request.get(`/api/v1/admin/workflow-definitions/${probe.body.id}`, { headers: bearer(tenantAdminToken) });
  expect(probeRow.status()).toBe(200);
  ownTenantId = (await probeRow.json()).tenantId as string;
  foreignTenantId = rows.find((t) => t.id !== ownTenantId)!.id;
});

test.afterAll(async ({ request }) => {
  for (const { id, tenantId } of created) {
    await request
      .delete(`/api/v1/admin/workflow-definitions/${id}`, { headers: bearer(superAdminToken, tenantId ?? ownTenantId) })
      .catch(() => undefined);
  }
});

test.describe(' workflow — authoring lifecycle', () => {
  test('a canonical consultation graph walks DRAFT → VALIDATED → PUBLISHED and lands in its own version lineage', async ({ request }) => {
    const { status, body } = await createDefinition(request, tenantAdminToken, canonicalGraph(), 'lifecycle');
    expect(status, 'create').toBe(201);
    expect(body.status, 'a new definition starts as a DRAFT').toBe('DRAFT');
    expect(body.versionNumber, 'the first version of a new lineage is 1').toBe(1);
    expect(body.compiledConfig, 'compiledConfig is server-produced and stays null until PUBLISHED').toBeNull();
    expect(body.validationReport?.ok, 'the canonical graph validates clean on create').toBe(true);
    expect(errorRuleIds(body.validationReport), 'the canonical graph has no ERROR findings').toEqual([]);

    // A strong ETag is stamped from `_version` — the OCC token the PATCH below needs.
    const read = await request.get(`/api/v1/admin/workflow-definitions/${body.id}`, { headers: bearer(tenantAdminToken) });
    expect(read.status()).toBe(200);
    expect(read.headers()['etag'], 'the global ETagInterceptor stamps a strong validator from _version').toBe(`"${body.version}"`);

    const validated = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/validate`, { headers: bearer(tenantAdminToken) });
    // validate is a state transition on an existing resource — 200, not 201.
    expect(validated.status(), 'validate answers 200 (a state transition, not a creation) —  F-2').toBe(200);
    const validatedBody = (await validated.json()) as Definition;
    expect(validatedBody.status, 'a clean engine gate advances DRAFT → VALIDATED').toBe('VALIDATED');
    expect(validatedBody.validatedAt, 'validatedAt is stamped').toBeTruthy();

    // Validate is idempotent re-computation, not a CAS: running it twice is fine.
    const revalidated = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/validate`, { headers: bearer(tenantAdminToken) });
    expect(revalidated.status(), 'validate is idempotent — it carries no If-Match gate by design').toBe(200);

    const published = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/publish`, {
      headers: bearer(tenantAdminToken),
      data: {},
    });
    expect(published.status(), 'publish answers 200 (a state transition, not a creation) —  F-2').toBe(200);
    const publishedBody = (await published.json()) as Definition;
    expect(publishedBody.status).toBe('PUBLISHED');
    expect(publishedBody.publishedAt, 'publishedAt is stamped').toBeTruthy();
    expect(publishedBody.isActive, 'publish defaults to activate:true — this becomes the version the dispatcher resolves').toBe(true);
    expect(publishedBody.compiledConfig, 'publish compiles the graph into the interpreter input contract').not.toBeNull();

    const versions = await request.get(`/api/v1/admin/workflow-definitions/${body.id}/versions`, { headers: bearer(tenantAdminToken) });
    expect(versions.status(), 'version lineage').toBe(200);
    const lineage = (await versions.json()) as Definition[];
    expect(
      lineage.map((v) => v.id),
      'the lineage contains this version',
    ).toContain(body.id);
    expect(new Set(lineage.map((v) => v.slug)).size, 'a lineage is exactly one (tenant, slug)').toBe(1);
  });

  test('re-publishing an already PUBLISHED version is refused 400 — publish is a one-way transition, not an update', async ({ request }) => {
    const { body } = await createDefinition(request, tenantAdminToken, canonicalGraph(), 'republish');
    const first = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/publish`, { headers: bearer(tenantAdminToken), data: {} });
    expect(first.status()).toBe(200);
    const second = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/publish`, { headers: bearer(tenantAdminToken), data: {} });
    expect(second.status(), 'a PUBLISHED row cannot be published again — branch a new draft').toBe(400);
  });
});

test.describe(' workflow — the rule catalogue at the wire', () => {
  test('a missing mandatory node reports WF-CONS-007 as an ERROR — and still publishes (rule findings are NON-blocking by design)', async ({
    request,
  }) => {
    // CR-17: `consultation.persistDraft` is mandatory. Drop it.
    const graph = chain(CANONICAL_TYPES.filter((t) => t !== 'consultation.persistDraft'));
    const { status, body } = await createDefinition(request, tenantAdminToken, graph, 'missing_mandatory');
    expect(status, 'the row is still CREATED — the rule catalogue is a report, not an admission gate').toBe(201);
    expect(errorRuleIds(body.validationReport), 'the mandatory-node rule fires').toContain('WF-CONS-007');
    expect(body.validationReport?.ok, 'a report carrying ERROR findings is not ok').toBe(false);

    // This is the surprising half, and the reason it is pinned: only the ENGINE
    // gate (shape + compile) blocks publish. DRAFT rule-catalogue findings —
    // including ERROR-severity clinical invariants — never do. If this ever
    // starts failing because publish began returning 400, that is a deliberate
    // policy change and this expectation is the place to record it.
    const published = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/publish`, {
      headers: bearer(tenantAdminToken),
      data: {},
    });
    expect(published.status(), 'ERROR-severity rule findings do NOT block publish (documented design)').toBe(200);
    expect((await published.json()).status).toBe('PUBLISHED');
  });

  test('reachability: work before the consent gate trips WF-CONS-002, work after the HITL gate trips WF-CONS-004', async ({ request }) => {
    const beforeGate = canonicalGraph();
    const consentGateId = nodeIdOfType(beforeGate, 'consultation.consentGate');
    beforeGate.nodes.push({ id: 'sneak', type: 'consultation.sensors', config: { ...BASE_CONFIG, onError: DEGRADE } });
    beforeGate.edges.push({ id: 'sneak_edge', from: 'sneak', fromPort: 'out', to: consentGateId, toPort: 'in' });
    const sneaked = await createDefinition(request, tenantAdminToken, beforeGate, 'pre_consent');
    expect(sneaked.status).toBe(201);
    expect(errorRuleIds(sneaked.body.validationReport), 'a WORK node preceding the consent gate is not reachable from it').toContain('WF-CONS-002');

    const afterGate = canonicalGraph();
    const hitlGateId = nodeIdOfType(afterGate, 'consultation.hitlGate');
    afterGate.nodes.push({ id: 'trailing', type: 'consultation.persistDraft', config: { ...BASE_CONFIG, occ: true, onError: DEGRADE } });
    afterGate.edges.push({ id: 'trailing_edge', from: hitlGateId, fromPort: 'out', to: 'trailing', toPort: 'in' });
    const trailing = await createDefinition(request, tenantAdminToken, afterGate, 'post_hitl');
    expect(trailing.status).toBe(201);
    expect(errorRuleIds(trailing.body.validationReport), 'nothing may execute after the HITL gate').toContain('WF-CONS-004');
  });

  test('the palette-agnostic bookend rule is live: a graph with no core.start trips WF-S-002', async ({ request }) => {
    const graph = chain(CANONICAL_TYPES.filter((t) => t !== 'core.start'));
    const { status, body } = await createDefinition(request, tenantAdminToken, graph, 'headless');
    expect(status).toBe(201);
    expect(errorRuleIds(body.validationReport)).toContain('WF-S-002');
  });

  test('the ENGINE gate DOES block: an unregistered node type is refused 400 at create', async ({ request }) => {
    const graph = canonicalGraph();
    graph.nodes.push({ id: 'bogus', type: 'consultation.no_such_node_type', config: { ...BASE_CONFIG } });
    graph.edges.push({ id: 'bogus_edge', from: nodeIdOfType(graph, 'consultation.sensors'), fromPort: 'out', to: 'bogus', toPort: 'in' });
    const { status } = await createDefinition(request, tenantAdminToken, graph, 'unknown_type');
    expect(status, 'an unregistered node type fails the shape/engine gate — this one is blocking, unlike rule findings').toBe(400);
  });

  test('the ENGINE gate DOES block: a cyclic graph is refused 400 at create', async ({ request }) => {
    const graph = canonicalGraph();
    // Close a loop from the last work node back to the capture node.
    graph.edges.push({
      id: 'cycle',
      from: nodeIdOfType(graph, 'consultation.persistDraft'),
      fromPort: 'out',
      to: nodeIdOfType(graph, 'consultation.captureBinding'),
      toPort: 'in',
    });
    const { status } = await createDefinition(request, tenantAdminToken, graph, 'cyclic');
    expect(status, 'a cycle cannot compile').toBe(400);
  });
});

test.describe(' workflow — optimistic concurrency on PATCH', () => {
  test('missing If-Match → 428; stale → 412; correct → 200 with a bumped ETag; replaying the old validator → 412', async ({ request }) => {
    const { body } = await createDefinition(request, tenantAdminToken, canonicalGraph(), 'occ');
    expect(body.version, 'a fresh row starts at _version 1').toBe(1);

    const noHeader = await request.patch(`/api/v1/admin/workflow-definitions/${body.id}`, {
      headers: bearer(tenantAdminToken),
      data: { name: 't779 occ renamed' },
    });
    expect(noHeader.status(), '@RequiresIfMatch: an unconditional write is refused 428, not silently applied').toBe(428);

    const stale = await request.patch(`/api/v1/admin/workflow-definitions/${body.id}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"99"' },
      data: { name: 't779 occ renamed' },
    });
    expect(stale.status(), 'a validator that does not match _version is a 412 conflict').toBe(412);

    const ok = await request.patch(`/api/v1/admin/workflow-definitions/${body.id}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${body.version}"` },
      data: { name: 't779 occ renamed' },
    });
    expect(ok.status(), 'the correct validator applies the patch').toBe(200);
    const patched = (await ok.json()) as Definition;
    expect(patched.version, 'a successful write increments _version').toBe(body.version + 1);
    expect(ok.headers()['etag'], 'the response carries the NEW validator').toBe(`"${patched.version}"`);

    const replay = await request.patch(`/api/v1/admin/workflow-definitions/${body.id}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${body.version}"` },
      data: { name: 't779 occ replayed' },
    });
    expect(replay.status(), 'replaying a consumed validator is exactly the lost-update case OCC exists to stop').toBe(412);
  });

  test('a PUBLISHED version rejects PATCH with 400 even when the validator is correct — immutability is not an OCC failure', async ({ request }) => {
    const { body } = await createDefinition(request, tenantAdminToken, canonicalGraph(), 'occ_published');
    const published = await request.post(`/api/v1/admin/workflow-definitions/${body.id}/publish`, {
      headers: bearer(tenantAdminToken),
      data: {},
    });
    expect(published.status()).toBe(200);
    const current = (await published.json()) as Definition;

    const patch = await request.patch(`/api/v1/admin/workflow-definitions/${body.id}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${current.version}"` },
      data: { name: 't779 published rename' },
    });
    expect(patch.status(), 'a PUBLISHED row is immutable — branch a new draft instead').toBe(400);
  });
});

test.describe(' workflow — cross-tenant isolation', () => {
  test('every by-id operation on a FOREIGN tenant’s definition is 404, never 403', async ({ request }) => {
    const foreign = await createDefinition(request, superAdminToken, canonicalGraph(), 'foreign', foreignTenantId);
    expect(foreign.status, 'super admin authors a real row inside the foreign tenant').toBe(201);
    // A real row, so a 404 proves the tenant boundary rather than mere absence.
    expect(foreign.body.id).toBeTruthy();

    const probes: Array<[string, () => Promise<{ status(): number }>]> = [
      ['GET :id', () => request.get(`/api/v1/admin/workflow-definitions/${foreign.body.id}`, { headers: bearer(tenantAdminToken) })],
      [
        'GET :id/versions',
        () => request.get(`/api/v1/admin/workflow-definitions/${foreign.body.id}/versions`, { headers: bearer(tenantAdminToken) }),
      ],
      [
        'PATCH :id',
        () =>
          request.patch(`/api/v1/admin/workflow-definitions/${foreign.body.id}`, {
            headers: { ...bearer(tenantAdminToken), 'If-Match': `"${foreign.body.version}"` },
            data: { name: 't779 cross tenant' },
          }),
      ],
      [
        'POST :id/validate',
        () => request.post(`/api/v1/admin/workflow-definitions/${foreign.body.id}/validate`, { headers: bearer(tenantAdminToken) }),
      ],
      [
        'POST :id/publish',
        () => request.post(`/api/v1/admin/workflow-definitions/${foreign.body.id}/publish`, { headers: bearer(tenantAdminToken), data: {} }),
      ],
      ['DELETE :id', () => request.delete(`/api/v1/admin/workflow-definitions/${foreign.body.id}`, { headers: bearer(tenantAdminToken) })],
    ];

    for (const [label, run] of probes) {
      const response = await run();
      expect(response.status(), `${label} across the tenant boundary → 404 (404-over-403 posture)`).toBe(404);
    }

    // No collateral damage: the owning tenant still resolves its row.
    const survivor = await request.get(`/api/v1/admin/workflow-definitions/${foreign.body.id}`, {
      headers: bearer(superAdminToken, foreignTenantId),
    });
    expect(survivor.status(), 'the foreign row survived every denied probe').toBe(200);
    expect((await survivor.json()).status, 'and was NOT published by the cross-tenant publish attempt').toBe('DRAFT');
  });

  test('a foreign tenant’s definitions never appear in the caller’s list', async ({ request }) => {
    const foreign = await createDefinition(request, superAdminToken, canonicalGraph(), 'foreign_list', foreignTenantId);
    expect(foreign.status).toBe(201);

    const list = await request.get('/api/v1/admin/workflow-definitions?page=1&limit=100', { headers: bearer(tenantAdminToken) });
    expect(list.status()).toBe(200);
    const body = await list.json();
    const rows = (body.data ?? body.items ?? []) as Definition[];
    expect(
      rows.map((r) => r.id),
      'the tenant-scope extension must exclude the foreign row',
    ).not.toContain(foreign.body.id);
    for (const row of rows as Array<Definition & { tenantId: string }>) {
      expect(row.tenantId, 'every listed row belongs to the caller tenant').toBe(ownTenantId);
    }
  });
});
