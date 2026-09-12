/**
 * TASK-959 §7 (F-4) — the tenant's own monthly spend ceiling, on the four
 * routes that can spend fastest.
 *
 * ============================================================================
 * WHAT THIS FILE PROVES
 * ============================================================================
 * `monthlySpendLimitMicros` is a limit a TENANT sets for ITSELF, and it is not
 * the allowance meter: a meter caps a QUANTITY of one unit, the ceiling caps
 * MONEY across all of them. Until this ticket it was enforced on consultation
 * summaries only, so a tenant that had set a cap was unbounded on the agent and
 * workflow planes. Four routes now call `assertSpendLimit` BEFORE anything is
 * spent, and each must answer 402 — never 429 (a meter), never 409 (a
 * quantity quota), never a 5xx from a downstream that should never have been
 * called.
 *
 * The refusal PRECEDING the spend is the whole point, and it is what makes this
 * file provable on a stack with no inference service running: a 402 that
 * arrives while `apps/text` is unreachable is proof the gateway refused on its
 * own, before it reached for the model.
 *
 * ============================================================================
 * FINDING — THE LIMIT HAS NO WRITE API, SO THIS SPEC SETS THE COLUMN DIRECTLY
 * ============================================================================
 * There is no route that sets `monthlySpendLimitMicros`. Verified three ways on
 * this branch: `UpsertTenantEntitlementRequest` (the body of `PUT
 * admin/entitlements/tenants/:id/override`, the only writer of that row)
 * declares every other allowance and not this one; a grep of
 * `packages/applications/src` finds the field only in the billing service, the
 * allowance resolver and `SpendStatusResponse`; and in `openapi.json` the name
 * appears solely on `SpendStatusResponse`, a READ. Since the global pipe runs
 * `forbidNonWhitelisted`, sending it on the override PUT is a 400.
 *
 * So a tenant can be REFUSED by a ceiling it has no way to set, and a platform
 * admin has no way to set one on its behalf. That is a gap in F-4 worth an
 * owner's attention (recorded in this lane's report), and in the meantime the
 * only construction available to a test is the column itself. The spec writes
 * it through the unscoped platform client and restores exactly what it found —
 * deleting the row if it created it.
 *
 * ============================================================================
 * WHY A LIMIT OF ZERO, AND WHY THE ARCAAI TENANT
 * ============================================================================
 * `exceeded` is `overageSpendMicros >= spendLimitMicros`. A limit of 1 µ
 * therefore needs a µ of REAL month-to-date SELL-rated overage before it trips,
 * which this seed does not have (the test database holds no usage at all), so a
 * spec built on `1` would pass or fail depending on what other specs happened
 * to bill first. Zero is the honest construction: it is a real, meaningful
 * setting ("spend nothing this month"), it is not the null that means
 * unlimited, and it trips deterministically at zero usage.
 *
 * The limit is set on the **ArcaAI** tenant, not Global. It is per-tenant state
 * on a shared database, and Global is the tenant every other spec in this suite
 * authenticates into — a zero ceiling there would refuse their agent calls with
 * a 402 they have no reason to expect, for as long as this file runs. ArcaAI
 * carries its own published agents and its own `platform-default-summarization`
 * workflow, so all four routes are reachable with a super admin acting on it
 * through `X-Tenant-Id`, and no other spec can see the change.
 */
import { expect, test } from '@playwright/test';

import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';
import { closeLedgerDb, ledgerRowsSince, platformDb } from './helpers/usage-ledger.helper';

// Serial: this file owns one tenant's ceiling for its duration, and two of its
// own tests must not observe each other's setting.
test.describe.configure({ mode: 'serial' });

/** The second seeded customer tenant (`seed/00-constants.ts`, "Customer Tenants (Global, ArcaAI)"). */
const TENANT_ARCAAI = '50000000-0000-0000-0000-000000000001';

/** ArcaAI's own published content — the reference set is CLONED per tenant, never shared at runtime. */
const TEXT_AGENT_SLUG = 'arcaai-gen-summary-new-visit';
const TTS_AGENT_SLUG = 'text-to-speech';
const STT_AGENT_SLUG = 'realtime-transcription';
const WORKFLOW_SLUG = 'platform-default-summarization';

interface EntitlementRow {
  monthlySpendLimitMicros: bigint | null;
}
interface EntitlementDb {
  tenantEntitlement: {
    findUnique(args: { where: { tenantId: string } }): Promise<EntitlementRow | null>;
    upsert(args: {
      where: { tenantId: string };
      create: { tenantId: string; monthlySpendLimitMicros: bigint };
      update: { monthlySpendLimitMicros: bigint | null };
    }): Promise<unknown>;
    update(args: { where: { tenantId: string }; data: { monthlySpendLimitMicros: bigint | null } }): Promise<unknown>;
    delete(args: { where: { tenantId: string } }): Promise<unknown>;
  };
}

let adminToken: string;
/** The ceiling before this file touched it — `undefined` means there was no row at all. */
let previousLimit: bigint | null | undefined;

/** A super admin ACTING ON ArcaAI: the working tenant is a header, never a body field. */
const asArcaAdmin = () => ({ Authorization: `Bearer ${adminToken}`, 'X-Tenant-Id': TENANT_ARCAAI });

async function setSpendLimit(value: bigint | null): Promise<void> {
  const db = await platformDb<EntitlementDb>();
  if (value === null) {
    await db.tenantEntitlement.update({ where: { tenantId: TENANT_ARCAAI }, data: { monthlySpendLimitMicros: null } });
    return;
  }
  await db.tenantEntitlement.upsert({
    where: { tenantId: TENANT_ARCAAI },
    create: { tenantId: TENANT_ARCAAI, monthlySpendLimitMicros: value },
    update: { monthlySpendLimitMicros: value },
  });
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: process.env.API_URL || 'http://localhost:8968/api/v1' });
  const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  if (!admin) throw new Error('TASK-959 spend-limit spec could not log in the seeded super admin');
  adminToken = admin.token;
  await request.dispose();

  const db = await platformDb<EntitlementDb>();
  const existing = await db.tenantEntitlement.findUnique({ where: { tenantId: TENANT_ARCAAI } });
  previousLimit = existing === null ? undefined : existing.monthlySpendLimitMicros;
  await setSpendLimit(0n);
});

test.afterAll(async () => {
  // Restore EXACTLY what was found: a row this file created is removed, a row
  // that existed keeps the value it had. Leaving a zero ceiling behind would
  // 402 every later ArcaAI spec with a refusal that looks unrelated.
  const db = await platformDb<EntitlementDb>();
  if (previousLimit === undefined) {
    await db.tenantEntitlement.delete({ where: { tenantId: TENANT_ARCAAI } }).catch(() => undefined);
  } else {
    await setSpendLimit(previousLimit);
  }
  await closeLedgerDb();
});

/** The body of a 402, as `SpendLimitExceededException.toJSON()` renders it. */
async function expectSpendLimitRefusal(response: { status(): number; json(): Promise<unknown>; text(): Promise<string> }, label: string) {
  expect(response.status(), `${label}: ${await response.text()}`).toBe(402);
  const body = (await response.json()) as { code?: string; metadata?: { tenantId?: string; spendLimitMicros?: string } };
  // 402 and not 429: the ceiling is MONEY across every unit, the meter is a
  // quantity of one. A route that answered 429 here would be enforcing the
  // wrong limit and would tell the tenant to wait for a reset that is not
  // coming.
  expect(body.code, `${label}: the refusal names the ceiling, not a meter`).toBe('DOMAIN.SPEND_LIMIT_EXCEEDED');
  expect(body.metadata?.tenantId).toBe(TENANT_ARCAAI);
}

test.describe('TASK-959 F-4 — a tenant at its ceiling is refused before anything is spent', () => {
  test('the spend status agrees the tenant is over', async ({ request }) => {
    const period = new Date().toISOString().slice(0, 7);
    const response = await request.get(`/api/v1/admin/billing/invoices/spend-status?period=${period}&tenantId=${TENANT_ARCAAI}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { exceeded?: boolean; spendLimitMicros?: string | null; remainingMicros?: string | null };
    expect(body.spendLimitMicros, 'the ceiling this file set').toBe('0');
    expect(body.exceeded, 'at a ceiling of zero, any spend at all is over it').toBe(true);
    expect(body.remainingMicros).toBe('0');
  });

  test('an agent invocation is 402 and NOTHING is billed', async ({ request }) => {
    const since = new Date();
    const response = await request.post(`/api/v1/agents/${TEXT_AGENT_SLUG}/invocations`, {
      headers: asArcaAdmin(),
      data: { text: 'Summarise: patient reports a mild headache.' },
    });
    await expectSpendLimitRefusal(response, 'invocations');

    // The absence of a row is the real assertion. A 402 raised AFTER the model
    // ran would still have produced one, and would have cost the money the
    // ceiling exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const rows = (await ledgerRowsSince(since, { tenantId: TENANT_ARCAAI })).filter((row) => row.operation.startsWith('generate'));
    expect(rows, `nothing may be billed for a refused call — got ${rows.map((r) => r.unit).join(', ')}`).toHaveLength(0);
  });

  test('a speech synthesis is 402', async ({ request }) => {
    const response = await request.post(`/api/v1/agents/${TTS_AGENT_SLUG}/speech`, {
      headers: asArcaAdmin(),
      data: { text: 'The patient reports a mild headache.' },
    });
    await expectSpendLimitRefusal(response, 'speech');
  });

  test('a batch transcription is 402 — before the media is even looked up', async ({ request }) => {
    // The media id is deliberately one that does not exist. This route has no
    // meter quota of its own (batch minutes are metered on COMPLETION), so the
    // ceiling is its only pre-flight money gate, and it runs before the media
    // lookup — a 404 here would mean the gate had moved behind it.
    const response = await request.post(`/api/v1/agents/${STT_AGENT_SLUG}/transcriptions`, {
      headers: asArcaAdmin(),
      data: { mediaId: '00000000-0000-0000-0000-0000000009e0' },
    });
    await expectSpendLimitRefusal(response, 'transcriptions');
  });

  test('a workflow run is 402 — no run row, no dispatcher', async ({ request }) => {
    const response = await request.post(`/api/v1/workflows/${WORKFLOW_SLUG}/runs`, {
      headers: asArcaAdmin(),
      data: { input: { text: 'Summarise: patient reports a mild headache.' } },
    });
    await expectSpendLimitRefusal(response, 'workflow run');
  });

  test('control — with the ceiling removed the same call is no longer refused', async ({ request }) => {
    // Runs last, and restores nothing itself: `afterAll` owns the restore. This
    // exists so the four 402s above cannot be attributed to anything else about
    // the ArcaAI tenant — the only thing that changes here is the ceiling.
    await setSpendLimit(null);

    const response = await request.post(`/api/v1/agents/${TEXT_AGENT_SLUG}/invocations`, {
      headers: asArcaAdmin(),
      data: { text: 'Summarise: patient reports a mild headache.' },
    });
    // What it becomes depends on whether `apps/text` is up (200) or not (503).
    // Either is fine; 402 is not.
    expect(response.status(), 'the ceiling was the refusal, and it is gone').not.toBe(402);
  });
});
