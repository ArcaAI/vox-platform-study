/**
 * Invoice lifecycle: compute draft → verify lines →
 * finalize with If-Match (428 without, 412 stale) → immutability 409 →
 * credit memo → adjusted read model.
 *
 * Runs entirely against PAST (already-ended) UTC calendar months so
 * `finalize` never hits the "period still running" 400. A zero-usage
 * historical period is still a valid DRAFT (allowance-only, no overage line).
 *
 * REPEATABILITY (this spec must pass against a DIRTY, shared DB):
 * `POST compute-draft` is idempotent ONLY while the period's invoice is still
 * DRAFT — `BillingService.computeDraft` deliberately answers 409 once the
 * period is FINALIZED ("corrections to a closed period are credit memos") or
 * VOID ("a voided period stays void"). That is the contract, not a bug, so the
 * spec must not reuse a period it has already terminalised: every test that
 * finalises or voids CLAIMS ITS OWN previously-unused past month
 * (`claimFreshPeriod`), and `test.afterAll` hard-deletes exactly the invoices
 * THIS worker created (worker-local `createdInvoiceIds`, never a period/name
 * match — a sibling worker's rows must survive).
 *
 * SUPER_ADMIN only end to end (rule 05 `// AUTH-NOTE` on
 * `BillingAdminController`) — this spec authenticates as the seeded
 * super admin throughout; tenant-admin denial is covered by
 * `task-615-billing-cross-tenant.spec.ts`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const INVOICES_BASE = '/api/v1/admin/billing/invoices';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Calendar months that have already ENDED, most recent first. Most-recent-first
 * matters: the SELL price book has an `effectiveFrom` floor, and a period older
 * than it resolves no PLAN_FEE row — `computeDraft` fails closed with 409
 * there too, so walking backwards simply runs out of candidates instead of
 * silently billing 0.
 */
function endedPeriods(count = 24): string[] {
  const now = new Date();
  const periods: string[] = [];
  for (let back = 1; back <= count; back++) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    periods.push(`${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return periods;
}

interface InvoiceBody {
  id: string;
  version: number;
  status: 'DRAFT' | 'FINALIZED' | 'VOID';
  tenantId: string;
  period: string;
  lines: unknown[];
}

interface InvoiceSummary {
  id: string;
  period: string;
  status: string;
}

// ─── DB access (cleanup only — the API has no invoice-delete surface) ────────

interface BillingDb {
  billingInvoiceLine: { deleteMany(args: { where: { invoiceId: { in: string[] } } }): Promise<unknown> };
  billingAdjustment: { deleteMany(args: { where: { invoiceId: { in: string[] } } }): Promise<unknown> };
  billingInvoice: { deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown> };
}
let dbClient: BillingDb | null = null;
async function getDb(): Promise<BillingDb> {
  if (!dbClient) {
    // Same dist-import pattern as task-776-credential-classes.spec.ts.
    const distEntry = pathToFileURL(join(__dirname, '../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as BillingDb;
  }
  return dbClient;
}

// SERIAL: this file's `beforeAll` performs stateful billing writes (compute-draft,
// and in the lifecycle spec finalize/void) for a FIXED (tenant, period). Under
// `fullyParallel: true` Playwright spreads a file's tests across workers, so
// `beforeAll` runs concurrently in several of them and the second identical
// compute-draft collides with the first — 409, before any assertion runs.
// Serial mode pins the file to one worker so the setup happens exactly once.
test.describe.configure({ mode: 'serial' });

test.describe('Invoice lifecycle', () => {
  let superAdminToken: string;
  let tenantId: string;

  /**
   * Ids of the invoices THIS worker created, in creation order — the ONLY
   * rows `afterAll` is allowed to delete. Keyed on ids, never on period or a
   * name prefix: a file's tests can be spread across workers, `afterAll` fires
   * per worker, and a predicate-based delete would rip out rows a sibling
   * worker (or a previous run's audit trail) still depends on.
   */
  const createdInvoiceIds: string[] = [];
  /** Periods claimed in THIS run, so two tests never race for the same month. */
  const claimedPeriods = new Set<string>();

  /** The shared DRAFT used by every test that only READS or fails a precondition. */
  let sharedDraft: InvoiceBody;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'super admin login failed').toBeTruthy();
    superAdminToken = ga!.token;

    const row = await request.get('/api/v1/admin/ai-task-defaults/row?taskKey=nlp.ner', { headers: bearer(superAdminToken) });
    expect(row.status()).toBe(200);
    tenantId = ((await row.json()) as { tenantId: string }).tenantId;

    sharedDraft = await claimFreshPeriod(request);
    expect(sharedDraft.status).toBe('DRAFT');
  });

  test.afterAll(async () => {
    if (createdInvoiceIds.length === 0) return;
    const db = await getDb();
    // Children first — no ON DELETE CASCADE on either FK to BillingInvoice.
    await db.billingInvoiceLine.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await db.billingAdjustment.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await db.billingInvoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  });

  /**
   * Compute a draft for a past month that has NO invoice yet, and remember the
   * id for cleanup. Periods already carrying an invoice are skipped rather
   * than adopted: another run's DRAFT is not ours to finalise, void or delete.
   */
  async function claimFreshPeriod(request: APIRequestContext): Promise<InvoiceBody> {
    const listResp = await request.get(`${INVOICES_BASE}?tenantId=${tenantId}`, { headers: bearer(superAdminToken) });
    expect(listResp.status(), 'list invoices').toBe(200);
    const occupied = new Set(((await listResp.json()) as InvoiceSummary[]).map((invoice) => invoice.period));

    const skipped: string[] = [];
    for (const period of endedPeriods()) {
      if (occupied.has(period) || claimedPeriods.has(period)) {
        skipped.push(`${period}(existing)`);
        continue;
      }
      const resp = await request.post(`${INVOICES_BASE}/compute-draft`, { headers: bearer(superAdminToken), data: { tenantId, period } });
      if (resp.status() === 409) {
        // Raced, or older than the SELL card's effective floor — try the next.
        skipped.push(`${period}(409)`);
        continue;
      }
      expect(resp.status(), `compute-draft ${period} → ${await resp.text()}`).toBe(201);
      const invoice = (await resp.json()) as InvoiceBody;
      claimedPeriods.add(period);
      createdInvoiceIds.push(invoice.id);
      return invoice;
    }
    throw new Error(`no free past billing period for tenant ${tenantId}; tried: ${skipped.join(', ')}`);
  }

  /** Recompute a period this run already claimed (idempotent while DRAFT). */
  async function recompute(request: APIRequestContext, period: string): Promise<InvoiceBody> {
    const resp = await request.post(`${INVOICES_BASE}/compute-draft`, { headers: bearer(superAdminToken), data: { tenantId, period } });
    expect(resp.status(), `recompute ${period} → ${await resp.text()}`).toBe(201);
    return (await resp.json()) as InvoiceBody;
  }

  test('compute-draft is idempotent — recomputing the SAME tenant-period returns the same invoice id', async ({ request }) => {
    // WAS: two bare `computeDraft()` calls on a FIXED past month, both asserted
    // 201. That only held on a virgin DB — once a previous run FINALIZED that
    // month, the first call 409'd and the idempotency claim was never reached.
    // NOW: the period is claimed fresh for this run, so the first call CREATES
    // and the second RECOMPUTES — strictly more than before, because it proves
    // idempotency across the create→recompute boundary (the supersede path)
    // rather than across two identical recomputes of pre-existing state.
    const first = await claimFreshPeriod(request);
    const second = await recompute(request, first.period);
    expect(second.id).toBe(first.id);
    expect(second.period).toBe(first.period);
    expect(second.status).toBe('DRAFT');
  });

  test('the draft read model exposes lines (possibly empty for a zero-usage synthetic period) and the current version', async ({ request }) => {
    // WAS: `computeDraft()` on the shared fixed period. NOW: the DRAFT claimed
    // once in `beforeAll` — same read model, no dependence on that month being
    // uncomputed. Recompute first so the read is against freshly-superseded
    // lines exactly as before.
    const draft = await recompute(request, sharedDraft.period);

    const getResp = await request.get(`${INVOICES_BASE}/${draft.id}?tenantId=${tenantId}`, { headers: bearer(superAdminToken) });
    expect(getResp.status()).toBe(200);
    const body = (await getResp.json()) as InvoiceBody;
    expect(body.id).toBe(draft.id);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.version).toBeGreaterThanOrEqual(1);
  });

  test('finalize WITHOUT If-Match → 428', async ({ request }) => {
    // Reads the shared DRAFT; the request is refused before any state change,
    // so the period stays DRAFT and is reusable by the tests below.
    const resp = await request.post(`${INVOICES_BASE}/${sharedDraft.id}/finalize?tenantId=${tenantId}`, { headers: bearer(superAdminToken) });
    expect(resp.status()).toBe(428);
  });

  test('finalize with a STALE If-Match version → 412', async ({ request }) => {
    const draft = await recompute(request, sharedDraft.period);
    const staleVersion = draft.version + 999;
    const resp = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': `"${staleVersion}"` },
    });
    expect(resp.status()).toBe(412);
  });

  test('full lifecycle: finalize with the CURRENT version → immutable (a second finalize → 409) → credit memo → adjusted read model', async ({
    request,
  }) => {
    // Its OWN period: this test terminalises the invoice, so it can never
    // share a month with the DRAFT-preserving tests above (that coupling is
    // exactly what made the file pass only once per database).
    const draft = await claimFreshPeriod(request);

    const finalizeResp = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': `"${draft.version}"` },
    });
    expect(finalizeResp.status(), 'finalize with current version').toBe(201);
    const finalized = (await finalizeResp.json()) as InvoiceBody;
    expect(finalized.status).toBe('FINALIZED');

    // Immutability: a second finalize attempt (even with the now-current version) → 409, never 200/412.
    const secondFinalize = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': `"${finalized.version}"` },
    });
    expect(secondFinalize.status()).toBe(409);

    // Recomputing a CLOSED period is refused — the same 409 the idempotency
    // test relies on NOT hitting while the period is still DRAFT.
    const recomputeClosed = await request.post(`${INVOICES_BASE}/compute-draft`, {
      headers: bearer(superAdminToken),
      data: { tenantId, period: draft.period },
    });
    expect(recomputeClosed.status(), 'compute-draft on a FINALIZED period').toBe(409);

    // Credit memo — targets the now-FINALIZED invoice; nets as an ADJUSTMENT line on the ISSUE-MONTH draft (research: D-series lifecycle), never mutating the finalized invoice's own lines/total.
    const memoResp = await request.post(`${INVOICES_BASE}/${finalized.id}/adjustments?tenantId=${tenantId}`, {
      headers: bearer(superAdminToken),
      data: { reason: 'task615_e2e_credit', amountMicros: '-1000000' },
    });
    expect(memoResp.status(), 'credit memo against a FINALIZED invoice').toBe(201);

    // The finalized invoice's own read model is unchanged by the memo (immutability holds — the memo landed on a different period's draft, not here).
    const reread = await request.get(`${INVOICES_BASE}/${finalized.id}?tenantId=${tenantId}`, { headers: bearer(superAdminToken) });
    expect(reread.status()).toBe(200);
    const rereadBody = (await reread.json()) as InvoiceBody;
    expect(rereadBody.status).toBe('FINALIZED');
  });

  test('a credit memo against a DRAFT (not yet finalized) invoice → 409', async ({ request }) => {
    // WAS: computed a draft for a SECOND fixed month ("two months ago") purely
    // to be sure it was still DRAFT — which stopped being true as soon as an
    // earlier run had touched that month. NOW: the shared DRAFT, re-asserted to
    // be DRAFT at the point of use. The refusal changes no state, so the period
    // survives for the tests after it.
    const draft = await recompute(request, sharedDraft.period);
    expect(draft.status).toBe('DRAFT');

    const memoResp = await request.post(`${INVOICES_BASE}/${draft.id}/adjustments?tenantId=${tenantId}`, {
      headers: bearer(superAdminToken),
      data: { reason: 'task615_e2e_should_fail', amountMicros: '-1' },
    });
    expect(memoResp.status()).toBe(409);
  });

  test('void a fresh DRAFT with If-Match, then a second finalize attempt on it → 409 (one-way transition)', async ({ request }) => {
    // Its OWN period for the same reason as the lifecycle test: voiding is
    // terminal, and a voided month can never be recomputed.
    const draft = await claimFreshPeriod(request);

    const voidResp = await request.post(`${INVOICES_BASE}/${draft.id}/void?tenantId=${tenantId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': `"${draft.version}"` },
    });
    expect(voidResp.status()).toBe(201);
    const voided = (await voidResp.json()) as InvoiceBody;
    expect(voided.status).toBe('VOID');

    const finalizeAfterVoid = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': `"${voided.version}"` },
    });
    expect(finalizeAfterVoid.status()).toBe(409);
  });
});
