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
 *   - the rule catalogue AT THE WIRE (the `WF-CORE-*` boundary rules and the
 *     palette-agnostic `WF-S-*` bookends) and, importantly, which findings BLOCK
 *     and which do not;
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

/**
 * TASK-893 retired the legacy `consultation.*` vocabulary; this fixture is authored in the
 * `core` vocabulary that replaced it (`packages/workflow-contract/src/node-registry.ts`), and
 * mirrors the shape of the seeded reference graphs in
 * `packages/database/src/prisma/db_main/seed/28-workflow-library.ts`.
 *
 * Two things about the config objects are load-bearing:
 *
 *  - `emitsTrajectory` is GONE. Every `core.*` config schema is `additionalProperties: false`
 *    and none of them declares it, so stamping it is a `NODE_CONFIG_SCHEMA` ERROR at the
 *    publish gate. Nothing asks for it either: `WF-I-004` (which did) is `paletteKey:
 *    'summarization'`, and `validate()` drops every rule whose palette is not the definition's.
 *  - The surviving fixed-purpose clinical steps are ACTIONS, not node types: one `core.action`
 *    node carrying `actionKey` plus the action's own config under `action`
 *    (`packages/workflow-contract/src/action-catalogue.ts`, 17 keys).
 */
const DEGRADE = 'degrade';

/** The canonical `core` consultation shape: trigger → consent → PHI hop → persist → review → output. */
const CANONICAL_NODES: ReadonlyArray<Omit<GraphNode, 'id'>> = [
  { type: 'core.trigger', config: { kinds: ['consultation', 'api'] } },
  { type: 'core.action', config: { actionKey: 'consultation.consentGate', action: {}, onError: DEGRADE } },
  { type: 'core.action', config: { actionKey: 'consultation.phiHop', action: { mode: 'pseudonymize' }, onError: DEGRADE } },
  { type: 'core.action', config: { actionKey: 'consultation.persistDraft', action: { occ: true }, onError: DEGRADE } },
  { type: 'core.humanReview', config: { reviewType: 'clinical_finalization', assignRole: 'DOCTOR', timeoutSeconds: 3600 } },
  { type: 'core.output', config: { protocols: ['http'] } },
];

/**
 * A linear graph over `specs`, ordered on the CONTROL ports.
 *
 * `next` → `after`, not `out` → `in`. Every node in this vocabulary declares a control pair
 * (`after` in, `next` out) beside its typed data sockets, and only the control pair composes
 * into an arbitrary chain: the data ports carry primitives (`transcript`, `entities`,
 * `document`, `verdict`), so chaining the canonical nodes on them is not merely mis-named — it
 * is type-incompatible, and `workflowEdgePortProblems` refuses it at the publish gate.
 *
 * `core.trigger` declares no input ports and `core.output` no output ports; they are the graph
 * boundaries, so they can only ever be the head and the tail of the chain.
 */
function chain(specs: ReadonlyArray<Omit<GraphNode, 'id'>>): Graph {
  return {
    version: 1,
    nodes: specs.map((spec, index) => ({ id: `n${index}`, type: spec.type, config: { ...spec.config } })),
    edges: specs.slice(1).map((_, index) => ({ id: `e${index}`, from: `n${index}`, fromPort: 'next', to: `n${index + 1}`, toPort: 'after' })),
  };
}

const canonicalGraph = (): Graph => chain(CANONICAL_NODES);

/** Addresses a fixture node by type, or — for `core.action` — by the action key it carries. */
function nodeIdOfType(graph: Graph, type: string, actionKey?: string): string {
  const node = graph.nodes.find((n) => n.type === type && (actionKey === undefined || n.config.actionKey === actionKey));
  expect(node, `fixture must contain a ${actionKey ?? type} node`).toBeTruthy();
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
    data: { slug: uniqueSlug(label), name: `t779 ${label}`, paletteKey: 'core', graph },
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
  test('a missing mandatory node reports WF-CORE-002 as an ERROR — and still publishes (rule findings are NON-blocking by design)', async ({
    request,
  }) => {
    // `core.output` is mandatory — a run must declare what it returns (WF-CORE-002). Drop it.
    // (This case pinned the consultation palette's `WF-CONS-007` until TASK-893 deleted that
    // rule set with the palette; `WF-CORE-002` is the surviving mandatory-node rule.)
    const graph = chain(CANONICAL_NODES.filter((n) => n.type !== 'core.output'));
    const { status, body } = await createDefinition(request, tenantAdminToken, graph, 'missing_mandatory');
    expect(status, 'the row is still CREATED — the rule catalogue is a report, not an admission gate').toBe(201);
    expect(errorRuleIds(body.validationReport), 'the mandatory-node rule fires').toContain('WF-CORE-002');
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

  /*
   * DELETED (TASK-930 D-9, TASK-893 Phase 4): 'reachability: work before the consent gate trips
   * WF-CONS-002, work after the HITL gate trips WF-CONS-004'.
   *
   * `DRAFT_CONSULTATION_RULE_SET` (`WF-CONS-001..019`) was deleted with the `consultation`
   * palette's node types — a rule scoped to a palette that no longer exists can never fire, and
   * `consultation.hitlGate` (the node the second half addressed) left the vocabulary entirely;
   * the durable human wait is `core.humanReview` now. The successor ordering rule, `WF-CORE-003`
   * ("core.output is never upstream of core.trigger"), is structurally UNAUTHORABLE at the wire:
   * `core.trigger` declares no input ports and `core.output` no output ports, so no edge can
   * invert the boundaries for it to catch. Nothing was retargeted here rather than something
   * weaker being asserted in its place.
   */

  test('the palette-agnostic bookend rule is live: a graph with no core.trigger trips WF-S-002', async ({ request }) => {
    // `WF-S-002` is CLASS-based (`entryClass: 'entry'`), and `core.trigger` is the one
    // `entry`-classed type left since TASK-893 retired `core.start`.
    const graph = chain(CANONICAL_NODES.filter((n) => n.type !== 'core.trigger'));
    const { status, body } = await createDefinition(request, tenantAdminToken, graph, 'headless');
    expect(status).toBe(201);
    expect(errorRuleIds(body.validationReport)).toContain('WF-S-002');
  });

  test('the ENGINE gate DOES block: an unregistered node type is refused 400 at create', async ({ request }) => {
    const graph = canonicalGraph();
    graph.nodes.push({ id: 'bogus', type: 'core.no_such_node_type', config: {} });
    graph.edges.push({
      id: 'bogus_edge',
      from: nodeIdOfType(graph, 'core.action', 'consultation.persistDraft'),
      fromPort: 'next',
      to: 'bogus',
      toPort: 'after',
    });
    const { status } = await createDefinition(request, tenantAdminToken, graph, 'unknown_type');
    expect(status, 'an unregistered node type fails the shape/engine gate — this one is blocking, unlike rule findings').toBe(400);
  });

  test('the ENGINE gate DOES block: a cyclic graph is refused 400 at create', async ({ request }) => {
    const graph = canonicalGraph();
    // Close a loop from the last work node back to the consent gate.
    graph.edges.push({
      id: 'cycle',
      from: nodeIdOfType(graph, 'core.action', 'consultation.persistDraft'),
      fromPort: 'next',
      to: nodeIdOfType(graph, 'core.action', 'consultation.consentGate'),
      toPort: 'after',
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
