/**
 * TASK-950 — the consultation-context USER IDENTITY field, end to end.
 *
 * The ticket's claim is that a tenant admin can mark ONE field of its consultation context
 * schema as the clinician's STAFF IDENTIFIER, after which an external system authenticated as a
 * HOPE **service account** opens consultations by sending the id its own roster already uses —
 * and HOPE resolves it to a tenant user, provisioning one the first time. This spec is that
 * claim as HTTP calls, in the order an integrator actually makes them:
 *
 *   mark the field (admin) -> machine open with a staff id -> read the provisioned user back ->
 *   open again with the same id and get the SAME clinician -> then the refusals.
 *
 * Plus the boundaries that make the grant meaningful, asserted rather than implied: a payload
 * the schema does not admit (400 `CONTEXT_SCHEMA_VIOLATION`), the two identifiers disagreeing
 * (400 `CLINICIAN_MISMATCH`), a machine identifying nobody at all (400 `CLINICIAN_REQUIRED`),
 * a HUMAN caller whose own identity always wins (D-5), and an unknown staff id in a tenant that
 * has switched auto-provisioning off (404 `USER_IDENTITY_UNKNOWN`).
 *
 * TASK-933 (`task-933-service-account-consultation.spec.ts`) and TASK-658 must stay green
 * alongside this file: `clinicianUserId` on its own is untouched, and this spec re-asserts that
 * shape rather than replacing it.
 *
 * --- How to run it ---------------------------------------------------------
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-950
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed. See
 * `01-development-workflow.md` §Test Placement.)
 *
 * --- Fixtures it needs -----------------------------------------------------
 *
 * A seeded database, and nothing hand-made:
 *   · the ArcaAI service account `hope_svc_a4ca1a11ad3141b0c0de0001` with its dev fixture secret
 *     (`SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN`, seeded only in development/test), which
 *     since TASK-933 carries the realtime consultation scopes;
 *   · `super_admin` (`SEEDED_USERS.superAdmin`) driving ArcaAI as its WORKING TENANT
 *     (`X-Tenant-Id`) for the two administrative steps — marking the schema field and flipping
 *     the auto-provision setting. That is the same governed lane a tenant administrator uses;
 *     it is chosen here because it needs no assumption about which abilities the seeded
 *     `arcaai_admin` happens to hold;
 *   · `arcaai_doctor` (`70000000-…-040`, role DOCTOR, tenant ArcaAI) as the human caller and as
 *     the "other" clinician in the mismatch case;
 *   · the DEPARTMENT-scoped schema `consultation_gen_arcaai` and its department `GEN_ARCAAI`
 *     (`70000000-0000-0000-0001-000000000001`).
 *
 * Staff ids and patient ids are generated per run, so the spec is re-runnable: every run
 * provisions its own clinician rather than joining one a previous run left behind.
 *
 * --- What it changes, and puts back ----------------------------------------
 *
 * It PUBLISHES a new version of `consultation_gen_arcaai` carrying the marker, and restores the
 * tenant by PINNING the original version back (`POST :id/pin`) — the documented rollback path.
 * Re-publishing the original definition would be a BREAKING change (a removed property) needing
 * `allowBreakingChange`; moving the pin needs nothing, takes effect immediately for discovery
 * and validation alike, and leaves the immutable version history intact. The settings override
 * is removed with `DELETE …?scope=tenant` rather than written back to `true`, so the tenant
 * resumes INHERITING the platform default instead of being pinned to a value this spec chose.
 *
 * The whole file is SERIAL: the tests share the provisioned clinician and the published marker,
 * and the repo's Playwright config is `fullyParallel: true`.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe.configure({ mode: 'serial' });

// --- Fixtures ---------------------------------------------------------------

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';

const ARCAAI_TENANT = '50000000-0000-0000-0000-000000000001';
const ARCAAI_DOCTOR = '70000000-0000-0000-0000-000000000040';
const GEN_ARCAAI = '70000000-0000-0000-0001-000000000001';

/** The DEPARTMENT-scoped schema an `open({ departmentId: GEN_ARCAAI })` resolves to. */
const SCHEMA_SLUG = 'consultation_gen_arcaai';
/** Its STRUCTURED, cardinality-ONE kind — the only shape a user-identity marker may sit on. */
const KIND_KEY = 'vitals';
/** The property this spec adds and marks. */
const IDENTITY_FIELD = 'consultant_id';

/**
 * `identity.autoProvision.enabled` (D-9). NOTE for whoever authors the descriptors: the registry
 * write lane accepts the `global-kv` tier ONLY — `SettingsRegistryWriteService.write` answers
 * 400 for anything else — so this key must be registered there to be writable through
 * `PUT admin/settings/registry/:key`, which is the governed lane a tenant administrator has.
 */
const AUTO_PROVISION_KEY = 'identity.autoProvision.enabled';

const OPEN = '/api/v1/consultations/open';
const SETTINGS = '/api/v1/admin/settings';
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

/** A patient id unique to this run, so `getOrCreate` always takes its CREATE branch. */
const patientId = () => `PAT-T950-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
/** A staff id unique to this run, so the FIRST open always provisions. */
const RUN_STAFF_ID = `DR-950-${Date.now()}`;

/** A payload the marked schema admits: the kind's own required fields plus the identity value. */
const contextWith = (staffId: string) => ({
  [KIND_KEY]: { bloodPressure: '128/82', heartRate: 72, [IDENTITY_FIELD]: staffId },
});

// --- Suite ------------------------------------------------------------------

test.describe('TASK-950 — a service account opens a consultation for a clinician named by STAFF ID', () => {
  let svcToken: string;
  let adminJwt: string;
  let doctorJwt: string;
  let schemaId: string;
  let originalPinnedVersion: number;
  /** Filled by the first test; every later test asserts against the SAME clinician. */
  let provisionedUserId: string;

  test.beforeAll(async ({ request }) => {
    svcToken = await serviceAccountToken(request);

    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super-admin login').not.toBeNull();
    adminJwt = superAdmin!.token;

    const doctor = await loginUser(request, 'arcaai_doctor', 'password123', 'ARCAAI');
    expect(doctor, 'arcaai_doctor login').not.toBeNull();
    doctorJwt = doctor!.token;

    // 1. Find the DEPARTMENT-scoped schema an open for GEN_ARCAAI resolves to.
    const list = await request.get(SCHEMAS, { headers: adminHeaders(adminJwt) });
    expect(list.status(), await list.text()).toBe(200);
    const schema = ((await list.json()) as Array<{ id: string; slug: string; pinnedVersionNumber: number | null }>).find(
      (row) => row.slug === SCHEMA_SLUG,
    );
    expect(schema, `seeded schema '${SCHEMA_SLUG}'`).toBeTruthy();
    schemaId = schema!.id;
    expect(schema!.pinnedVersionNumber, 'the seeded schema is published and pinned').toBeTruthy();
    originalPinnedVersion = schema!.pinnedVersionNumber!;

    // 2. Read the pinned definition and ADD the identity property + the marker to its STRUCTURED
    //    kind. Both are ADDITIVE (nothing removed, nothing narrowed), so no `allowBreakingChange`
    //    — which is itself the assertion that marking a field does not break existing clients.
    const versions = await request.get(`${SCHEMAS}/${schemaId}/versions`, { headers: adminHeaders(adminJwt) });
    expect(versions.status(), await versions.text()).toBe(200);
    const pinned = ((await versions.json()) as Array<{ versionNumber: number; definition: Record<string, unknown> }>).find(
      (version) => version.versionNumber === originalPinnedVersion,
    );
    expect(pinned, 'the pinned version row').toBeTruthy();

    const definition = JSON.parse(JSON.stringify(pinned!.definition)) as {
      kinds: Array<Record<string, unknown> & { key: string; fields?: { properties?: Record<string, unknown> } }>;
    };
    const kind = definition.kinds.find((declared) => declared.key === KIND_KEY);
    expect(kind, `kind '${KIND_KEY}'`).toBeTruthy();
    kind!.fields = { ...kind!.fields, properties: { ...(kind!.fields?.properties ?? {}), [IDENTITY_FIELD]: { type: 'string', minLength: 1 } } };
    kind!.userIdentity = { field: IDENTITY_FIELD };

    const publish = await request.post(`${SCHEMAS}/${schemaId}/publish`, {
      headers: adminHeaders(adminJwt),
      data: { definition, changeReason: 'TASK-950 e2e' },
    });
    expect(publish.status(), await publish.text()).toBe(201);

    // Re-runnable against a PERSISTENT database: a previous run's afterAll pinned the original
    // back while leaving the marked version in the list, so an identical republish is a checksum
    // no-op that moves nothing (`publish` is idempotent). Find the version that carries the marker
    // and PIN it explicitly — the same operation afterAll uses to roll back.
    const after = await request.get(`//versions`, { headers: adminHeaders(adminJwt) });
    expect(after.status(), await after.text()).toBe(200);
    const marked = ((await after.json()) as Array<{ versionNumber: number; definition: { kinds?: Array<Record<string, unknown>> } }>)
      .filter((version) =>
        (version.definition.kinds ?? []).some((declared) => (declared.userIdentity as { field?: string } | undefined)?.field === IDENTITY_FIELD),
      )
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    expect(marked, 'a version carrying the identity marker').toBeTruthy();
    expect(marked!.versionNumber).toBeGreaterThan(originalPinnedVersion);
    if ((await publish.json()).pinnedVersionNumber !== marked!.versionNumber) {
      const pin = await request.post(`//pin`, { headers: adminHeaders(adminJwt), data: { versionNumber: marked!.versionNumber } });
      expect(pin.status(), await pin.text()).toBe(201);
    }
  });

  test.afterAll(async ({ request }) => {
    // Both restores are idempotent, and both run even if a test failed mid-way — an abandoned
    // marker or a stuck `false` would silently change what every OTHER spec in the suite sees.
    await request.delete(`${SETTINGS}/registry/${AUTO_PROVISION_KEY}?scope=tenant`, { headers: adminHeaders(adminJwt) });
    if (schemaId && originalPinnedVersion) {
      const pin = await request.post(`${SCHEMAS}/${schemaId}/pin`, {
        headers: adminHeaders(adminJwt),
        data: { versionNumber: originalPinnedVersion },
      });
      expect(pin.status(), await pin.text()).toBe(201);
    }
  });

  // -- 1. The happy path, and the user it creates ----------------------------

  test('a machine open carrying only a staff id creates the clinician and records THEM as the doctor', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, language: 'en', context: contextWith(RUN_STAFF_ID) },
    });

    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.doctorId).toBeTruthy();
    // Never the machine, and never a seeded clinician: this staff id is new this run.
    expect(body.doctorId).not.toBe(SVC_ACCOUNT_ID);
    expect(body.doctorId).not.toBe(ARCAAI_DOCTOR);
    expect(body.departmentId).toBe(GEN_ARCAAI);
    provisionedUserId = body.doctorId;
  });

  test('the provisioned user carries the staff id on its profile and the requested department', async ({ request }) => {
    expect(provisionedUserId, 'the previous test provisioned a user').toBeTruthy();

    const user = await request.get(`/api/v1/admin/users/${provisionedUserId}`, { headers: adminHeaders(adminJwt) });
    expect(user.status(), await user.text()).toBe(200);
    const userBody = await user.json();
    // D-8 — the generated username. The staff id NEVER appears in it (it may be PII), and the
    // `auto_` prefix is the provenance marker `UserResponse` actually exposes: the `tags` array
    // that also carries `auto-provisioned` is not a field on that DTO today.
    expect(userBody.username).toMatch(/^auto_[0-9a-f]{16}$/);
    expect(userBody.username).not.toContain(RUN_STAFF_ID);
    expect(userBody.isServiceAccount).toBe(false);

    const profile = await request.get(`/api/v1/admin/users/${provisionedUserId}/profile`, { headers: adminHeaders(adminJwt) });
    expect(profile.status(), await profile.text()).toBe(200);
    expect((await profile.json()).staffId).toBe(RUN_STAFF_ID);

    const departments = await request.get(`/api/v1/admin/users/${provisionedUserId}/departments`, { headers: adminHeaders(adminJwt) });
    expect(departments.status(), await departments.text()).toBe(200);
    expect(((await departments.json()) as Array<{ departmentId: string }>).map((row) => row.departmentId)).toContain(GEN_ARCAAI);

    // The ROLE is asserted behaviourally by the 201 above: `open` answers 404 for a clinician
    // whose own ability does not grant `create:Consultation`, so a user that successfully owns a
    // consultation demonstrably holds a role that does.
  });

  test('a SECOND open with the same staff id reuses that clinician — resolution, not re-provisioning', async ({ request }) => {
    expect(provisionedUserId, 'the first test provisioned a user').toBeTruthy();

    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: contextWith(RUN_STAFF_ID) },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).doctorId).toBe(provisionedUserId);
  });

  // -- 2. The refusals -------------------------------------------------------

  test('a payload the schema does not admit is 400 CONTEXT_SCHEMA_VIOLATION, listing the problems', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: {
        patientId: patientId(),
        departmentId: GEN_ARCAAI,
        // `heartRate` is declared a number; a string fails. The whole open is refused — a
        // consultation is never half-opened with a payload the tenant's vocabulary rejects.
        context: { [KIND_KEY]: { bloodPressure: '128/82', heartRate: 'seventy-two', [IDENTITY_FIELD]: RUN_STAFF_ID } },
      },
    });

    expect(res.status(), await res.text()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CONTEXT_SCHEMA_VIOLATION');
    expect(Array.isArray(body.problems)).toBe(true);
    expect(body.problems.length).toBeGreaterThan(0);
    expect(body.problems.join(' ')).toContain(KIND_KEY);
  });

  test('an unknown kind key is a violation too, not an ignored extra', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: { not_a_declared_kind: { anything: true } } },
    });

    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('CONTEXT_SCHEMA_VIOLATION');
  });

  test('`clinicianUserId` and the identity value may both be sent when they AGREE', async ({ request }) => {
    expect(provisionedUserId).toBeTruthy();

    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, clinicianUserId: provisionedUserId, context: contextWith(RUN_STAFF_ID) },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).doctorId).toBe(provisionedUserId);
  });

  test('...and are 400 CLINICIAN_MISMATCH when they name two different clinicians', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, clinicianUserId: ARCAAI_DOCTOR, context: contextWith(RUN_STAFF_ID) },
    });

    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_MISMATCH');
  });

  test('a machine that identifies nobody by either route is still 400 CLINICIAN_REQUIRED', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI },
    });

    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_REQUIRED');
  });

  test('`clinicianUserId` alone still works — the TASK-933 contract is untouched', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, clinicianUserId: ARCAAI_DOCTOR },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).doctorId).toBe(ARCAAI_DOCTOR);
  });

  test('a HUMAN caller sending the identity field opens as THEMSELVES — the field is content (D-5)', async ({ request }) => {
    const res = await request.post(OPEN, {
      headers: doctorHeaders(doctorJwt),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: contextWith(RUN_STAFF_ID) },
    });

    expect(res.status(), await res.text()).toBe(201);
    // Resolving someone else from a body field would be impersonation with no gate.
    expect((await res.json()).doctorId).toBe(ARCAAI_DOCTOR);
  });

  // -- 3. The tenant switch that declines provisioning (OD-3) ----------------

  test('with auto-provisioning off, an unknown staff id is 404 USER_IDENTITY_UNKNOWN', async ({ request }) => {
    // Read first so the write carries the row's own version as `If-Match`. A FIRST write has no
    // row and therefore no ETag, which is exactly why this route is `@NoOptimisticConcurrency`.
    const before = await request.get(`${SETTINGS}/registry/${AUTO_PROVISION_KEY}?scope=tenant`, { headers: adminHeaders(adminJwt) });
    expect(before.status(), await before.text()).toBe(200);
    const etag = before.headers()['etag'];

    const write = await request.put(`${SETTINGS}/registry/${AUTO_PROVISION_KEY}`, {
      headers: { ...adminHeaders(adminJwt), ...(etag ? { 'If-Match': etag } : {}) },
      data: { value: false, scope: 'tenant' },
    });
    expect(write.status(), await write.text()).toBe(200);

    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: contextWith(`DR-950-UNKNOWN-${Date.now()}`) },
    });

    // 404, not 403: the user id space is not the caller's to probe (D-10).
    expect(res.status(), await res.text()).toBe(404);
    expect((await res.json()).code).toBe('USER_IDENTITY_UNKNOWN');
  });

  test('...while an ALREADY KNOWN staff id keeps resolving — the switch governs creation, not lookup', async ({ request }) => {
    expect(provisionedUserId).toBeTruthy();

    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: contextWith(RUN_STAFF_ID) },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).doctorId).toBe(provisionedUserId);
  });

  test('removing the override restores provisioning for the tenant', async ({ request }) => {
    const reset = await request.delete(`${SETTINGS}/registry/${AUTO_PROVISION_KEY}?scope=tenant`, { headers: adminHeaders(adminJwt) });
    expect(reset.status(), await reset.text()).toBe(200);

    const res = await request.post(OPEN, {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI, context: contextWith(`DR-950-RESTORED-${Date.now()}`) },
    });

    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).doctorId).toBeTruthy();
  });
});
