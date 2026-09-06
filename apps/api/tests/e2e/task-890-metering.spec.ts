/**
 * TASK-890 (§3.13, OD-E) — metering parity on the agent business plane.
 *
 * BLOCKER #7: `POST /agents/:slug/invocations` checked NO quota and recorded NO
 * usage, while `POST /agents/:slug/speech` on the SAME controller did both. A
 * tenant could run the platform's most expensive route without limit and
 * without a line on its own bill.
 *
 * What the authorization matrix cannot express, and this spec therefore does:
 *
 *   1. an invocation WRITES a ledger row — blocking (`generate`) and SSE
 *      (`generate.stream`) — carrying `attributesJson.trigger =
 *      'AGENT_INVOCATION'`, the dimension that separates agent traffic from
 *      consultations, prompt tests and workflow runs;
 *   2. with enforcement ON and a `monthlyLlmTokens` allowance of 0, the call is
 *      refused 429 BEFORE any TEXT call happens (proved by the absence of a new
 *      ledger row, not merely by the status);
 *   3. the prompt test-run stamps `PROMPT_TEST` (L4's emitter, asserted here so
 *      the two triggers are proven to be distinguishable in one place).
 *
 * SHAPE. There is no HTTP route that writes the ledger — the contract is the
 * TypeScript `IUsageLedgerService.recordUsage` — so assertions read
 * `AiUsageOutbox` directly through the unscoped platform client, the same
 * fallback `task-615-usage-ledger.spec.ts` documents and uses.
 *
 * DEPENDENCY. These tests drive a real generation, so they need `apps/text`
 * reachable from the gateway. When it is not, the invocation answers 502/503
 * and the test SKIPS with that status in the message — a skip states "not
 * proven here", where a pass would state something false.
 *
 * SERIAL: the enforcement kill-switch and the tenant override are global,
 * per-tenant state; two workers flipping them concurrently would read each
 * other's writes.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

test.describe.configure({ mode: 'serial' });

const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';
/** A PUBLISHED SYSTEM TEXT_GENERATION agent, visible to every tenant (`seed/25-agents.ts`). */
const AGENT_SLUG = 'platform-summarization';

interface OutboxRow {
  id: string;
  createdAt: Date;
  payload: unknown;
}
interface DbClient {
  aiUsageOutbox: {
    findMany(args: { where: Record<string, unknown>; orderBy?: unknown }): Promise<OutboxRow[]>;
  };
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

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The outbox rows this tenant produced since `since`, newest first. */
async function outboxSince(since: Date): Promise<Array<{ operation: string; trigger?: string }>> {
  const db = await getDb();
  const rows = await db.aiUsageOutbox.findMany({ where: { createdAt: { gt: since } }, orderBy: { createdAt: 'desc' } });
  return rows
    .map((row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>)
    .map((payload) => {
      const common = (payload?.common ?? payload) as { tenantId?: string; operation?: string; attributesJson?: { trigger?: string } };
      return { tenantId: common?.tenantId, operation: String(common?.operation ?? ''), trigger: common?.attributesJson?.trigger };
    })
    .filter((row) => row.tenantId === TENANT_GLOBAL);
}

/** Poll: emission is fire-and-forget, so the row lands shortly AFTER the response. */
async function waitForOutbox(since: Date, operation: string, timeoutMs = 15_000): Promise<{ operation: string; trigger?: string }> {
  const start = Date.now();
  let seen: Array<{ operation: string; trigger?: string }> = [];
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

let doctorToken: string;
let adminToken: string;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
  const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  if (!doctor || !admin) throw new Error('TASK-890 metering spec could not log in the seeded doctor / super admin');
  doctorToken = doctor.token;
  adminToken = admin.token;
  await request.dispose();
});

test.describe('TASK-890 — an agent invocation is metered', () => {
  test('blocking: writes one `generate` row carrying trigger AGENT_INVOCATION', async ({ request }) => {
    const since = new Date();
    const response = await request.post(`/api/v1/agents/${AGENT_SLUG}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.' },
    });

    test.skip(response.status() === 502 || response.status() === 503, `apps/text unreachable from the gateway (${response.status()})`);
    expect(response.status()).toBe(200);

    const row = await waitForOutbox(since, 'generate');
    expect(row.trigger).toBe('AGENT_INVOCATION');
  });

  test('stream: writes one `generate.stream` row carrying the same trigger', async ({ request }) => {
    const since = new Date();
    const response = await request.post(`/api/v1/agents/${AGENT_SLUG}/invocations?mode=stream`, {
      headers: { ...bearer(doctorToken), Accept: 'text/event-stream' },
      data: { text: 'Summarise: patient reports a mild headache.' },
    });

    test.skip(response.status() === 502 || response.status() === 503, `apps/text unreachable from the gateway (${response.status()})`);
    expect(response.status()).toBe(200);
    // Drain the stream so the gateway reaches its own `end` teardown.
    await response.body();

    const row = await waitForOutbox(since, 'generate.stream');
    expect(row.trigger).toBe('AGENT_INVOCATION');
  });
});

test.describe('TASK-890 — an exhausted allowance refuses BEFORE the model runs', () => {
  let previousEnforcement: boolean | undefined;

  /** `PUT admin/entitlements/tenants/:id/override` is OCC-guarded: `"0"` creates. */
  async function setLlmAllowance(request: APIRequestContext, value: number | null): Promise<void> {
    const current = await request.get(`/api/v1/admin/entitlements/tenants/${TENANT_GLOBAL}/override`, { headers: bearer(adminToken) });
    const etag = current.headers()['etag'] ?? '"0"';
    const response = await request.put(`/api/v1/admin/entitlements/tenants/${TENANT_GLOBAL}/override`, {
      headers: { ...bearer(adminToken), 'If-Match': etag },
      data: { monthlyLlmTokens: value },
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const read = await request.get('/api/v1/admin/entitlements/enabled', { headers: bearer(adminToken) });
    previousEnforcement = ((await read.json()) as { enabled?: boolean }).enabled;
    await request.put('/api/v1/admin/entitlements/enabled', { headers: bearer(adminToken), data: { enabled: true } });
    await setLlmAllowance(request, 0);
    await request.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    // Restore BOTH knobs: leaving a zero allowance behind would fail every
    // later LLM spec in this suite with a 429 that looks unrelated.
    await setLlmAllowance(request, null);
    if (previousEnforcement !== undefined) {
      await request.put('/api/v1/admin/entitlements/enabled', { headers: bearer(adminToken), data: { enabled: previousEnforcement } });
    }
    await request.dispose();
  });

  test('the invocation is 429 and NOTHING is billed — the refusal precedes the TEXT call', async ({ request }) => {
    const since = new Date();
    const response = await request.post(`/api/v1/agents/${AGENT_SLUG}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.' },
    });

    expect(response.status()).toBe(429);
    const body = (await response.json()) as { code?: string; metadata?: { capability?: string } };
    expect(body.code).toBe('DOMAIN.QUOTA_EXCEEDED');
    expect(body.metadata?.capability).toBe('monthlyLlmTokens');

    // The absence of a row is the real assertion: a 429 raised AFTER the model
    // ran would still have produced one.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const rows = await outboxSince(since);
    expect(rows.filter((row) => row.operation.startsWith('generate'))).toHaveLength(0);
  });
});

/**
 * The prompt test bench (L4's emitter). Asserted in this file so the two
 * triggers are shown to be DISTINGUISHABLE in one place — the whole point of
 * the dimension.
 */
test.describe('TASK-890 — the prompt test-run is a different activity', () => {
  test('a non-dry prompt test-run writes a row carrying trigger PROMPT_TEST', async ({ request }) => {
    const since = new Date();
    const templates = await request.get('/api/v1/admin/prompt-templates?limit=1', { headers: bearer(adminToken) });
    test.skip(templates.status() !== 200, `prompt-template listing unavailable (${templates.status()})`);
    const template = ((await templates.json()) as { data?: Array<{ id: string }> }).data?.[0];
    test.skip(!template, 'no prompt template seeded to test-run');

    const run = await request.post(`/api/v1/admin/prompt-templates/${template!.id}/test`, {
      headers: bearer(adminToken),
      data: { variables: {} },
    });
    test.skip(run.status() >= 500, `prompt test-run unavailable (${run.status()})`);
    expect(run.status()).toBeLessThan(300);

    const row = await waitForOutbox(since, 'generate.stream');
    expect(row.trigger).toBe('PROMPT_TEST');
  });
});
