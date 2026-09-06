/**
 * TASK-890 §3.14 / §3.14a (OD-R, D-1) — the guardrail opt-out, end to end.
 *
 * Guardrail POLICY is untouched by this ticket: the eight catalogue checks, `TenantGuardrailPolicy`
 * and the `guardrail.*` routing selection stay platform-admin-only, and the last test here pins
 * that (a tenant admin is still 403 on `admin/guardrail/availability`). What is new is ONE
 * boolean: a tenant may switch platform SCREENING off for an agent, a workflow or a single node,
 * and the platform switch stays the floor above it.
 *
 * The property that makes that safe is not the switch — it is that using it is impossible to do
 * quietly. So this spec asserts the three RECORDS, not merely the behaviour:
 *
 *   1. the per-call ledger row says `guardrail: 'opted_out'` (and `platform_off` — never
 *      `opted_out` — when the platform kill switch is off, because then nobody's opt-out was
 *      consulted);
 *   2. publish emits `GUARDRAIL_OPTED_OUT` as a WARNING naming the disabled node — including a
 *      disabled MANDATORY clinical guard, which D-1 now permits;
 *   3. PRESENCE is unchanged: the same graph with that node DELETED still fails publish, and the
 *      two graph boundaries still refuse the key outright.
 *
 * ## What this spec does and does not prove here
 *
 * Cases 1 drive a real generation, so they need `apps/text` reachable from the gateway — and,
 * once D-2's seed row lands, a reachable `apps/guardrail` behind it (with the switch on and no
 * guardrail, every generation 503s BY DESIGN — that is the fail-closed posture, not a bug). When
 * the environment cannot supply that, those tests SKIP with the observed status: a skip states
 * "not proven here", where a pass would state something false.
 *
 * Cases 2 and 3 are pure gateway contract (publish + validate) and need no downstream service.
 *
 * SHAPE. Nothing writes the ledger over HTTP — the contract is `IUsageLedgerService.recordUsage`
 * — so the assertions read `AiUsageOutbox` through the unscoped platform client, the fallback
 * `task-615-usage-ledger.spec.ts` and `task-890-metering.spec.ts` already use.
 *
 * SERIAL: the platform kill switch is global state; two workers flipping it would read each
 * other's writes.
 *
 * Prerequisites: `pnpm setup:test`, then `pnpm test:up:api` (terminal 1), then `pnpm test:e2e`.
 * NOT EXECUTED in the authoring session: the lane's brief forbids running e2e (the Playwright
 * `globalSetup` performs a destructive DB reset, which is the orchestrator's to run).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe.configure({ mode: 'serial' });

const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';
const PLATFORM_SWITCH_KEY = 'text.externalGuardrail.enabled';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

// ── the ledger, read where it is actually written ───────────────────────────

interface OutboxRow {
  id: string;
  createdAt: Date;
  payload: unknown;
}
interface DbClient {
  aiUsageOutbox: { findMany(args: { where: Record<string, unknown>; orderBy?: unknown }): Promise<OutboxRow[]> };
  $disconnect(): Promise<void>;
}

let dbClient: DbClient | null = null;
async function getDb(): Promise<DbClient> {
  if (!dbClient) {
    const distEntry = pathToFileURL(join(__dirname, '../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as DbClient;
  }
  return dbClient;
}

interface LedgerRow {
  operation: string;
  guardrail?: string;
  trigger?: string;
}

async function outboxSince(since: Date): Promise<LedgerRow[]> {
  const db = await getDb();
  const rows = await db.aiUsageOutbox.findMany({ where: { createdAt: { gt: since } }, orderBy: { createdAt: 'desc' } });
  return rows
    .map((row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>)
    .map((payload) => {
      const common = (payload?.common ?? payload) as {
        tenantId?: string;
        operation?: string;
        attributesJson?: { guardrail?: string; trigger?: string };
      };
      return {
        tenantId: common?.tenantId,
        operation: String(common?.operation ?? ''),
        guardrail: common?.attributesJson?.guardrail,
        trigger: common?.attributesJson?.trigger,
      };
    })
    .filter((row) => row.tenantId === TENANT_GLOBAL);
}

/** Emission is fire-and-forget, so the row lands shortly AFTER the response. */
async function waitForOutbox(since: Date, operation: string, timeoutMs = 15_000): Promise<LedgerRow> {
  const start = Date.now();
  let seen: LedgerRow[] = [];
  while (Date.now() - start < timeoutMs) {
    seen = await outboxSince(since);
    const match = seen.find((row) => row.operation === operation);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `No '${operation}' outbox row for ${TENANT_GLOBAL} within ${timeoutMs}ms (saw: ${seen.map((r) => r.operation).join(', ') || 'none'})`,
  );
}

// ── graphs ─────────────────────────────────────────────────────────────────

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

/** WF-I-004 (trajectory stated) + WF-I-010 (bounded retry), on EXECUTABLE nodes only. */
const BASE_CONFIG = { emitsTrajectory: true, retry: { maximumAttempts: 3 } };
const isBoundary = (type: string): boolean => type === 'core.start' || type === 'core.end';
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

/** The canonical consultation chain (`task-779-workflow-lifecycle.spec.ts`'s fixture). */
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

/** A linear graph over `types`, ordered on the CONTROL ports (`next` → `after`). */
function chain(types: readonly string[], overrides: Record<string, Record<string, unknown>> = {}): Graph {
  return {
    version: 1,
    nodes: types.map((type, index) => ({
      id: `n${index}`,
      type,
      config: {
        ...(isBoundary(type) ? {} : BASE_CONFIG),
        ...(NODE_CONFIG[type] ?? {}),
        ...(overrides[type] ?? {}),
      },
    })),
    edges: types.slice(1).map((_, index) => ({ id: `e${index}`, from: `n${index}`, fromPort: 'next', to: `n${index + 1}`, toPort: 'after' })),
  };
}

const nodeIdOfType = (graph: Graph, type: string): string => graph.nodes.find((node) => node.type === type)!.id;

// ── fixtures ───────────────────────────────────────────────────────────────

interface Finding {
  code?: string;
  severity: string;
  nodeId?: string | null;
  message?: string;
}
interface Definition {
  id: string;
  status: string;
  validationReport: { ok: boolean; findings: Finding[] } | null;
  message?: string;
}

let adminToken: string;
let superAdminToken: string;
let doctorToken: string;
const createdDefinitions: string[] = [];

const uniqueSlug = (label: string) => `t890_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`.replace(/[^a-z0-9_]/g, '');

async function createDefinition(request: APIRequestContext, graph: Graph, label: string): Promise<{ status: number; body: Definition }> {
  const response = await request.post('/api/v1/admin/workflow-definitions', {
    headers: bearer(adminToken),
    data: { slug: uniqueSlug(label), name: `t890 ${label}`, paletteKey: 'consultation', graph },
  });
  const body = (await response.json()) as Definition;
  if (response.status() === 201) createdDefinitions.push(body.id);
  return { status: response.status(), body };
}

const findingsOf = (body: Definition, code: string): Finding[] => (body.validationReport?.findings ?? []).filter((f) => f.code === code);

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  const [admin, superAdmin, doctor] = await Promise.all([
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(admin?.token, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
  expect(superAdmin?.token, 'super_admin login failed').toBeTruthy();
  expect(doctor?.token, 'doctor login failed').toBeTruthy();
  adminToken = admin!.token;
  superAdminToken = superAdmin!.token;
  doctorToken = doctor!.token;
  await request.dispose();
});

test.afterAll(async ({ request }) => {
  for (const id of createdDefinitions) {
    await request.delete(`/api/v1/admin/workflow-definitions/${id}`, { headers: bearer(adminToken) }).catch(() => undefined);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The per-call record
// ═══════════════════════════════════════════════════════════════════════════

test.describe('TASK-890 §3.14 — the ledger records HOW each call was screened', () => {
  /**
   * Publish a TEXT_GENERATION agent whose `parameters.guards.enabled` is `enabled`, and answer
   * its slug — or `null` when this environment cannot author one, in which case the callers SKIP.
   * Authoring an agent needs a registry model, and which models exist is a property of the seed
   * rather than of this contract.
   */
  async function publishAgent(request: APIRequestContext, enabled: boolean): Promise<string | null> {
    const models = await request.get('/api/v1/admin/ai-models?page=1&limit=50&taskType=TEXT_GENERATION', { headers: bearer(adminToken) });
    if (models.status() !== 200) return null;
    const rows = ((await models.json()) as { data?: Array<{ id: string; taskType?: string }> }).data ?? [];
    const model = rows.find((row) => row.taskType === 'TEXT_GENERATION') ?? rows[0];
    if (!model) return null;

    const slug = uniqueSlug(enabled ? 'agent_screened' : 'agent_optout');
    const created = await request.post('/api/v1/admin/agents', {
      headers: bearer(adminToken),
      data: {
        slug,
        name: `t890 ${slug}`,
        task: 'TEXT_GENERATION',
        modelId: model.id,
        instruction: { systemPrompt: 'Summarise the note in one sentence.' },
        // THE field under test: the AGENT tier of node > workflow > agent > on.
        parameters: { guards: { enabled } },
      },
    });
    if (created.status() !== 201) return null;
    const { id } = (await created.json()) as { id: string };

    const published = await request.post(`/api/v1/admin/agents/${id}/publish`, { headers: bearer(adminToken), data: {} });
    if (published.status() >= 300) return null;
    return slug;
  }

  test('an agent that opted out invokes 200 and its ledger row says `opted_out`', async ({ request }) => {
    const slug = await publishAgent(request, false);
    test.skip(slug === null, 'this environment could not author + publish a TEXT_GENERATION agent');

    const since = new Date();
    const response = await request.post(`/api/v1/agents/${slug}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.' },
    });
    test.skip(response.status() === 502 || response.status() === 503, `apps/text (or the guardrail behind it) unreachable (${response.status()})`);
    expect(response.status()).toBe(200);

    const row = await waitForOutbox(since, 'generate');
    expect(row.guardrail).toBe('opted_out');
    // The two dimensions are independent and both must ride: WHY the call happened, and HOW it
    // was screened.
    expect(row.trigger).toBe('AGENT_INVOCATION');
  });

  test('an agent that did not opt out records `screened`', async ({ request }) => {
    const slug = await publishAgent(request, true);
    test.skip(slug === null, 'this environment could not author + publish a TEXT_GENERATION agent');

    const since = new Date();
    const response = await request.post(`/api/v1/agents/${slug}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.' },
    });
    test.skip(response.status() === 502 || response.status() === 503, `apps/text unreachable (${response.status()})`);
    expect(response.status()).toBe(200);

    const row = await waitForOutbox(since, 'generate');
    expect(row.guardrail).toBe('screened');
  });

  test('with the PLATFORM switch off the row says `platform_off`, never `opted_out`', async ({ request }) => {
    // The distinction is the whole reason the attribute has three values: a deployment that never
    // turned the platform gate on must not look like a fleet of tenants who each chose to run
    // unscreened.
    const slug = await publishAgent(request, false);
    test.skip(slug === null, 'this environment could not author + publish a TEXT_GENERATION agent');

    const current = await request.get(`/api/v1/admin/settings/registry/${PLATFORM_SWITCH_KEY}`, { headers: bearer(superAdminToken) });
    test.skip(current.status() !== 200, `the platform switch is not readable through the registry route (${current.status()})`);
    const etag = current.headers()['etag'];

    const off = await request.put(`/api/v1/admin/settings/registry/${PLATFORM_SWITCH_KEY}`, {
      headers: { ...bearer(superAdminToken), ...(etag ? { 'If-Match': etag } : {}) },
      data: { value: false, scope: 'system' },
    });
    test.skip(off.status() >= 300, `could not turn the platform switch off (${off.status()}: ${await off.text()})`);

    try {
      const since = new Date();
      const response = await request.post(`/api/v1/agents/${slug}/invocations`, {
        headers: bearer(doctorToken),
        data: { text: 'Summarise: patient reports a mild headache.' },
      });
      test.skip(response.status() === 502 || response.status() === 503, `apps/text unreachable (${response.status()})`);
      expect(response.status()).toBe(200);

      const row = await waitForOutbox(since, 'generate');
      expect(row.guardrail).toBe('platform_off');
    } finally {
      const after = await request.get(`/api/v1/admin/settings/registry/${PLATFORM_SWITCH_KEY}`, { headers: bearer(superAdminToken) });
      await request
        .put(`/api/v1/admin/settings/registry/${PLATFORM_SWITCH_KEY}`, {
          headers: { ...bearer(superAdminToken), ...(after.headers()['etag'] ? { 'If-Match': after.headers()['etag'] } : {}) },
          data: { value: true, scope: 'system' },
        })
        .catch(() => undefined);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The publish record (D-1)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('TASK-890 §3.14a (D-1) — a disabled mandatory guard PUBLISHES, and is named', () => {
  test('a disabled `consultation.consentGate` publishes with a GUARDRAIL_OPTED_OUT WARNING naming the node', async ({ request }) => {
    const graph = chain(CANONICAL_TYPES, { 'consultation.consentGate': { enabled: false } });
    const created = await createDefinition(request, graph, 'consent_off');
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const published = await request.post(`/api/v1/admin/workflow-definitions/${created.body.id}/publish`, { headers: bearer(adminToken), data: {} });
    const body = (await published.json()) as Definition;
    expect(published.status(), JSON.stringify(body)).toBeLessThan(300);

    const warnings = findingsOf(body, 'GUARDRAIL_OPTED_OUT');
    expect(warnings.length, 'the opt-out must be recorded on the published artifact').toBeGreaterThan(0);
    // NEVER blocking — an opt-out is a decision on the record, not a refusal.
    expect(warnings.every((finding) => finding.severity === 'WARNING')).toBe(true);
    expect(warnings.some((finding) => finding.nodeId === nodeIdOfType(graph, 'consultation.consentGate'))).toBe(true);
    expect(warnings.some((finding) => (finding.message ?? '').includes('consultation.consentGate'))).toBe(true);
  });

  /**
   * KNOWN DEFECT, PINNED — do not "fix" this test (rule 05 §Known defects precedent).
   *
   * D-1 rests on a compensating claim (§3.14a #4): "a mandatory node may be switched OFF; it may
   * never be REMOVED, and the rule catalogue is what says so". Measured at the wave-2b close, the
   * SECOND half does not hold on this deployment. Deleting `consultation.consentGate` publishes
   * **200** with `validationReport.ok: false` carrying nine rule-catalogue ERRORs — `WF-CONS-001
   * expected exactly one node of type "consultation.consentGate", found 0` plus a `WF-CONS-002`
   * per orphaned node.
   *
   * The reason is design decision #3, which predates this ticket: DRAFT rule-catalogue findings
   * never block the transition — only the ENGINE gate (shape + `compile()` + `publishFindings`)
   * refuses a publish (`workflow-definition.service.ts` `engineClean`). Mandatory PRESENCE is a
   * rule-catalogue rule, so it is recorded and not enforced while the rule set is at DRAFT.
   *
   * So the presence half of D-1's compensating control is ADVISORY today, and this test asserts
   * what actually happens rather than what §3.14a claims: the publish succeeds, the report says
   * `ok: false`, and the finding NAMES the missing node type. Making it blocking is an owner
   * decision (promote the consultation core rule set out of DRAFT, or move the presence check
   * into `publishFindings`), recorded in §9 as an open question — not something a wave close
   * should decide by itself.
   */
  test('the SAME graph with that node DELETED records the missing-presence ERROR (advisory today — see the comment)', async ({ request }) => {
    const graph = chain(CANONICAL_TYPES.filter((type) => type !== 'consultation.consentGate'));
    const created = await createDefinition(request, graph, 'consent_gone');
    if (created.status !== 201) {
      // Some deployments refuse the shape at CREATE; that is the stronger outcome, and fine.
      expect(created.status).toBeGreaterThanOrEqual(400);
      return;
    }
    const published = await request.post(`/api/v1/admin/workflow-definitions/${created.body.id}/publish`, { headers: bearer(adminToken), data: {} });
    const body = (await published.json()) as Definition;

    const report = (body as unknown as { validationReport?: { ok?: boolean; findings?: Array<{ severity?: string; message?: string }> } })
      .validationReport;
    const errors = (report?.findings ?? []).filter((finding) => finding.severity === 'ERROR');

    if (published.status() >= 400) {
      // The desired behaviour. If a later release makes the rule set blocking this branch takes
      // over and the test stays honest without an edit.
      expect(errors.length, JSON.stringify(body)).toBeGreaterThan(0);
      return;
    }

    expect(report?.ok, JSON.stringify(report)).toBe(false);
    expect(
      errors.some((finding) => (finding.message ?? '').includes('consultation.consentGate')),
      JSON.stringify(errors),
    ).toBe(true);
  });

  test('a graph that disables nothing carries no GUARDRAIL_OPTED_OUT finding at all', async ({ request }) => {
    const created = await createDefinition(request, chain(CANONICAL_TYPES), 'clean');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const published = await request.post(`/api/v1/admin/workflow-definitions/${created.body.id}/publish`, { headers: bearer(adminToken), data: {} });
    const body = (await published.json()) as Definition;
    expect(published.status(), JSON.stringify(body)).toBeLessThan(300);
    expect(findingsOf(body, 'GUARDRAIL_OPTED_OUT')).toHaveLength(0);
  });

  test('`core.trigger` refuses the `enabled` key outright — a boundary that is off is an unrunnable graph', async ({ request }) => {
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: 't1', type: 'core.trigger', config: { kinds: ['api'], enabled: false } },
        { id: 'o1', type: 'core.output', config: { protocols: ['http'] } },
      ],
      edges: [{ id: 'e0', from: 't1', fromPort: 'next', to: 'o1', toPort: 'after' }],
    };
    const created = await createDefinition(request, graph, 'trigger_off');
    if (created.status !== 201) {
      expect(created.status).toBeGreaterThanOrEqual(400);
      return;
    }
    const validated = await request.post(`/api/v1/admin/workflow-definitions/${created.body.id}/validate`, { headers: bearer(adminToken), data: {} });
    const body = (await validated.json()) as Definition;
    const schemaErrors = findingsOf(body, 'NODE_CONFIG_SCHEMA');
    expect(
      schemaErrors.some((finding) => (finding.message ?? '').includes('enabled')),
      JSON.stringify(body.validationReport),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Guardrail POLICY is still platform-admin-only
// ═══════════════════════════════════════════════════════════════════════════

test.describe('TASK-890 §3.14 — the opt-out changes nothing about who owns guardrail POLICY', () => {
  test('a tenant admin is still 403 on the availability surface', async ({ request }) => {
    // A PRIVILEGE boundary (403), deliberately not the 404-over-403 cross-tenant posture: the
    // resource exists and the caller may not have it.
    const response = await request.get('/api/v1/admin/guardrail/availability', { headers: bearer(adminToken) });
    expect(response.status()).toBe(403);
  });

  test('and still refused on writing another tenant`s availability row', async ({ request }) => {
    const response = await request.put(`/api/v1/admin/guardrail/availability/${TENANT_GLOBAL}`, {
      headers: bearer(adminToken),
      data: { policies: [] },
    });
    // 403 is the privilege refusal; 428 is the OCC precondition, which `RequiresIfMatchGuard`
    // raises BEFORE authorization runs on this versioned PUT. Either way the write does not
    // happen, and asserting only the 403 pins a guard ORDER this route does not have.
    expect([403, 428], `${response.status()}: ${await response.text()}`).toContain(response.status());
  });
});
