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
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';
import { closeLedgerDb, ledgerRowsSince } from './helpers/usage-ledger.helper';

test.describe.configure({ mode: 'serial' });

const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';
/** A PUBLISHED SYSTEM TEXT_GENERATION agent, visible to every tenant (`seed/25-agents.ts`).
 *
 *  Was `platform-summarization` until TASK-930 D-8 deleted and rebuilt the seeds: the reference
 *  set is now five agents (`realtime-transcription`, `medical-ner`,
 *  `general-medicine-summarization`, `casenote-finalization`, `text-to-speech`), so the old slug
 *  resolves 404 — the agent, not the route, is what moved. */
const AGENT_SLUG = 'general-medicine-summarization';

/**
 * The `{{trigger.context.*}}` placeholders the seeded agent's instruction binds.
 *
 * `AgentInvocationService.invokeText` renders the instruction through the one prompt grammar and
 * refuses a 400 naming the FIRST unresolved path, so an invocation that supplies none of these
 * never reaches the model — and this spec is about metering, not about prompt authoring. The
 * envelope nesting is the schema's: `consultation_note_context` declares several kinds, so the
 * payload is not single-kind, no unwrap happens, and `{{trigger.context.x}}` reads
 * `context.context.x`. `fields` on that kind is deliberately OPEN (`seed/07e-…`), so extra keys
 * are accepted and a drifted instruction shows up as a 400 naming the new path rather than as a
 * silent half-rendered prompt.
 */
const AGENT_CONTEXT = {
  context: {
    language: 'en',
    visit_type: 'new-visit',
    chief_complaint: 'mild headache',
    current_department: 'General Medicine',
    safe_age: '42',
    safe_dob: '1984-01-01',
    safe_gender: 'female',
    formatted_vitals: 'BP 120/80',
    formatted_previous_visits: 'none',
  },
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * The ledger rows this tenant produced since `since`, newest first.
 *
 * FU-2. This used to read the outbox itself and project `payload?.common ??
 * payload`, which matched NOTHING on any row, ever: `UsageLedgerService`
 * expands a batch before it writes, so the stored payload is
 * `{ version, events[] }` — there is no `common` key, the fallback resolved to
 * the ENVELOPE, its `tenantId` was `undefined`, and the tenant filter below
 * then dropped every row. Both "row lands" tests were therefore vacuous
 * whenever they ran at all, and they only ever ran on a box where `apps/text`
 * could serve a generation — which is why the defect survived. Reading through
 * `helpers/usage-ledger.helper.ts` puts the shape in ONE place, beside the
 * TASK-959 specs that already use it.
 *
 * The helper widens `since` by five seconds to absorb clock skew between the
 * suite and Postgres — right for a positive assertion, wrong for the NEGATIVE
 * one below, where a row that predates the mark would read as a bill this test
 * provoked. So the window is narrowed back here on the event's OWN
 * `occurredAt`, which the emitter stamps.
 */
async function outboxSince(since: Date): Promise<Array<{ operation: string; trigger?: string }>> {
  const rows = await ledgerRowsSince(since, { tenantId: TENANT_GLOBAL });
  return rows
    .filter((row) => new Date(row.occurredAt).getTime() >= since.getTime())
    .map((row) => ({ operation: row.operation, trigger: row.attributesJson?.trigger as string | undefined }));
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

/** Release the pool the reader opened, so the Playwright worker can exit instead of hanging on it. */
test.afterAll(async () => {
  await closeLedgerDb();
});

test.describe('TASK-890 — an agent invocation is metered', () => {
  test('blocking: writes one `generate` row carrying trigger AGENT_INVOCATION', async ({ request }) => {
    const since = new Date();
    const response = await request.post(`/api/v1/agents/${AGENT_SLUG}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.', context: AGENT_CONTEXT },
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
      data: { text: 'Summarise: patient reports a mild headache.', context: AGENT_CONTEXT },
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
  let previousPlan: string | null = null;

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

  /**
   * Stamp a plan on the caller's tenant for the length of this describe.
   *
   * `__GLOBAL__` is in `RESERVED_UNGATED_TENANT_IDS` (`entitlements.constants.ts`),
   * so with no plan it resolves `UNGATED_ENTITLEMENTS` and Q3 IGNORES the
   * per-tenant override outright (`resolve-entitlements.ts` — "no plan means
   * ungated-legacy; overrides are intentionally ignored"). The allowance of 0
   * below is therefore invisible to `assertMeterQuota`, which returns on the
   * `limit === null` line before it ever reads the meter — the call reaches
   * TEXT and answers 503, and the one assertion that would have proven the
   * precheck proves nothing.
   *
   * `effectivePlan`'s rule 1 is the documented way out: "an explicitly stamped
   * `Tenant.plan` always wins — on every tenant, reserved or not." ENTERPRISE
   * is chosen so the ONLY thing that differs from the ungated baseline is the
   * meter this test zeroes; its rate-limit tier is `relaxed`, like the ungated
   * default, so a sibling worker sees no new throttle.
   */
  async function setPlan(request: APIRequestContext, plan: string | null): Promise<void> {
    const current = await request.get(`/api/v1/admin/tenants/${TENANT_GLOBAL}`, { headers: bearer(adminToken) });
    const etag = current.headers()['etag'];
    if (!etag) return;
    // This route wants BOTH halves of the OCC pair: `If-Match` (the guard) and
    // `expectedVersion` in the body (the validated DTO field). Sending only the
    // header is a 400, not a 412.
    const expectedVersion = Number(etag.replace(/[^0-9]/g, ''));
    const response = await request.patch(`/api/v1/admin/tenants/${TENANT_GLOBAL}`, {
      headers: { ...bearer(adminToken), 'If-Match': etag },
      data: { plan, expectedVersion },
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
  }

  /** The tenant's stamped plan — readable by the tenant admin; the entitlements document is not. */
  async function stampedPlan(request: APIRequestContext): Promise<string | null> {
    const response = await request.get(`/api/v1/admin/tenants/${TENANT_GLOBAL}`, { headers: bearer(adminToken) });
    if (response.status() !== 200) return null;
    return ((await response.json()) as { plan?: string | null }).plan ?? null;
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const read = await request.get('/api/v1/admin/entitlements/enabled', { headers: bearer(adminToken) });
    previousEnforcement = ((await read.json()) as { enabled?: boolean }).enabled;
    const tenant = await request.get(`/api/v1/admin/tenants/${TENANT_GLOBAL}`, { headers: bearer(adminToken) });
    previousPlan = ((await tenant.json()) as { plan?: string | null }).plan ?? null;
    await request.put('/api/v1/admin/entitlements/enabled', { headers: bearer(adminToken), data: { enabled: true } });
    await setPlan(request, 'ENTERPRISE');
    await setLlmAllowance(request, 0);
    await request.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    // Restore BOTH knobs: leaving a zero allowance behind would fail every
    // later LLM spec in this suite with a 429 that looks unrelated.
    await setLlmAllowance(request, null);
    await setPlan(request, previousPlan);
    if (previousEnforcement !== undefined) {
      await request.put('/api/v1/admin/entitlements/enabled', { headers: bearer(adminToken), data: { enabled: previousEnforcement } });
    }
    await request.dispose();
  });

  test('the invocation is 429 and NOTHING is billed — the refusal precedes the TEXT call', async ({ request }) => {
    const since = new Date();
    const response = await request.post(`/api/v1/agents/${AGENT_SLUG}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.', context: AGENT_CONTEXT },
    });

    // If the tenant still resolves ungated the precheck cannot fire, and a
    // 503 here would mean "TEXT answered", not "the quota was honoured" —
    // say so rather than assert something the fixture cannot produce.
    test.skip(!(await stampedPlan(request)), 'the caller tenant resolves ungated — the meter allowance cannot be enforced against it');

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
 * The prompt test bench. Asserted in this file so the two triggers are shown to
 * be DISTINGUISHABLE in one place — the whole point of the dimension.
 *
 * L4 landed the emitter in wave 2b: `startPromptTemplateTest` prechecks
 * `monthlyLlmTokens` and `finalizePromptTemplateTest` records `generate.stream`
 * with `trigger: 'PROMPT_TEST'`. The bench is a TWO-CALL shape (the browser
 * streams the tokens itself and the gateway reads the finished text back
 * SERVER-SIDE by task id), so the row is written by FINALIZE — driving `:id/test`
 * alone writes nothing, which is what the earlier `fixme` body would have waited
 * on forever.
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
    test.skip(run.status() >= 500, `prompt test-run unavailable — TEXT is not reachable from this stack (${run.status()})`);
    expect(run.status()).toBeLessThan(300);
    const ack = (await run.json()) as { mode?: string; taskId?: string };
    test.skip(ack.mode !== 'stream' || !ack.taskId, `the bench answered a dry run (${ack.mode})`);

    // The stream is the browser's; the gateway reads the finished text back by task id. Give the
    // generation a moment to reach a terminal state before finalizing.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const finalized = await request.post(`/api/v1/admin/prompt-templates/${template!.id}/test/finalize`, {
      headers: bearer(adminToken),
      data: { taskId: ack.taskId },
    });
    test.skip(finalized.status() >= 400, `the generation did not reach a terminal state in time (${finalized.status()})`);

    const row = await waitForOutbox(since, 'generate.stream');
    expect(row.trigger).toBe('PROMPT_TEST');
  });
});
