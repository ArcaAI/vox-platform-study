/**
 * Backend residuals (P2-6 filter validation + P2-7 recording fixture).
 *
 * AUTHORED-AND-DEFERRED: this spec was NOT run against the live stack when
 * written (the API stack was owned by a sibling piece of work at the time);
 * it is executed by the consolidated post-wave verifier.
 *
 * What it verifies:
 *
 *  1. Enum-member validation (P2-6b) — an invalid enum member in a `filters`
 *     CSV token is a clean 400 naming the allowed members (previously it
 *     passed through and Prisma rejected it server-side as a 500-class error);
 *     a valid member keeps working.
 *
 *  2. JSON-path filtering (P2-6b) — `jsonColumn.path[op]:value` deserializes
 *     to Prisma's `{ path, [op] }` JSON filter on declared JSON columns
 *     (200 with correctly-filtered results); an operator outside the JSON
 *     path-filter allow-list is a 400.
 *
 *  3. Model-aware coercion for other list resources (P2-6c) — the Tenant list
 *     (one of the six newly-registered models: Tenant/Media/Role/Tag/Webhook/
 *     Notification) coerces number filters and member-validates enum filters.
 *
 *  4. Recording-shaped audio fixture (P2-7a) — the seeded media fixture's
 *     AUDIO_RECORDING container + AudioRecording row + WAV media surface
 *     through `GET /consultations/:id/recordings` with the seeded audio
 *     metadata. Read as the consultation's tenant-bound owner, which is
 *     env-overridable (P2-7b): `E2E_MEDIA_OWNER_USERNAME` / `..._PASSWORD` /
 *     `..._TENANT_KEY` (defaults: seeded doctor / __GLOBAL__).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface Paginated<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

// Media-seed fixture ids (see packages/applications/scripts/media-seed.ts).
const MEDIA_CONSULTATION_ID = process.env.E2E_CONSULTATION_ID ?? '90000000-0000-0000-0000-000000000376';
const RECORDING_MEDIA_ID = '96000000-0000-0000-0000-000000000381';

// P2-7b — env-overridable tenant-bound owner of the media consultation.
const MEDIA_OWNER = {
  username: process.env.E2E_MEDIA_OWNER_USERNAME || SEEDED_USERS.doctor.username,
  password: process.env.E2E_MEDIA_OWNER_PASSWORD || SEEDED_USERS.doctor.password,
  tenantKey: process.env.E2E_MEDIA_OWNER_TENANT_KEY || DEFAULT_TENANT_KEY,
};

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

test.describe('backend residuals (filter validation + recording fixture)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    // Cross-tenant operator: super_admin logs in WITHOUT a tenantKey.
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    token = sa!.token;
  });

  // --- 1. Enum-member validation (P2-6b) ------------------------------------

  test('Users list: a VALID enum member filter still works (200)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'resourceStatus[equals]:ENABLED',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(body.count, 'seeded stack has enabled users').toBeGreaterThan(0);
  });

  test('Users list: an INVALID enum member is a clean 400 naming the allowed members', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'resourceStatus[equals]:BOGUS_STATUS',
    });
    expect(res.status(), 'invalid enum member → BadRequest (was a Prisma server-side rejection)').toBe(400);
    const body = await res.json();
    const message = JSON.stringify(body);
    expect(message).toContain('BOGUS_STATUS');
    expect(message).toContain('ENABLED'); // the allowed members are listed
  });

  // --- 2. JSON-path filtering (P2-6b) ----------------------------------------

  test('Users list: a JSON-path filter on a declared JSON column is accepted (200)', async ({ request }) => {
    // metaData is a declared Json column of User; the dotted key becomes
    // Prisma's `{ path: ['task406'], equals: 'no-such-value' }` filter.
    // No seeded row matches — the point is the 200 (valid query), not hits.
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'metaData.task406[equals]:no-such-value',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(body.count).toBe(0);
  });

  test('Users list: an unsupported JSON-path operator is a 400', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'metaData.task406[contains]:x', // `contains` is a String op, not a JSON path op
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('contains');
  });

  // --- 3. Model-aware coercion for other list resources (P2-6c) --------------

  test('Tenants list: number filter coerces via the Tenant registry entry (200)', async ({ request }) => {
    // Every tenant row has _version ≥ 1; without coercion the value stays a
    // string and Prisma rejects `{ version: { gte: '1' } }` server-side.
    const res = await authGet(request, '/api/v1/admin/tenants', token, {
      limit: '10',
      filters: 'version[gte]:1',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(body.count, 'seeded stack has tenants (all _version ≥ 1)').toBeGreaterThan(0);
  });

  test('Tenants list: an invalid TenantPlan member is a 400', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants', token, {
      limit: '10',
      filters: 'plan[equals]:NOT_A_PLAN',
    });
    expect(res.status()).toBe(400);
    const message = JSON.stringify(await res.json());
    expect(message).toContain('NOT_A_PLAN');
    expect(message).toContain('TRIAL'); // allowed members listed
  });

  // --- 4. Recording-shaped audio fixture (P2-7a, owner env P2-7b) ------------

  test('Recordings: the seeded recording-shaped fixture surfaces with its audio metadata', async ({ request }) => {
    test.skip(!MEDIA_CONSULTATION_ID, 'No media consultation available (E2E_CONSULTATION_ID explicitly empty) — TASK-376 seed not present.');

    // The recordings route is TENANT-SCOPED → read as the consultation's
    // tenant-bound owner (env-overridable, defaults to the seeded doctor).
    const owner = await loginUser(request, MEDIA_OWNER.username, MEDIA_OWNER.password, MEDIA_OWNER.tenantKey);
    expect(
      owner,
      `consultation-owner (${MEDIA_OWNER.username}) login failed — is the stack seeded / are the E2E_MEDIA_OWNER_* env overrides correct?`,
    ).toBeTruthy();

    const res = await authGet(request, `/api/v1/consultations/${MEDIA_CONSULTATION_ID}/recordings`, owner!.token);
    expect(res.status()).toBe(200);

    const recordings = (await res.json()) as Array<{
      id: string;
      mediaId: string;
      duration?: number;
      format?: string;
      sampleRate?: number;
      channels?: number;
      sequenceNumber: number;
      recordedAt?: string;
    }>;
    expect(recordings.length, 'consultation has at least one audio recording').toBeGreaterThan(0);

    const seeded = recordings.find((r) => r.mediaId === RECORDING_MEDIA_ID);
    expect(seeded, `seeded recording (media ${RECORDING_MEDIA_ID}) present`).toBeTruthy();
    expect(seeded!.format).toBe('wav');
    expect(seeded!.duration).toBe(2000);
    expect(seeded!.sampleRate).toBe(16000);
    expect(seeded!.channels).toBe(1);
    expect(seeded!.sequenceNumber).toBeGreaterThanOrEqual(1);
    expect(seeded!.recordedAt, 'recordedAt is populated').toBeTruthy();
  });
});
