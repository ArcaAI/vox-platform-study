/**
 * TASK-951 — the open-time MAPPINGS, end to end.
 *
 * The owner's ask is that an integrator states the facts of an encounter ONCE, in the vocabulary
 * its own tenant schema declares, and HOPE turns each of them into the thing it means. TASK-950
 * proved that for one field (the clinician's staff id); this spec is the other four, as HTTP
 * calls, in the order an integrator actually makes them:
 *
 *   mark the fields (admin) -> machine open with the full encounter -> read the consultation and
 *   its context back -> then the refusals.
 *
 * What it pins, and why each is a way the feature could be WRONG rather than merely incomplete:
 *
 *  · the DEPARTMENT arrives as a CODE and becomes `Consultation.departmentId` — an integrator
 *    holds no `svc:admin:department:manage` scope, so it cannot list HOPE department UUIDs at all
 *    and a code is the only identifier it has;
 *  · the VISIT TYPE is recorded on the row, where every prompt and workflow selection reads it
 *    above the parent link;
 *  · the EXTERNAL REFERENCE is recorded as a label, and a re-open with the same patient/date/
 *    clinician still returns the SAME consultation;
 *  · every validated kind is PERSISTED, and a kind marked `materializeAs` becomes one `CASE_NOTE`
 *    per entry — the read the warm-start pre-summary performs;
 *  · the refusals are the documented ones: 404 `DEPARTMENT_UNKNOWN`, 400 `DEPARTMENT_MISMATCH`,
 *    400 `CONTEXT_SCHEMA_VIOLATION`.
 *
 * TASK-950 (`task-950-consultation-identity.spec.ts`) and TASK-933 must stay green alongside this
 * file: the identity marker is untouched, and this spec re-asserts it rather than replacing it.
 *
 * --- How to run it ---------------------------------------------------------
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-951
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed. See
 * `01-development-workflow.md` §Test Placement.)
 *
 * --- Fixtures it needs -----------------------------------------------------
 *
 * A seeded database, and nothing hand-made:
 *   · the ArcaAI service account `hope_svc_a4ca1a11ad3141b0c0de0001` with its dev fixture secret,
 *     which carries the realtime consultation scopes;
 *   · `super_admin` driving ArcaAI as its WORKING TENANT for the one administrative step;
 *   · `arcaai_doctor` as the human caller;
 *   · ArcaAI's `GEN` department (`70000000-…-0001-000000000001`) and `RHEUM`
 *     (`…-000000000011`) as the "other" department for the mismatch case.
 *
 * Patient and staff ids are generated per run, so the spec is re-runnable.
 *
 * --- What it changes, and puts back ----------------------------------------
 *
 * It publishes a marked version onto ArcaAI's TENANT-DEFAULT schema — deliberately the tenant
 * default and not a department-scoped row, because the whole point of the department mapping is
 * that the caller sends NO `departmentId` and the schema that governs is therefore the tenant's.
 * `allowBreakingChange` is set because the three kinds are REDEFINED rather than merely added:
 * whichever schema is the tenant default when this runs (the legacy clone today, the consolidated
 * scribe row once lane A's seed lands), this spec states the exact shape it needs rather than
 * guessing at one. The tenant is restored by PINNING the original version back — the documented
 * rollback, which takes effect immediately for discovery and validation alike and leaves the
 * immutable version history intact.
 *
 * The whole file is SERIAL: the tests share the published marker and the run's clinician, and the
 * repo's Playwright config is `fullyParallel: true`.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe.configure({ mode: 'serial' });

// --- Fixtures ---------------------------------------------------------------

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

const ARCAAI_TENANT = '50000000-0000-0000-0000-000000000001';
const GEN_ARCAAI = '70000000-0000-0000-0001-000000000001';
const RHEUM_ARCAAI = '70000000-0000-0000-0001-000000000011';

/** The three client-supplied kinds of the scribe schema. */
const ENCOUNTER = 'encounter';
const VITALS = 'vitals';
const PRIOR_NOTES = 'previous_case_notes';

const OPEN = '/api/v1/consultations/open';
const SCHEMAS = '/api/v1/admin/consultation-context-schemas';

const svcHeaders = (token: string) => ({ 'X-Service-Account-Token': token, 'Content-Type': 'application/json' });
/** A super administrator ACTING ON ArcaAI — the console's "manage as tenant" selection. */
const adminHeaders = (jwt: string) => ({ Authorization: `Bearer ${jwt}`, 'X-Tenant-Id': ARCAAI_TENANT, 'Content-Type': 'application/json' });
const doctorHeaders = (jwt: string) => ({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' });

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET },
  });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

const patientId = () => `PAT-T951-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const RUN_STAFF_ID = `DR-951-${Date.now()}`;

/** The marked kinds this spec publishes — the scribe schema's client-supplied half. */
const MARKED_KINDS = [
  {
    key: ENCOUNTER,
    label: 'Encounter',
    primitive: 'STRUCTURED',
    phiClass: 'NON_PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    userIdentity: { field: 'doctor_id' },
    department: { field: 'department_code', by: 'code' },
    visitType: { field: 'visit_type' },
    externalRef: { field: 'event_id' },
    fields: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string', minLength: 1 },
        event_id: { type: 'string', minLength: 1 },
        department_code: { type: 'string', minLength: 1 },
        department_name: { type: 'string' },
        visit_type: { type: 'string', enum: ['new-visit', 'revisit'] },
      },
      required: ['doctor_id', 'event_id', 'department_code', 'visit_type'],
    },
  },
  {
    key: VITALS,
    label: 'Vitals',
    primitive: 'STRUCTURED',
    phiClass: 'PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: {
      type: 'object',
      properties: {
        bloodPressure: { type: 'string' },
        heartRate: { type: 'number' },
        temperature: { type: 'number' },
        oxygenSaturation: { type: 'number' },
      },
    },
  },
  {
    key: PRIOR_NOTES,
    label: 'Previous case notes',
    primitive: 'STRUCTURED',
    phiClass: 'PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    materializeAs: 'CASE_NOTE',
    fields: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { date: { type: 'string' }, department: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
      required: ['notes'],
    },
  },
];

const encounter = (overrides: Record<string, unknown> = {}) => ({
  doctor_id: RUN_STAFF_ID,
  event_id: `EVT-${Date.now()}`,
  department_code: 'GEN',
  visit_type: 'new-visit',
  ...overrides,
});

const PRIOR_NOTE_ENTRIES = [
  { date: '2026-01-02', department: 'General Medicine', title: 'Cardiology review', text: 'Stable on current dose; continue.' },
  { date: '2026-02-11', text: 'No new complaints reported at review.' },
];

// --- Suite ------------------------------------------------------------------

test.describe('TASK-951 — a machine states the encounter once and HOPE maps every field', () => {
  let svcToken: string;
  let adminJwt: string;
  let doctorJwt: string;
  let schemaId: string;
  let originalPinnedVersion: number;

  test.beforeAll(async ({ request }) => {
    svcToken = await serviceAccountToken(request);

    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super-admin login').not.toBeNull();
    adminJwt = superAdmin!.token;

    const doctor = await loginUser(request, 'arcaai_doctor', 'password123', 'ARCAAI');
    expect(doctor, 'arcaai_doctor login').not.toBeNull();
    doctorJwt = doctor!.token;

    // 1. The TENANT-DEFAULT schema — what an `open` with NO `departmentId` resolves to, which is
    //    exactly the shape this ticket's department mapping exists for. Whether that row is the
    //    legacy clone or the consolidated `arcaai_consultation_scribe` is lane A's business; this
    //    spec asks the platform which row is default rather than assuming a slug.
    const list = await request.get(SCHEMAS, { headers: adminHeaders(adminJwt) });
    expect(list.status(), await list.text()).toBe(200);
    const rows = (await list.json()) as Array<{ id: string; slug: string; scope: string; isDefault: boolean; pinnedVersionNumber: number | null }>;
    const schema = rows.find((row) => row.slug === 'arcaai_consultation_scribe') ?? rows.find((row) => row.scope === 'TENANT' && row.isDefault);
    expect(schema, "ArcaAI's tenant-default context schema").toBeTruthy();
    schemaId = schema!.id;
    expect(schema!.pinnedVersionNumber, 'the seeded schema is published and pinned').toBeTruthy();
    originalPinnedVersion = schema!.pinnedVersionNumber!;

    // 2. Publish a version carrying the four markers on `encounter` plus the two kinds the
    //    encounter travels with. Existing kinds are preserved; the three this spec owns are
    //    REPLACED, which is why `allowBreakingChange` is set — the assertion here is about the
    //    mappings, not about whether redefining a kind is additive.
    const versions = await request.get(`${SCHEMAS}/${schemaId}/versions`, { headers: adminHeaders(adminJwt) });
    expect(versions.status(), await versions.text()).toBe(200);
    const pinned = ((await versions.json()) as Array<{ versionNumber: number; definition: Record<string, unknown> }>).find(
      (version) => version.versionNumber === originalPinnedVersion,
    );
    expect(pinned, 'the pinned version row').toBeTruthy();

    const definition = JSON.parse(JSON.stringify(pinned!.definition)) as { kinds: Array<{ key: string }> };
    const ours = new Set(MARKED_KINDS.map((kind) => kind.key));
    definition.kinds = [...definition.kinds.filter((kind) => !ours.has(kind.key)), ...MARKED_KINDS];

    const publish = await request.post(`${SCHEMAS}/${schemaId}/publish`, {
      headers: adminHeaders(adminJwt),
      data: { definition, changeReason: 'TASK-951 e2e', allowBreakingChange: true },
    });
    expect(publish.status(), await publish.text()).toBe(201);

    // Re-runnable against a PERSISTENT database: a previous run's afterAll pinned the original
    // back while leaving the marked version in the list, so an identical republish is a checksum
    // no-op that moves nothing. Find the version carrying the department marker and PIN it.
    const after = await request.get(`${SCHEMAS}/${schemaId}/versions`, { headers: adminHeaders(adminJwt) });
    expect(after.status(), await after.text()).toBe(200);
    const marked = ((await after.json()) as Array<{ versionNumber: number; definition: { kinds?: Array<Record<string, unknown>> } }>)
      .filter((version) =>
        (version.definition.kinds ?? []).some((kind) => (kind.department as { field?: string } | undefined)?.field === 'department_code'),
      )
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    expect(marked, 'a version carrying the department marker').toBeTruthy();
    if ((await publish.json()).pinnedVersionNumber !== marked!.versionNumber) {
      const pin = await request.post(`${SCHEMAS}/${schemaId}/pin`, {
        headers: adminHeaders(adminJwt),
        data: { versionNumber: marked!.versionNumber },
      });
      expect(pin.status(), await pin.text()).toBe(201);
    }
  });

  test.afterAll(async ({ request }) => {
    // Idempotent, and it runs even if a test failed mid-way: an abandoned marked pin would
    // silently change what every OTHER spec in the suite validates against.
    if (schemaId && originalPinnedVersion) {
      const pin = await request.post(`${SCHEMAS}/${schemaId}/pin`, {
        headers: adminHeaders(adminJwt),
        data: { versionNumber: originalPinnedVersion },
      });
      expect(pin.status(), await pin.text()).toBe(201);
    }
  });

  // -- 1. The happy path -----------------------------------------------------

  test('the full encounter opens a consultation in the department its CODE names, with both markers recorded', async ({ request }) => {
    const patient = patientId();
    const ref = `EVT-${Date.now()}-A`;

    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      // NO `departmentId`: an integrator holding only the consultation scopes cannot list HOPE
      // department UUIDs, so the code inside `context` is the only identifier it has.
      data: {
        patientId: patient,
        language: 'en',
        context: {
          [ENCOUNTER]: encounter({ event_id: ref, visit_type: 'revisit' }),
          [VITALS]: { bloodPressure: '128/82', heartRate: 72 },
          [PRIOR_NOTES]: { notes: PRIOR_NOTE_ENTRIES },
        },
      },
    });

    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();

    expect(body.departmentId, 'the stated CODE resolved to the GEN department').toBe(GEN_ARCAAI);
    expect(body.metadata?.visitType, 'the stated visit type is recorded on the row').toBe('revisit');
    expect(body.metadata?.externalRef, "the caller's own encounter id is recorded on the row").toBe(ref);
    // The clinician still comes from the identity marker, resolved or provisioned (TASK-950).
    expect(body.doctorId).toBeTruthy();

    // Every validated kind was persisted, and the marked one became one CASE_NOTE per entry.
    const context = await request.get(`/api/v1/consultations/${body.id}/context`, { headers: svcHeaders(svcToken) });
    expect(context.status(), await context.text()).toBe(200);
    const items = (await context.json()) as Array<{ type: string; content?: string }>;

    const structured = items.filter((item) => item.type === 'STRUCTURED');
    expect(structured, 'one STRUCTURED item per validated kind').toHaveLength(3);

    const caseNotes = items.filter((item) => item.type === 'CASE_NOTE');
    expect(caseNotes, 'one CASE_NOTE per supplied prior note').toHaveLength(PRIOR_NOTE_ENTRIES.length);
    // `title` and `text` joined — `ContextItem` has ONE content column and every case-note reader
    // (the warm-start pre-summary included) reads exactly that column.
    expect(caseNotes.map((item) => item.content)).toEqual(
      expect.arrayContaining(['Cardiology review\nStable on current dose; continue.', 'No new complaints reported at review.']),
    );
  });

  test('a re-open with a NEW event id still returns the SAME consultation — the reference is a label, not a key', async ({ request }) => {
    const patient = patientId();
    const payload = (eventId: string) => ({
      patientId: patient,
      appointmentDate: '2026-03-04',
      context: { [ENCOUNTER]: encounter({ event_id: eventId }) },
    });

    const first = await request.post(OPEN, { headers: svcHeaders(svcToken), data: payload('EVT-FIRST') });
    expect(first.status(), await first.text()).toBe(201);
    const firstBody = await first.json();

    const second = await request.post(OPEN, { headers: svcHeaders(svcToken), data: payload('EVT-SECOND') });
    expect(second.status(), await second.text()).toBe(201);
    const secondBody = await second.json();

    expect(secondBody.id, 'the idempotency tuple is unchanged by the external reference').toBe(firstBody.id);
    expect(secondBody.isNew).toBe(false);
    // And the re-open appended nothing: get-or-create must not write a second copy of the
    // client's PRE items.
    const context = await request.get(`/api/v1/consultations/${firstBody.id}/context`, { headers: svcHeaders(svcToken) });
    expect(context.status()).toBe(200);
    expect(((await context.json()) as Array<{ type: string }>).filter((item) => item.type === 'STRUCTURED')).toHaveLength(1);
  });

  // -- 2. The refusals -------------------------------------------------------

  test('a department code this tenant does not carry is 404 DEPARTMENT_UNKNOWN', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), context: { [ENCOUNTER]: encounter({ department_code: 'NO-SUCH-CODE' }) } },
    });

    // 404, not 403 and not 400: an unknown code and another tenant's code stay indistinguishable.
    expect(res.status(), await res.text()).toBe(404);
    expect((await res.json()).code).toBe('DEPARTMENT_UNKNOWN');
  });

  test('a `departmentId` that disagrees with the stated code is 400 DEPARTMENT_MISMATCH', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: RHEUM_ARCAAI, context: { [ENCOUNTER]: encounter({ department_code: 'GEN' }) } },
    });

    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('DEPARTMENT_MISMATCH');
  });

  test('a `departmentId` that AGREES with the stated code opens normally', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: { [ENCOUNTER]: encounter() } },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).departmentId).toBe(GEN_ARCAAI);
  });

  test('a visit type the SCHEMA does not admit is 400 CONTEXT_SCHEMA_VIOLATION', async ({ request }) => {
    // `referral` is a catalogue ALIAS of `new-visit`, so `VisitTypeService.match` would accept it
    // — but this tenant declared `visit_type` as an enum of the two keys, and the schema is
    // checked FIRST. The tenant's own vocabulary wins over the platform's aliases, which is the
    // point of declaring an enum at all.
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), context: { [ENCOUNTER]: encounter({ visit_type: 'referral' }) } },
    });

    expect(res.status(), await res.text()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CONTEXT_SCHEMA_VIOLATION');
    expect(Array.isArray(body.problems) ? body.problems.join(' ') : '').toContain(ENCOUNTER);
  });

  // -- 3. A human caller gets the same mappings ------------------------------

  test('a HUMAN caller is mapped and persisted identically — only the clinician differs', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: doctorHeaders(doctorJwt),
      data: {
        patientId: patientId(),
        context: { [ENCOUNTER]: encounter({ visit_type: 'revisit' }), [PRIOR_NOTES]: { notes: [PRIOR_NOTE_ENTRIES[1]] } },
      },
    });

    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.departmentId).toBe(GEN_ARCAAI);
    expect(body.metadata?.visitType).toBe('revisit');

    // The identity field is CONTENT for a human (TASK-950 D-5): their own authenticated identity
    // is the clinician, never the staff id in the body.
    expect(body.doctorId).not.toBe(RUN_STAFF_ID);

    const context = await request.get(`/api/v1/consultations/${body.id}/context`, { headers: doctorHeaders(doctorJwt) });
    expect(context.status(), await context.text()).toBe(200);
    const items = (await context.json()) as Array<{ type: string }>;
    expect(items.filter((item) => item.type === 'STRUCTURED')).toHaveLength(2);
    expect(items.filter((item) => item.type === 'CASE_NOTE')).toHaveLength(1);
  });
});
