/**
 * Consultation lifecycle, HTTP-surface e2e (seven-state lifecycle + old-vocabulary projection).
 *
 * AUTHORED, NOT EXECUTED by the lane that wrote it: run with `pnpm test:up:api` (terminal 1),
 * then `RESET_DB=false npx dotenv -e .env.test -- npx playwright test consultation-lifecycle-task1045`.
 *
 * Needs only a live apps/api + Postgres + Redis: every consultation is opened fresh, no STT
 * session is bound (so `stop` has nothing to finalize and answers `complete` at once), and no
 * note is generated (approve signs no note and snapshots the record as it stands).
 *
 * Cases:
 *   1. start → pause → start → stop (twice: the second is the D-28 no-op) → approve → approve
 *      again (D-29 no-op) → close (CLOSED_COMPLETE) → close again (no-op).
 *   2. Without `X-Hope-Lifecycle: 2` the JSON `status` is the old vocabulary (PAUSED → RECORDING,
 *      APPROVED → SIGNED) while `lifecycle.status` carries the real value.
 *   3. approve / close / reopen without If-Match → 428; with a stale version → 412.
 *   4. reopen of CLOSED_INCOMPLETE → OPEN; a reason over 256 characters → 400.
 *   5. GET :id/encounters → encounter 1; GET :id/recording before any audio → 404 RECORDING_NOT_READY.
 *   6. Deprecated aliases answer `Deprecation: true` + `Sunset`.
 *   7. Cross-tenant: every command and read from tenant ARCAAI → 404, never 403; the event stream
 *      → 404 before it opens.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const lifecycleV2 = { 'X-Hope-Lifecycle': '2' };

function uniquePatientId(label: string): string {
  return `e2e-1045-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function grantAiDocumentationConsent(request: APIRequestContext, adminToken: string, externalPatientId: string): Promise<void> {
  const res = await request.post('/api/v1/admin/consent-grants', {
    headers: bearer(adminToken),
    data: { externalPatientId, purpose: 'AI_DOCUMENTATION', grantMethod: 'VERBAL_ATTESTED' },
  });
  expect([200, 201], 'POST /admin/consent-grants (AI_DOCUMENTATION)').toContain(res.status());
}

async function open(request: APIRequestContext, token: string, patientId: string): Promise<{ id: string; version: number }> {
  const res = await request.post('/api/v1/consultations/open', { headers: { ...bearer(token), ...lifecycleV2 }, data: { patientId } });
  expect([200, 201], 'POST /consultations/open').toContain(res.status());
  const body = await res.json();
  expect(body.lifecycle?.status).toBe('OPEN');
  return { id: body.id as string, version: body.version as number };
}

async function read(request: APIRequestContext, token: string, id: string, headers: Record<string, string> = lifecycleV2) {
  const res = await request.get(`/api/v1/consultations/${id}`, { headers: { ...bearer(token), ...headers } });
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('consultation lifecycle (apps/api + Postgres + Redis)', () => {
  let doctorToken: string;
  let adminToken: string;
  let foreignToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    const foreign = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(doctor && admin && foreign, 'logins').toBeTruthy();
    doctorToken = doctor!.token;
    adminToken = admin!.token;
    foreignToken = foreign!.token;
  });

  test('case 1: the capture and record commands, with their idempotent repeats', async ({ request }) => {
    const patientId = uniquePatientId('walk');
    const { id } = await open(request, doctorToken, patientId);
    await grantAiDocumentationConsent(request, adminToken, patientId);
    const h = { ...bearer(doctorToken), ...lifecycleV2 };

    const started = await request.post(`/api/v1/consultations/${id}/start`, { headers: h, data: {} });
    expect(started.status()).toBe(200);
    expect(await started.json()).toMatchObject({ consultationId: id, status: 'RECORDING', recording: true });

    const paused = await request.post(`/api/v1/consultations/${id}/pause`, { headers: h });
    expect(paused.status()).toBe(200);
    expect(await paused.json()).toMatchObject({ status: 'PAUSED', paused: true });

    expect((await request.post(`/api/v1/consultations/${id}/start`, { headers: h, data: {} })).status()).toBe(200);

    const stopped = await request.post(`/api/v1/consultations/${id}/stop`, { headers: h, data: {} });
    expect(stopped.status()).toBe(200);
    const stopBody = await stopped.json();
    expect(stopBody.status).toBe('STOPPED');
    expect(stopBody.finalTranscript.state).toBe('complete');

    const again = await request.post(`/api/v1/consultations/${id}/stop`, { headers: h, data: {} });
    expect(again.status(), 'stop on STOPPED is a no-op (D-28)').toBe(200);
    expect((await again.json()).version).toBe(stopBody.version);

    let current = await read(request, doctorToken, id);
    const approved = await request.post(`/api/v1/consultations/${id}/approve`, { headers: { ...h, 'If-Match': `"${current.version}"` }, data: {} });
    expect(approved.status()).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.lifecycle.status).toBe('APPROVED');
    expect(approvedBody.approval).toMatchObject({ approvedBy: expect.any(String), snapshotHash: expect.any(String) });

    const approvedAgain = await request.post(`/api/v1/consultations/${id}/approve`, {
      headers: { ...h, 'If-Match': `"${approvedBody.version}"` },
      data: {},
    });
    expect(approvedAgain.status(), 'approve on APPROVED is a no-op (D-29)').toBe(200);

    current = await read(request, doctorToken, id);
    const closed = await request.post(`/api/v1/consultations/${id}/close`, { headers: { ...h, 'If-Match': `"${current.version}"` }, data: {} });
    expect(closed.status()).toBe(200);
    const closedBody = await closed.json();
    expect(closedBody.lifecycle.status).toBe('CLOSED_COMPLETE');
    expect(closedBody.closedReason).toBe('APPROVED');

    const closedAgain = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...h, 'If-Match': `"${closedBody.version}"` },
      data: {},
    });
    expect(closedAgain.status(), 'close on CLOSED_COMPLETE is a no-op (D-29)').toBe(200);
  });

  test('case 2: an older client reads the old vocabulary; lifecycle carries the real value', async ({ request }) => {
    const patientId = uniquePatientId('vocab');
    const { id } = await open(request, doctorToken, patientId);
    await grantAiDocumentationConsent(request, adminToken, patientId);
    const legacy = bearer(doctorToken);

    await request.post(`/api/v1/consultations/${id}/start`, { headers: legacy, data: {} });
    const paused = await request.post(`/api/v1/consultations/${id}/pause`, { headers: legacy });
    expect(await paused.json()).toMatchObject({ status: 'RECORDING', lifecycle: { status: 'PAUSED' } });

    const body = await read(request, doctorToken, id, {});
    expect(body.status).toBe('RECORDING');
    expect(body.lifecycle.status).toBe('PAUSED');
    expect(paused.headers()['vary'] ?? '').toMatch(/x-hope-lifecycle/i);
  });

  test('case 3: approve / close / reopen require If-Match and refuse a stale one', async ({ request }) => {
    const { id, version } = await open(request, doctorToken, uniquePatientId('occ'));
    const h = { ...bearer(doctorToken), ...lifecycleV2 };
    for (const command of ['approve', 'close', 'reopen']) {
      expect((await request.post(`/api/v1/consultations/${id}/${command}`, { headers: h, data: {} })).status(), `${command} without If-Match`).toBe(
        428,
      );
    }
    const stale = await request.post(`/api/v1/consultations/${id}/close`, { headers: { ...h, 'If-Match': `"${version + 50}"` }, data: {} });
    expect(stale.status()).toBe(412);
  });

  test('case 4: reopen of CLOSED_INCOMPLETE, and the reason length limit', async ({ request }) => {
    const { id, version } = await open(request, doctorToken, uniquePatientId('reopen'));
    const h = { ...bearer(doctorToken), ...lifecycleV2 };
    const closed = await (
      await request.post(`/api/v1/consultations/${id}/close`, { headers: { ...h, 'If-Match': `"${version}"` }, data: {} })
    ).json();
    expect(closed.lifecycle.status).toBe('CLOSED_INCOMPLETE');

    const tooLong = await request.post(`/api/v1/consultations/${id}/reopen`, {
      headers: { ...h, 'If-Match': `"${closed.version}"` },
      data: { reason: 'x'.repeat(257) },
    });
    expect(tooLong.status()).toBe(400);

    const reopened = await request.post(`/api/v1/consultations/${id}/reopen`, {
      headers: { ...h, 'If-Match': `"${closed.version}"` },
      data: { reason: 'late lab result' },
    });
    expect(reopened.status()).toBe(200);
    expect((await reopened.json()).lifecycle.status).toBe('OPEN');
  });

  test('case 5: encounters and the recording read', async ({ request }) => {
    const { id } = await open(request, doctorToken, uniquePatientId('reads'));
    const h = { ...bearer(doctorToken), ...lifecycleV2 };

    const encounters = await request.get(`/api/v1/consultations/${id}/encounters`, { headers: h });
    expect(encounters.status()).toBe(200);
    expect(await encounters.json()).toEqual([expect.objectContaining({ seq: 1 })]);

    const recording = await request.get(`/api/v1/consultations/${id}/recording`, { headers: h });
    expect(recording.status()).toBe(404);
    expect(JSON.stringify(await recording.json())).toContain('RECORDING_NOT_READY');
  });

  test('case 6: the deprecated aliases announce their sunset', async ({ request }) => {
    const patientId = uniquePatientId('alias');
    const { id } = await open(request, doctorToken, patientId);
    await grantAiDocumentationConsent(request, adminToken, patientId);
    const res = await request.post(`/api/v1/consultations/${id}/recording/start`, { headers: bearer(doctorToken), data: {} });
    expect(res.status()).toBe(200);
    expect(res.headers()['deprecation']).toBe('true');
    expect(res.headers()['sunset']).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: 'RECORDING', lifecycle: { status: 'RECORDING' } });

    const stop = await request.post(`/api/v1/consultations/${id}/recording/stop`, { headers: bearer(doctorToken), data: {} });
    expect(stop.status()).toBe(200);
    expect(stop.headers()['deprecation']).toBe('true');
  });

  test('case 7: another tenant gets 404 on every command, read and the event stream', async ({ request }) => {
    const { id, version } = await open(request, doctorToken, uniquePatientId('xt'));
    const h = { ...bearer(foreignToken), ...lifecycleV2 };
    const ifMatch = { ...h, 'If-Match': `"${version}"` };

    for (const command of ['start', 'pause', 'stop']) {
      expect((await request.post(`/api/v1/consultations/${id}/${command}`, { headers: h, data: {} })).status(), `foreign ${command}`).toBe(404);
    }
    for (const command of ['approve', 'close', 'reopen']) {
      expect((await request.post(`/api/v1/consultations/${id}/${command}`, { headers: ifMatch, data: {} })).status(), `foreign ${command}`).toBe(404);
    }
    for (const path of ['encounters', 'recording']) {
      expect((await request.get(`/api/v1/consultations/${id}/${path}`, { headers: h })).status(), `foreign GET ${path}`).toBe(404);
    }
    const events = await request.get(`/api/v1/consultations/${id}/events`, { headers: h, timeout: 5_000 });
    expect(events.status(), 'foreign event stream is refused before it opens').toBe(404);
  });
});
