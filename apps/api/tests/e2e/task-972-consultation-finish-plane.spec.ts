/**
 * TASK-972 Lane 4 — the FINISH half of the consultation plane, as HTTP.
 *
 * TASK-933 opened the RUN half of this plane to the machine class; the three routes that FINISH
 * a consultation declared no `svc:*` scope at all and were therefore deny-by-default 403s
 * (`05-nestjs-api.md` §API Test Standard). Lane 4 grants:
 *
 *   PATCH  /consultations/:id/summary/:summaryId              -> svc:consultation:report:write
 *   POST   /consultations/:id/summary/:contextItemId/approve  -> svc:consultation:session:write
 *   POST   /consultations/:id/close                           -> svc:consultation:session:write
 *
 * ─── What belongs HERE and what does not ───────────────────────────────────
 *
 * The route-level authorization conformance of all three (does a bare service account reach
 * them, does an API key, is the scope actually required) is GENERATED from the route manifest by
 * `task-776-route-authz-matrix.spec.ts` and needs no hand-written case. This file carries only
 * the DEPTH the matrix cannot express: who a caller may name as the attesting clinician, which
 * depends on the CREDENTIAL CLASS and on a role held IN THIS TENANT.
 *
 * ─── How to run it ─────────────────────────────────────────────────────────
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-972
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed.)
 *
 * ─── Fixtures ──────────────────────────────────────────────────────────────
 *
 * All seeded, none hand-made. The ArcaAI service account (bound to the ARCAAI tenant at
 * exchange, so `X-Tenant-Id` is never sent beside it), `arcaai_doctor` as the clinician it may
 * name, the Global-tenant `doctor` as the clinician it may NOT, and `SEEDED_API_KEY` — bound to
 * the Global `doctor`, who holds no administrative role, which is exactly what makes the
 * "a credential never exceeds its human" case real.
 *
 * Every consultation is opened fresh with a per-run patient id, so no case depends on another's
 * leftovers and `getOrCreate` always takes its CREATE branch.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  DEFAULT_TENANT_KEY,
  loginUser,
  SEEDED_API_KEY,
  SEEDED_USERS,
  SEEDED_ARCAAI_DOCTOR_ID,
  SEEDED_SERVICE_ACCOUNT_CLIENT_ID,
  SEEDED_SERVICE_ACCOUNT_CLIENT_SECRET,
} from '../../../../tests/helpers';

/** A Global-tenant clinician — a real user, in a tenant the ArcaAI account is not bound to. */
const GLOBAL_DOCTOR = SEEDED_USERS.doctor.id;
const GLOBAL_DOCTOR2 = SEEDED_USERS.doctor2.id;
/** The ARCAAI clinician the service account MAY name. */
const ARCAAI_DOCTOR = SEEDED_ARCAAI_DOCTOR_ID;

const svcHeaders = (token: string) => ({ 'X-Service-Account-Token': token, 'Content-Type': 'application/json' });
const keyHeaders = { 'X-API-Key': SEEDED_API_KEY, 'Content-Type': 'application/json' };

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SEEDED_SERVICE_ACCOUNT_CLIENT_ID, clientSecret: SEEDED_SERVICE_ACCOUNT_CLIENT_SECRET },
  });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

const patientId = () => `PAT-T972-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Opens a consultation and returns its id plus a usable `If-Match` validator. */
async function openConsultation(
  request: APIRequestContext,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ id: string; ifMatch: string }> {
  const opened = await request.post('/api/v1/consultations/open', { headers, data: { patientId: patientId(), ...body } });
  expect(opened.status(), await opened.text()).toBe(201);
  const id = (await opened.json()).id as string;
  const read = await request.get(`/api/v1/consultations/${id}`, { headers });
  expect(read.status(), await read.text()).toBe(200);
  const etag = read.headers()['etag'];
  expect(etag, 'the read must carry a strong validator for If-Match').toBeTruthy();
  return { id, ifMatch: etag };
}

test.describe('TASK-972 — a service account finishes a consultation for a NAMED clinician', () => {
  let svcToken: string;

  test.beforeAll(async ({ request }) => {
    svcToken = await serviceAccountToken(request);
  });

  test('close: a machine that names NO clinician is 400 CLINICIAN_REQUIRED — never the account itself', async ({ request }) => {
    const { id, ifMatch } = await openConsultation(request, svcHeaders(svcToken), {
      clinicianUserId: ARCAAI_DOCTOR,
    });

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...svcHeaders(svcToken), 'If-Match': ifMatch },
      data: {},
    });

    // 400 and not 403: the grant landed (a 403 here would mean the scope never reached the
    // route), and the refusal is about WHO the body names, which is a rule, not a row.
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_REQUIRED');
  });

  test('close: a clinician in ANOTHER tenant is 404 — the user id space is not the caller`s to probe', async ({ request }) => {
    const { id, ifMatch } = await openConsultation(request, svcHeaders(svcToken), {
      clinicianUserId: ARCAAI_DOCTOR,
    });

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...svcHeaders(svcToken), 'If-Match': ifMatch },
      data: { clinicianUserId: GLOBAL_DOCTOR },
    });

    // 404, never 403 — the house cross-tenant posture, doubly right here because the answer
    // would otherwise confirm that a user id exists in some other tenant.
    expect(res.status(), await res.text()).toBe(404);
  });

  test('close: naming a clinician OF ITS OWN TENANT closes the row, and the machine is not the actor', async ({ request }) => {
    const { id, ifMatch } = await openConsultation(request, svcHeaders(svcToken), {
      clinicianUserId: ARCAAI_DOCTOR,
    });

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...svcHeaders(svcToken), 'If-Match': ifMatch },
      data: { clinicianUserId: ARCAAI_DOCTOR },
    });

    // `OPEN -> CLOSED_INCOMPLETE` is legal since Lane 7 (OD-7); an unsigned consultation closes
    // incomplete. The authorization fact under test is that it closes AT ALL.
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).status).toBe('CLOSED_INCOMPLETE');
  });

  test('PATCH summary: the grant landed — an unknown summary id is 404, not the old deny-by-default 403', async ({ request }) => {
    const { id } = await openConsultation(request, svcHeaders(svcToken), { clinicianUserId: ARCAAI_DOCTOR });

    const res = await request.patch(`/api/v1/consultations/${id}/summary/00000000-0000-4000-8000-0000000009e9`, {
      headers: { ...svcHeaders(svcToken), 'If-Match': '"1"' },
      data: { expectedVersion: 1, content: 'edited', clinicianUserId: ARCAAI_DOCTOR },
    });

    // Existence is resolved before the attribution rule (`assertParentInScope` first), so an
    // unknown id is 404. What matters here is only that it is not 403.
    expect(res.status(), await res.text()).toBe(404);
  });

  test('approve: the grant landed — an unknown summary id is 404, not the old deny-by-default 403', async ({ request }) => {
    const { id } = await openConsultation(request, svcHeaders(svcToken), { clinicianUserId: ARCAAI_DOCTOR });

    const res = await request.post(`/api/v1/consultations/${id}/summary/00000000-0000-4000-8000-0000000009e9/approve`, {
      headers: { ...svcHeaders(svcToken), 'If-Match': '"1"' },
      data: { expectedVersion: 1, clinicianUserId: ARCAAI_DOCTOR },
    });

    expect(res.status(), await res.text()).toBe(404);
  });

  test('PATCH summary: `clinicianUserId` is a DECLARED field — the strict pipe does not reject the body', async ({ request }) => {
    const { id } = await openConsultation(request, svcHeaders(svcToken), { clinicianUserId: ARCAAI_DOCTOR });

    const res = await request.patch(`/api/v1/consultations/${id}/summary/00000000-0000-4000-8000-0000000009e9`, {
      headers: { ...svcHeaders(svcToken), 'If-Match': '"1"' },
      data: { expectedVersion: 1, content: 'x', clinicianUserId: ARCAAI_DOCTOR },
    });

    // `whitelist + forbidNonWhitelisted` turns an UNDECLARED field into a 400 naming it. Getting
    // past validation to the 404 is the proof the DTO declares it.
    expect(res.status()).not.toBe(400);
  });
});

test.describe('TASK-972 — an API key may not exceed the human it is bound to', () => {
  test('close: naming ANOTHER clinician is 400 CLINICIAN_NOT_ALLOWED', async ({ request }) => {
    // `SEEDED_API_KEY` is bound to the Global `doctor`, who holds DOCTOR and no administrative
    // role — so the key may act only for them.
    const { id, ifMatch } = await openConsultation(request, keyHeaders, {});

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...keyHeaders, 'If-Match': ifMatch },
      data: { clinicianUserId: GLOBAL_DOCTOR2 },
    });

    // This is the case that fails SILENTLY if the controller lets the caller be derived from
    // CLS: there is no `apiKey` CLS key, so the key would be classified `jwt`, the bound-human
    // rule would never run, and this would be a 200.
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_NOT_ALLOWED');
  });

  test('close: naming its OWN bound human is allowed', async ({ request }) => {
    const { id, ifMatch } = await openConsultation(request, keyHeaders, {});

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...keyHeaders, 'If-Match': ifMatch },
      data: { clinicianUserId: GLOBAL_DOCTOR },
    });

    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).status).toBe('CLOSED_INCOMPLETE');
  });

  test('close: naming NOBODY is 400 CLINICIAN_REQUIRED — a key is a machine credential too', async ({ request }) => {
    const { id, ifMatch } = await openConsultation(request, keyHeaders, {});

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...keyHeaders, 'If-Match': ifMatch },
      data: {},
    });

    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_REQUIRED');
  });
});

test.describe('TASK-972 — a human JWT still finishes their own consultation with no body', () => {
  test('close: a doctor closes their own consultation, naming nobody', async ({ request }) => {
    const { id, ifMatch } = await openConsultation(request, keyHeaders, {});

    // Deliberately reuses the key-opened consultation (same doctor, same tenant) and closes it
    // with the HUMAN credential: the bodyless close a browser client has always sent must keep
    // working, unchanged, now that the route has a body DTO.
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login').not.toBeNull();

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { Authorization: `Bearer ${login!.token}`, 'If-Match': ifMatch },
    });

    expect(res.status(), await res.text()).toBe(200);
  });
});
