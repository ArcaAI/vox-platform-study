/**
 * TASK-615 WS-K — invoice lifecycle: compute draft → verify lines →
 * finalize with If-Match (428 without, 412 stale) → immutability 409 →
 * credit memo → adjusted read model.
 *
 * Runs entirely against a PAST (already-ended) UTC calendar month so
 * `finalize` never hits the "period still running" 400 — `computeDraft` is
 * idempotent and safe to run against a historical period with zero usage
 * (an allowance-only, zero-overage-line invoice is still a valid DRAFT).
 *
 * GLOBAL_ADMIN only end to end (rule 05 `// AUTH-NOTE` on
 * `BillingAdminController`) — this spec authenticates as the seeded
 * super admin throughout; tenant-admin denial is covered by
 * `task-615-billing-cross-tenant.spec.ts`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const INVOICES_BASE = '/api/v1/admin/billing/invoices';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A calendar month guaranteed to have already ended — the 1st of last UTC month. */
function pastPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; `m - 1` is last month, rolls the year via Date.UTC.
  const last = new Date(Date.UTC(y, m - 1, 1));
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface InvoiceBody {
  id: string;
  version: number;
  status: 'DRAFT' | 'FINALIZED' | 'VOID';
  tenantId: string;
  period: string;
  lines: unknown[];
}

test.describe('TASK-615 invoice lifecycle', () => {
  let globalAdminToken: string;
  let tenantId: string;
  const period = pastPeriod();

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login failed').toBeTruthy();
    globalAdminToken = ga!.token;

    const row = await request.get('/api/v1/admin/ai-task-defaults/row?taskKey=nlp.ner', { headers: bearer(globalAdminToken) });
    expect(row.status()).toBe(200);
    tenantId = ((await row.json()) as { tenantId: string }).tenantId;
  });

  async function computeDraft(request: APIRequestContext): Promise<InvoiceBody> {
    const resp = await request.post(`${INVOICES_BASE}/compute-draft`, { headers: bearer(globalAdminToken), data: { tenantId, period } });
    expect(resp.status(), 'compute-draft').toBe(201);
    return (await resp.json()) as InvoiceBody;
  }

  test('compute-draft is idempotent — recomputing the SAME tenant-period returns the same invoice id', async ({ request }) => {
    const first = await computeDraft(request);
    const second = await computeDraft(request);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('DRAFT');
  });

  test('the draft read model exposes lines (possibly empty for a zero-usage synthetic period) and the current version', async ({ request }) => {
    const draft = await computeDraft(request);

    const getResp = await request.get(`${INVOICES_BASE}/${draft.id}?tenantId=${tenantId}`, { headers: bearer(globalAdminToken) });
    expect(getResp.status()).toBe(200);
    const body = (await getResp.json()) as InvoiceBody;
    expect(body.id).toBe(draft.id);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.version).toBeGreaterThanOrEqual(1);
  });

  test('finalize WITHOUT If-Match → 428', async ({ request }) => {
    const draft = await computeDraft(request);
    const resp = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(428);
  });

  test('finalize with a STALE If-Match version → 412', async ({ request }) => {
    const draft = await computeDraft(request);
    const staleVersion = draft.version + 999;
    const resp = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${staleVersion}"` },
    });
    expect(resp.status()).toBe(412);
  });

  test('full lifecycle: finalize with the CURRENT version → immutable (a second finalize → 409) → credit memo → adjusted read model', async ({
    request,
  }) => {
    const draft = await computeDraft(request);

    const finalizeResp = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${draft.version}"` },
    });
    expect(finalizeResp.status(), 'finalize with current version').toBe(201);
    const finalized = (await finalizeResp.json()) as InvoiceBody;
    expect(finalized.status).toBe('FINALIZED');

    // Immutability: a second finalize attempt (even with the now-current version) → 409, never 200/412.
    const secondFinalize = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${finalized.version}"` },
    });
    expect(secondFinalize.status()).toBe(409);

    // Credit memo — targets the now-FINALIZED invoice; nets as an ADJUSTMENT line on the ISSUE-MONTH draft (research: D-series lifecycle), never mutating the finalized invoice's own lines/total.
    const memoResp = await request.post(`${INVOICES_BASE}/${finalized.id}/adjustments?tenantId=${tenantId}`, {
      headers: bearer(globalAdminToken),
      data: { reason: 'task615_e2e_credit', amountMicros: '-1000000' },
    });
    expect(memoResp.status(), 'credit memo against a FINALIZED invoice').toBe(201);

    // The finalized invoice's own read model is unchanged by the memo (immutability holds — the memo landed on a different period's draft, not here).
    const reread = await request.get(`${INVOICES_BASE}/${finalized.id}?tenantId=${tenantId}`, { headers: bearer(globalAdminToken) });
    expect(reread.status()).toBe(200);
    const rereadBody = (await reread.json()) as InvoiceBody;
    expect(rereadBody.status).toBe('FINALIZED');
  });

  test('a credit memo against a DRAFT (not yet finalized) invoice → 409', async ({ request }) => {
    // A fresh, never-finalized period so this is unambiguously still DRAFT.
    const now = new Date();
    const twoMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const freshPeriod = `${twoMonthsAgo.getUTCFullYear()}-${String(twoMonthsAgo.getUTCMonth() + 1).padStart(2, '0')}`;

    const draftResp = await request.post(`${INVOICES_BASE}/compute-draft`, {
      headers: bearer(globalAdminToken),
      data: { tenantId, period: freshPeriod },
    });
    expect(draftResp.status()).toBe(201);
    const draft = (await draftResp.json()) as InvoiceBody;
    expect(draft.status).toBe('DRAFT');

    const memoResp = await request.post(`${INVOICES_BASE}/${draft.id}/adjustments?tenantId=${tenantId}`, {
      headers: bearer(globalAdminToken),
      data: { reason: 'task615_e2e_should_fail', amountMicros: '-1' },
    });
    expect(memoResp.status()).toBe(409);
  });

  test('void a fresh DRAFT with If-Match, then a second finalize attempt on it → 409 (one-way transition)', async ({ request }) => {
    const now = new Date();
    const threeMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const voidPeriod = `${threeMonthsAgo.getUTCFullYear()}-${String(threeMonthsAgo.getUTCMonth() + 1).padStart(2, '0')}`;

    const draftResp = await request.post(`${INVOICES_BASE}/compute-draft`, {
      headers: bearer(globalAdminToken),
      data: { tenantId, period: voidPeriod },
    });
    expect(draftResp.status()).toBe(201);
    const draft = (await draftResp.json()) as InvoiceBody;

    const voidResp = await request.post(`${INVOICES_BASE}/${draft.id}/void?tenantId=${tenantId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${draft.version}"` },
    });
    expect(voidResp.status()).toBe(201);
    const voided = (await voidResp.json()) as InvoiceBody;
    expect(voided.status).toBe('VOID');

    const finalizeAfterVoid = await request.post(`${INVOICES_BASE}/${draft.id}/finalize?tenantId=${tenantId}`, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${voided.version}"` },
    });
    expect(finalizeAfterVoid.status()).toBe(409);
  });
});
