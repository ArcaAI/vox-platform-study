/**
 * Live-stack proof of the tenant-declared context-schema plane (TASK-658/661/665)
 * and of the regression contract that makes the whole TASK-654 programme opt-in.
 *
 * Everything below was previously asserted by unit tests against mocked
 * repositories only — TASK-654 OP-2 / TASK-675. Two things are proven here that
 * a mock cannot:
 *
 *   1. **The plane works end to end** — create a DRAFT, publish an immutable
 *      version, have discovery resolve the PIN, and have a context write
 *      validate against that pinned version through the real gateway,
 *      ValidationPipe, service layer and Postgres.
 *   2. **K7 — the plane is opt-in and costs nothing to a tenant that ignores it.**
 *      This is the guarantee the programme rests on: no clinician in any tenant
 *      may depend on an admin having configured a schema. It is asserted in the
 *      two states that matter — a tenant with NO schema at all, and a tenant
 *      that HAS a published schema but whose write simply does not name a kind.
 *
 * `__GLOBAL__` is deliberately never given a schema, so the "no schema
 * configured" arm stays true however often this spec runs. The schema is
 * created in ARCAAI under a run-unique slug and soft-deleted at the end, so the
 * spec is re-runnable.
 *
 * Live-stack requirement: seeded test stack (`pnpm infra:test:up`,
 * `pnpm test:db:seed`) + `pnpm test:up:api`.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const ADMIN_SCHEMAS = '/api/v1/admin/consultation-context-schemas';
const DISCOVERY = '/api/v1/tenant/me/context-schema';

/** Seeded `__GLOBAL__` consultation owned by the `doctor` user. */
const GLOBAL_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';
/** Seeded ARCAAI consultation owned by `arcaai_doctor`. */
const ARCAAI_CONSULTATION_ID = '90000000-0000-0000-0001-000000000001';

/** ARCAAI-scoped seed users; neither is in SEEDED_USERS (that map is `__GLOBAL__`). */
const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';
const ARCAAI_DOCTOR_USERNAME = 'arcaai_doctor';
const SEED_PASSWORD = 'password123';

const KIND = 'referral_letter';

/** One STRUCTURED kind with a small, strict `fields` sub-schema. */
const DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: KIND,
      label: 'Referral Letter',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      fields: {
        type: 'object',
        properties: {
          referrer: { type: 'string' },
          urgency: { type: 'string', enum: ['routine', 'urgent'] },
        },
        required: ['referrer'],
        additionalProperties: false,
      },
    },
  ],
};

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ===========================================================================
// K7 — the regression contract, on a tenant that has NO schema at all.
// ===========================================================================
test.describe('TASK-654 K7 — a tenant with no context schema is untouched by the programme', () => {
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
    doctorToken = doctor!.token;
  });

  test('discovery answers 200 with null fields and ETag "none" — never 404', async ({ request }) => {
    const response = await request.get(DISCOVERY, { headers: auth(doctorToken) });

    // A 404 here would be indistinguishable from a routing mistake to a client,
    // which is exactly why the endpoint returns an empty bundle instead.
    expect(response.status()).toBe(200);
    expect(response.headers()['etag']).toBe('"none"');

    const bundle = await response.json();
    expect(bundle.schemaId).toBeNull();
    expect(bundle.definition).toBeNull();
    expect(bundle.contextSchemaVersionId).toBeNull();
  });

  test('a context write that names no kindKey behaves exactly as before the programme', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/context`, {
      headers: auth(doctorToken),
      data: { type: 'CASE_NOTE', content: 'K7 — legacy write, no kindKey, no schema configured' },
    });

    expect(response.status()).toBe(201);
    const item = await response.json();
    expect(item.type).toBe('CASE_NOTE');
    expect(item.isCaseNote).toBe(true);
    expect(item.content).toBe('K7 — legacy write, no kindKey, no schema configured');
  });

  test('a payload without a kindKey is refused rather than silently persisted unvalidated', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/context`, {
      headers: auth(doctorToken),
      data: { type: 'STRUCTURED', payload: { referrer: 'Dr Who' } },
    });

    expect(response.status()).toBe(400);
    expect(String((await response.json()).message ?? '')).toMatch(/requires `kindKey`/);
  });
});

// ===========================================================================
// The plane itself, end to end, in ARCAAI.
// ===========================================================================
test.describe.serial('TASK-658 — context-schema plane end to end', () => {
  let adminToken: string;
  let arcaaiDoctorToken: string;
  let globalAdminToken: string;
  let schemaId: string;
  let publishedEtag: string;
  let pinnedVersionId: string;

  // Run-unique so the spec is re-runnable (`slug` is unique per tenant → 409).
  const slug = `task675_probe_${Date.now().toString(36)}`;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, ARCAAI_TENANT_KEY);
    expect(admin, 'arcaai_admin login failed — is the stack seeded?').toBeTruthy();
    adminToken = admin!.token;

    const arcaaiDoctor = await loginUser(request, ARCAAI_DOCTOR_USERNAME, SEED_PASSWORD, ARCAAI_TENANT_KEY);
    expect(arcaaiDoctor, 'arcaai_doctor login failed — is the stack seeded?').toBeTruthy();
    arcaaiDoctorToken = arcaaiDoctor!.token;

    const globalAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(globalAdmin, 'tenant_admin login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
    globalAdminToken = globalAdmin!.token;
  });

  test.afterAll(async ({ request }) => {
    if (schemaId) {
      await request.delete(`${ADMIN_SCHEMAS}/${schemaId}`, { headers: auth(adminToken) });
    }
  });

  test('a schema is born DRAFT with no pinned version', async ({ request }) => {
    const response = await request.post(ADMIN_SCHEMAS, {
      headers: auth(adminToken),
      data: { slug, name: 'TASK-675 probe schema', scope: 'TENANT', isDefault: true },
    });

    expect(response.status()).toBe(201);
    const schema = await response.json();
    schemaId = schema.id;

    expect(schema.status).toBe('DRAFT');
    expect(schema.pinnedVersionNumber).toBeNull();
    // CLS-scoped: the caller never supplied a tenantId and cannot forge one.
    expect(schema.tenantId).toBe('50000000-0000-0000-0000-000000000001');
  });

  test('publishing validates the definition, writes version 1, and pins it', async ({ request }) => {
    const response = await request.post(`${ADMIN_SCHEMAS}/${schemaId}/publish`, {
      headers: auth(adminToken),
      data: { definition: DEFINITION, changeReason: 'TASK-675 live verification' },
    });

    expect(response.status()).toBe(201);
    const schema = await response.json();
    expect(schema.status).toBe('PUBLISHED');
    expect(schema.pinnedVersionNumber).toBe(1);
  });

  test('a definition outside the platform primitives is refused', async ({ request }) => {
    const response = await request.post(`${ADMIN_SCHEMAS}/${schemaId}/publish`, {
      headers: auth(adminToken),
      data: {
        definition: {
          schemaVersion: '1.0',
          kinds: [{ ...DEFINITION.kinds[0], key: 'bad_kind', primitive: 'HOLOGRAM' }],
        },
      },
    });

    // Keeping tenant vocabulary on platform substrate is the enforcement point
    // that stops an unprocessable kind reaching a live consultation.
    expect(response.status()).toBe(400);
  });

  test('discovery resolves the PINNED version and carries a content-derived ETag', async ({ request }) => {
    const response = await request.get(DISCOVERY, { headers: auth(adminToken) });
    expect(response.status()).toBe(200);

    const bundle = await response.json();
    expect(bundle.slug).toBe(slug);
    expect(bundle.versionNumber).toBe(1);
    expect(bundle.definition.kinds.map((k: { key: string }) => k.key)).toContain(KIND);

    publishedEtag = response.headers()['etag'];
    pinnedVersionId = bundle.contextSchemaVersionId;

    // A real validator over the served representation, not the `"none"` sentinel.
    expect(publishedEtag).toBeTruthy();
    expect(publishedEtag).not.toBe('"none"');
    expect(bundle.etag).toBe(publishedEtag);
    expect(pinnedVersionId).toBeTruthy();
  });

  test('re-publishing an IDENTICAL definition is a no-op — no new version, unchanged ETag', async ({ request }) => {
    const republish = await request.post(`${ADMIN_SCHEMAS}/${schemaId}/publish`, {
      headers: auth(adminToken),
      data: { definition: DEFINITION, changeReason: 'TASK-675 identical re-publish' },
    });
    expect(republish.status()).toBe(201);
    expect((await republish.json()).pinnedVersionNumber).toBe(1);

    const versions = await request.get(`${ADMIN_SCHEMAS}/${schemaId}/versions`, { headers: auth(adminToken) });
    expect(versions.status()).toBe(200);
    expect((await versions.json()).length).toBe(1);

    const discovery = await request.get(DISCOVERY, { headers: auth(adminToken) });
    expect(discovery.headers()['etag']).toBe(publishedEtag);
  });

  test('a payload conforming to the pinned kind is accepted and canonicalised into content', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${ARCAAI_CONSULTATION_ID}/context`, {
      headers: auth(arcaaiDoctorToken),
      data: { type: 'STRUCTURED', kindKey: KIND, payload: { referrer: 'Dr Tan', urgency: 'urgent' } },
    });

    expect(response.status()).toBe(201);
    const item = await response.json();
    expect(item.type).toBe('STRUCTURED');
    // There is no plaintext JSON column — the validated payload rides the same
    // encrypted `content` column as every other text-bearing context type.
    expect(JSON.parse(item.content)).toEqual({ referrer: 'Dr Tan', urgency: 'urgent' });
  });

  test('the same payload validates against an explicitly pinned version header', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${ARCAAI_CONSULTATION_ID}/context`, {
      headers: { ...auth(arcaaiDoctorToken), 'X-Context-Schema-Version': pinnedVersionId },
      data: { type: 'STRUCTURED', kindKey: KIND, payload: { referrer: 'Dr Lim' } },
    });

    expect(response.status()).toBe(201);
  });

  test('an undeclared kind is refused', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${ARCAAI_CONSULTATION_ID}/context`, {
      headers: auth(arcaaiDoctorToken),
      data: { type: 'STRUCTURED', kindKey: 'not_a_declared_kind', payload: { x: 1 } },
    });

    expect(response.status()).toBe(400);
    expect(String((await response.json()).message ?? '')).toMatch(/does not declare a kind/);
  });

  test('a payload violating the kind sub-schema is refused and names the problem', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${ARCAAI_CONSULTATION_ID}/context`, {
      headers: auth(arcaaiDoctorToken),
      data: { type: 'STRUCTURED', kindKey: KIND, payload: { urgency: 'urgent' } },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(String(body.message ?? '')).toMatch(/does not conform/);
    expect(JSON.stringify(body.problems ?? [])).toMatch(/referrer/);
  });

  test('K7 — a write that names no kindKey still succeeds on a tenant that HAS a schema', async ({ request }) => {
    const response = await request.post(`/api/v1/consultations/${ARCAAI_CONSULTATION_ID}/context`, {
      headers: auth(arcaaiDoctorToken),
      data: { type: 'CASE_NOTE', content: 'K7 — schema exists, this write simply does not name a kind' },
    });

    // The schema plane is opt-in PER WRITE, not per tenant. If configuring a
    // schema could break an ordinary clinical note, the whole feature would be
    // unsafe to enable.
    expect(response.status()).toBe(201);
    expect((await response.json()).isCaseNote).toBe(true);
  });

  test('another tenant cannot read this schema — 404, never 403', async ({ request }) => {
    const response = await request.get(`${ADMIN_SCHEMAS}/${schemaId}`, { headers: auth(globalAdminToken) });

    expect(response.status()).toBe(404);
    expect(String((await response.json()).message ?? '')).not.toMatch(/tenant/i);
  });

  test('the schema list is tenant-scoped', async ({ request }) => {
    const response = await request.get(ADMIN_SCHEMAS, { headers: auth(globalAdminToken) });
    expect(response.status()).toBe(200);

    const rows = (await response.json()) as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug)).not.toContain(slug);
  });
});
