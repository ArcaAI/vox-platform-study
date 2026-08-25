/**
 * TASK-712 — Consent & ABAC: end-to-end proof that enforcement is ON BY
 * DEFAULT over real HTTP against the live gateway + seeded/backfilled test
 * database.
 *
 * Requires the test API at `process.env.API_URL` (default
 * `http://localhost:8968/api/v1`) and a live test database with the
 * `ConsentGrant` partial-unique-active index and the legacy-grant backfill
 * already applied (`.claude/rules/02-database-prisma.md` §Migration
 * Workflow — on a db-push-managed database, the migration's DML step is
 * applied by hand; see the migration file's header).
 *
 * Follows `apps/api/tests/e2e/task-709-note-occ.spec.ts` for the
 * open-consultation + If-Match OCC shapes.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface ConsultationBody {
  id: string;
}

interface ConsentGrantBody {
  id: string;
  version: number;
  purpose: string;
}

test.describe('TASK-712 — consent enforcement is ON by default', () => {
  let token: string;
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(login, 'tenant_admin login failed').toBeTruthy();
    token = login!.token;

    // Only needed for the legacy-backfill case below, which deliberately
    // reads a PRE-EXISTING seeded patient (09-consultation.ts) rather than
    // one this spec creates. `verifyPatientAccess` (pre-existing,
    // independent of consent) requires a doctor-patient relationship, and
    // the seeded PAT-20250101-001 consultations belong to `doctor`, not
    // `tenant_admin` — a business rule this ticket does not touch.
    const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctorLogin, 'doctor login failed').toBeTruthy();
    doctorToken = doctorLogin!.token;
  });

  async function openConsultation(request: import('@playwright/test').APIRequestContext, patientId: string): Promise<string> {
    const opened = await request.post('/api/v1/consultations/open', { headers: bearer(token), data: { patientId } });
    expect([200, 201], 'POST /consultations/open').toContain(opened.status());
    return ((await opened.json()) as ConsultationBody).id;
  }

  async function grant(
    request: import('@playwright/test').APIRequestContext,
    externalPatientId: string,
    purpose: string,
    extra: Record<string, unknown> = {},
  ) {
    const res = await request.post('/api/v1/admin/consent-grants', {
      headers: bearer(token),
      data: { externalPatientId, purpose, grantMethod: 'VERBAL_ATTESTED', ...extra },
    });
    return res;
  }

  /** The ACTIVE grant for a (patient, purpose), from the register. */
  async function activeGrant(
    request: import('@playwright/test').APIRequestContext,
    externalPatientId: string,
    purpose: string,
  ): Promise<ConsentGrantBody> {
    const res = await request.get(`/api/v1/admin/consent-grants?externalPatientId=${externalPatientId}&purpose=${purpose}&state=ACTIVE`, {
      headers: bearer(token),
    });
    expect(res.status()).toBe(200);
    const page = (await res.json()) as { data: ConsentGrantBody[] };
    expect(page.data.length, `expected an ACTIVE ${purpose} grant for ${externalPatientId}`).toBe(1);
    return page.data[0];
  }

  /** Withdraw the auto-granted consent for one purpose (If-Match OCC). */
  async function revokeActive(request: import('@playwright/test').APIRequestContext, externalPatientId: string, purpose: string) {
    const row = await activeGrant(request, externalPatientId, purpose);
    const res = await request.patch(`/api/v1/admin/consent-grants/${row.id}/revoke`, {
      headers: { ...bearer(token), 'If-Match': `"${row.version}"` },
      data: { expectedVersion: row.version, reason: 'e2e' },
    });
    expect(res.status(), 'revoke').toBe(200);
  }

  // ─── TASK-805 owner directive (2026-08-25): opening a consultation IS the
  // doctor's consent event. These four tests are the directive itself. ───

  test('opening a consultation grants EVERY purpose, attributed to the opening clinician', async ({ request }) => {
    const patientId = `task-805-open-${Date.now()}`;
    await openConsultation(request, patientId);

    const res = await request.get(`/api/v1/admin/consent-grants?externalPatientId=${patientId}&state=ACTIVE&limit=50`, { headers: bearer(token) });
    expect(res.status()).toBe(200);
    const page = (await res.json()) as { data: ConsentGrantBody[]; count: number };

    const purposes = page.data.map((g) => g.purpose).sort();
    expect(purposes).toEqual(['AI_DOCUMENTATION', 'EXTERNAL_TOOL_LOOKUP', 'HISTORY_RETRIEVAL', 'QUALITY_REVIEW', 'STYLE_LEARNING']);
    // Attributable to a HUMAN — the whole reason this does not violate D-3.
    for (const g of page.data) {
      expect(g.grantedBy, 'every grant must name the clinician who opened the consultation').toBeTruthy();
    }
  });

  test('recording/start succeeds straight after open — no manual grant, no admin ability needed', async ({ request }) => {
    const patientId = `task-805-record-${Date.now()}`;
    const consultationId = await openConsultation(request, patientId);

    const res = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: bearer(token), data: {} });
    expect([200, 201], 'recording/start immediately after open').toContain(res.status());
  });

  test('patient history is readable straight after open (HISTORY_RETRIEVAL auto-granted)', async ({ request }) => {
    const patientId = `task-805-history-${Date.now()}`;
    await openConsultation(request, patientId);

    const res = await request.get(`/api/v1/consultations/patient/${patientId}/history`, { headers: bearer(token) });
    expect(res.status()).toBe(200);
  });

  test('re-opening the SAME consultation does not duplicate grants (get-or-create branch)', async ({ request }) => {
    const patientId = `task-805-idem-${Date.now()}`;
    await openConsultation(request, patientId);
    await openConsultation(request, patientId);

    const res = await request.get(`/api/v1/admin/consent-grants?externalPatientId=${patientId}&state=ACTIVE&limit=50`, { headers: bearer(token) });
    const page = (await res.json()) as { data: ConsentGrantBody[] };
    // Exactly one ACTIVE row per purpose — the DB's partial unique index would
    // reject a second, so a duplicate would surface as a 500 on the open above.
    expect(page.data).toHaveLength(5);
  });

  // ─── The gate still denies. These prove enforcement survived the directive. ───

  test('a patient never seen in a consultation is denied with no_grant', async ({ request }) => {
    // The only remaining route to `no_grant`: the guard resolves the patient
    // from the ROUTE param, so a patient with no consultation has no
    // auto-granted consent. Consent is evaluated in a guard, i.e. before the
    // handler's own patient-relationship check.
    const patientId = `task-805-unseen-${Date.now()}`;

    const res = await request.get(`/api/v1/consultations/patient/${patientId}/history`, { headers: bearer(token) });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('DOMAIN.CONSENT_DENIED');
    expect(body.metadata?.reason).toBe('no_grant');
  });

  test('revoking the auto-granted AI_DOCUMENTATION blocks recording on that consultation', async ({ request }) => {
    const patientId = `task-805-revoked-${Date.now()}`;
    const consultationId = await openConsultation(request, patientId);

    await revokeActive(request, patientId, 'AI_DOCUMENTATION');

    const res = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: bearer(token), data: {} });
    expect(res.status()).toBe(403);
    expect((await res.json()).metadata?.reason).toBe('revoked');
  });

  test('an EXPIRED grant denies (INV-342 time-limit)', async ({ request }) => {
    const patientId = `task-712-expired-${Date.now()}`;
    const consultationId = await openConsultation(request, patientId);

    // Withdraw the auto-granted row first — the partial unique index allows
    // only one ACTIVE grant per (tenant, patient, purpose).
    await revokeActive(request, patientId, 'AI_DOCUMENTATION');
    const granted = await grant(request, patientId, 'AI_DOCUMENTATION', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect([200, 201], 'POST /admin/consent-grants (expired)').toContain(granted.status());

    const res = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: bearer(token), data: {} });
    expect(res.status()).toBe(403);
    expect((await res.json()).metadata?.reason).toBe('expired');
  });

  test('revocation blocks the NEXT gated call — mid-session semantics (INV-010/340/438)', async ({ request }) => {
    const patientId = `task-712-revoke-${Date.now()}`;
    const consultationId = await openConsultation(request, patientId);

    // Auto-granted at open, so calls succeed immediately.
    const before = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: bearer(token), data: {} });
    expect([200, 201], 'recording/start while grant is active').toContain(before.status());

    await revokeActive(request, patientId, 'AI_DOCUMENTATION');

    // The next gated call ON THE SAME CONSULTATION is denied.
    //
    // TASK-805 changed what this test can assert. It used to open a SECOND
    // consultation to prove the denial; under the owner directive that open
    // would itself be a fresh consent event and re-grant. That is deliberate —
    // a revocation bounds the CURRENT consultation, and does not outlive the
    // clinician opening the next one with the patient present.
    const after = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: bearer(token), data: {} });
    expect(after.status(), 'recording/start after revoke').toBe(403);
    expect((await after.json()).metadata?.reason).toBe('revoked');
  });

  test('admin revoke without If-Match → 428; with a stale If-Match → 412', async ({ request }) => {
    const patientId = `task-712-occ-${Date.now()}`;
    const granted = await grant(request, patientId, 'QUALITY_REVIEW');
    expect([200, 201]).toContain(granted.status());
    const grantBody = (await granted.json()) as ConsentGrantBody;

    const noHeader = await request.patch(`/api/v1/admin/consent-grants/${grantBody.id}/revoke`, {
      headers: bearer(token),
      data: { expectedVersion: grantBody.version },
    });
    expect(noHeader.status()).toBe(428);

    const stale = await request.patch(`/api/v1/admin/consent-grants/${grantBody.id}/revoke`, {
      headers: { ...bearer(token), 'If-Match': '"999"' },
      data: { expectedVersion: 999 },
    });
    expect(stale.status()).toBe(412);
  });

  // ─── TASK-805: the consent REGISTER ───
  //
  // `GET /admin/consent-grants` was a per-patient lookup returning a bare
  // array. It is now the governance surface: tenant-wide, paginated, and
  // filterable — which is what makes an admin able to AUDIT consent rather
  // than only confirm a patient id they already knew.
  test.describe('TASK-805 — the consent register', () => {
    interface RegisterPage {
      data: ConsentGrantBody[];
      count: number;
      page: number;
      limit: number;
    }

    async function register(request: import('@playwright/test').APIRequestContext, query = ''): Promise<RegisterPage> {
      const res = await request.get(`/api/v1/admin/consent-grants${query}`, { headers: bearer(token) });
      expect(res.status(), `GET /admin/consent-grants${query}`).toBe(200);
      return (await res.json()) as RegisterPage;
    }

    test('lists tenant-wide with NO patient filter — the read the old contract could not express', async ({ request }) => {
      const page = await register(request);

      expect(Array.isArray(page.data), 'paginated envelope, not a bare array').toBe(true);
      // The seed ships grants for the demo patients, so a tenant-wide read
      // must return rows without anyone naming a patient first.
      expect(page.count).toBeGreaterThan(0);
      expect(page.data.length).toBeGreaterThan(0);
      // More than one distinct patient proves this is not silently
      // patient-scoped.
      const patients = new Set(page.data.map((row) => (row as unknown as { externalPatientId: string }).externalPatientId));
      expect(patients.size).toBeGreaterThan(1);
    });

    test('paginates — page 2 returns different rows and echoes the requested limit', async ({ request }) => {
      // Scoped to a patient this test alone creates. An UNSCOPED offset window
      // is not a stable thing to assert on here: every parallel spec that opens
      // a consultation now inserts five grants (TASK-805 auto-grant), so rows
      // shift between the page-1 and page-2 reads and a repeat proves nothing
      // about ordering. Five grants at limit 2 gives three deterministic pages.
      const patientId = `task-805-page-${Date.now()}`;
      await openConsultation(request, patientId);

      const first = await register(request, `?externalPatientId=${patientId}&state=ALL&page=1&limit=2`);
      expect(first.limit, 'the envelope echoes the EFFECTIVE limit (TASK-776 F-02)').toBe(2);
      expect(first.count).toBe(5);
      expect(first.data).toHaveLength(2);

      const second = await register(request, `?externalPatientId=${patientId}&state=ALL&page=2&limit=2`);
      const firstIds = first.data.map((row) => row.id);
      expect(
        second.data.every((row) => !firstIds.includes(row.id)),
        'page 2 must not repeat page 1',
      ).toBe(true);

      // Walking every page yields each row exactly once — what the `id`
      // tiebreaker in `stableSort` actually guarantees. Without it these five
      // rows share one `grantedAt` and Postgres may reorder them per query.
      const third = await register(request, `?externalPatientId=${patientId}&state=ALL&page=3&limit=2`);
      const allIds = [...first.data, ...second.data, ...third.data].map((row) => row.id);
      expect(new Set(allIds).size, 'every grant appears exactly once across the pages').toBe(5);
    });

    test('filters by purpose', async ({ request }) => {
      const page = await register(request, '?purpose=AI_DOCUMENTATION&limit=50');
      expect(page.data.length).toBeGreaterThan(0);
      expect(page.data.every((row) => row.purpose === 'AI_DOCUMENTATION')).toBe(true);
    });

    test('state=ACTIVE hides a revoked grant, state=REVOKED shows only it', async ({ request }) => {
      const patientId = `PAT-REGISTER-${Date.now()}`;
      const created = await grant(request, patientId, 'QUALITY_REVIEW');
      expect([200, 201]).toContain(created.status());
      const row = (await created.json()) as ConsentGrantBody;

      // Present as ACTIVE before revocation.
      const before = await register(request, `?externalPatientId=${patientId}&state=ACTIVE`);
      expect(before.data.map((g) => g.id)).toContain(row.id);

      const revoked = await request.patch(`/api/v1/admin/consent-grants/${row.id}/revoke`, {
        headers: { ...bearer(token), 'If-Match': `"${row.version}"` },
        // `expectedVersion` is a REQUIRED body field as well as the If-Match
        // header (the header wins server-side); omitting it is a 400 from the
        // global validation pipe, before OCC is ever evaluated.
        data: { expectedVersion: row.version, reason: 'register e2e' },
      });
      expect(revoked.status()).toBe(200);

      // ACTIVE must now exclude it; REVOKED must include it. The row is kept
      // either way — revocation is never a delete.
      const active = await register(request, `?externalPatientId=${patientId}&state=ACTIVE`);
      expect(
        active.data.map((g) => g.id),
        'a revoked grant is not ACTIVE',
      ).not.toContain(row.id);

      const withdrawn = await register(request, `?externalPatientId=${patientId}&state=REVOKED`);
      expect(
        withdrawn.data.map((g) => g.id),
        'the revoked row is still on record',
      ).toContain(row.id);
    });

    test('state=ACTIVE excludes an EXPIRED grant — the same predicate the ABAC gate applies', async ({ request }) => {
      const patientId = `PAT-EXPIRED-${Date.now()}`;
      const created = await grant(request, patientId, 'STYLE_LEARNING', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
      expect([200, 201]).toContain(created.status());
      const row = (await created.json()) as ConsentGrantBody;

      const active = await register(request, `?externalPatientId=${patientId}&state=ACTIVE`);
      expect(
        active.data.map((g) => g.id),
        'an expired grant is not ACTIVE',
      ).not.toContain(row.id);

      const all = await register(request, `?externalPatientId=${patientId}&state=ALL`);
      expect(
        all.data.map((g) => g.id),
        'ALL still shows it',
      ).toContain(row.id);
    });

    test("never leaks another tenant's grants", async ({ request }) => {
      // Every row the register returns must belong to the caller's tenant.
      // A cross-tenant row here would be a PHI leak, not a display bug.
      const patientId = `PAT-TENANCY-${Date.now()}`;
      await grant(request, patientId, 'EXTERNAL_TOOL_LOOKUP');

      const mine = await register(request, `?externalPatientId=${patientId}&limit=50`);
      expect(mine.data.length).toBe(1);

      // A patient id that exists only in another tenant returns an empty page,
      // never that tenant's row.
      const foreign = await register(request, '?externalPatientId=__no-such-patient-in-this-tenant__');
      expect(foreign.count).toBe(0);
      expect(foreign.data).toEqual([]);
    });
  });

  test('the legacy-grant backfill covers a pre-existing seeded patient (09-consultation.ts PAT-20250101-001) — proves migration -> backfill -> guard ordering', async ({
    request,
  }) => {
    // `PAT-20250101-001` (00-constants.ts PATIENT_IDS.PAT_001) is seeded
    // BEFORE this ticket's migration ever ran. If the legacy-grant backfill
    // (Q2 option (a)) worked, `/admin/consent-grants` already lists an
    // IMPORTED grant for it and the gated history route succeeds without
    // this spec granting anything itself.
    const legacyPatientId = 'PAT-20250101-001';

    // TASK-805: this route is now the paginated consent REGISTER — the
    // patient filter is optional and the body is an envelope, not a bare array.
    const listed = await request.get(`/api/v1/admin/consent-grants?externalPatientId=${legacyPatientId}`, { headers: bearer(token) });
    expect(listed.status()).toBe(200);
    const page = (await listed.json()) as { data: ConsentGrantBody[]; count: number; page: number; limit: number };
    expect(Array.isArray(page.data), 'the register returns a paginated envelope').toBe(true);
    const grants = page.data;
    test.skip(grants.length === 0, `${legacyPatientId} has no consultations in this tenant/environment to prove the backfill against`);
    expect(grants.some((g) => g.purpose === 'HISTORY_RETRIEVAL')).toBe(true);

    // The doctor who actually owns the seeded consultations — see the
    // doc comment on `doctorToken` above for why this differs from `token`.
    const res = await request.get(`/api/v1/consultations/patient/${legacyPatientId}/history`, { headers: bearer(doctorToken) });
    expect(res.status(), 'a pre-existing patient must be covered by the legacy IMPORTED backfill, not denied').toBe(200);
  });
});
