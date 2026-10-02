/**
 * DNA writing-style memory — cross-tenant contract (TASK-1034).
 *
 * Routes under test (all tenant-scoped, 404-over-403):
 *   POST   dna-writing-styles/ingest                 (persists memory; `generate: false` queues nothing)
 *   GET    admin/dna-writing-styles/memory/summary
 *   GET    admin/dna-writing-styles/memory?doctorId=
 *   DELETE admin/dna-writing-styles/memory/:id
 *   GET    admin/dna-writing-styles/schedule
 *
 * Owner = the ARCAAI tenant (its seeded graphs enable DNA), acting through `arcaai_admin` for the
 * seeded ARCAAI doctor. Foreign = Global's `tenant_admin`.
 *
 *   C1. The owner ingests with `generate: false`: 202, `jobId: null`, `stored` ≥ 1, and a re-post of
 *       the same text is a duplicate, not a second row.
 *   C2. The owner lists the sample (preview present, never longer than 200 chars) and sees the
 *       doctor in the summary.
 *   C3. The foreign admin cannot see the doctor in its summary, gets 404 for the doctor's samples,
 *       404 for DELETE of the owner's sample, and 404 for ingesting on behalf of that doctor.
 *   C4. The owner deletes the sample (204); it is gone from the list afterwards.
 *   C5. The schedule read is answered per tenant with the declared shape.
 *
 * Login discipline: each user logs in ONCE (the gateway strict-throttles auth); serial mode.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_ARCAAI_DOCTOR_ID, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const ARCAAI_ADMIN = { username: 'arcaai_admin', password: 'password123', tenantKey: 'ARCAAI' };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('TASK-1034 DNA memory — cross-tenant', () => {
  let owner = '';
  let foreign = '';
  let sampleId = '';
  const marker = `task-1034 e2e ${Date.now()}`;
  const text = `${marker}: Pt seen for review. BP 128/82. Continue amlodipine 5 mg OD. Review in 4 weeks.`;

  test.beforeAll(async ({ request }) => {
    const o = await loginUser(request, ARCAAI_ADMIN.username, ARCAAI_ADMIN.password, ARCAAI_ADMIN.tenantKey);
    const f = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(o, 'arcaai_admin login').not.toBeNull();
    expect(f, 'tenant_admin login').not.toBeNull();
    owner = o!.token;
    foreign = f!.token;
  });

  test('C1 — ingest with generate:false persists memory and dedupes', async ({ request }) => {
    const body = {
      clinicianUserId: SEEDED_ARCAAI_DOCTOR_ID,
      generate: false,
      items: [{ text, writtenAt: '2026-09-01T09:00:00.000Z', kind: 'CASE_NOTE', sourceRef: marker }],
    };
    const first = await request.post('/api/v1/dna-writing-styles/ingest', { headers: bearer(owner), data: body });
    expect(first.status(), await first.text()).toBe(202);
    const r1 = await first.json();
    expect(r1.jobId).toBeNull();
    expect(r1.stored).toBe(1);

    const again = await request.post('/api/v1/dna-writing-styles/ingest', { headers: bearer(owner), data: body });
    expect(again.status()).toBe(202);
    const r2 = await again.json();
    expect(r2.stored).toBe(0);
    expect(r2.duplicates).toBe(1);
  });

  test('C2 — the owner sees the sample and the doctor in the summary', async ({ request }) => {
    const list = await request.get('/api/v1/admin/dna-writing-styles/memory', {
      headers: bearer(owner),
      params: { doctorId: SEEDED_ARCAAI_DOCTOR_ID, source: 'INGEST', limit: 100 },
    });
    expect(list.status(), await list.text()).toBe(200);
    const page = await list.json();
    const row = (page.data as Array<Record<string, unknown>>).find((s) => s.sourceRef === marker);
    expect(row, 'ingested sample listed').toBeTruthy();
    expect(row!.source).toBe('INGEST');
    expect(String(row!.preview ?? '').length).toBeLessThanOrEqual(200);
    sampleId = String(row!.id);

    const summary = await request.get('/api/v1/admin/dna-writing-styles/memory/summary', { headers: bearer(owner) });
    expect(summary.status()).toBe(200);
    const rows = (await summary.json()) as Array<{ doctorId: string; total: number }>;
    expect(rows.find((r) => r.doctorId === SEEDED_ARCAAI_DOCTOR_ID)?.total ?? 0).toBeGreaterThanOrEqual(1);
  });

  test('C3 — another tenant gets 404 / absence, never the sample', async ({ request }) => {
    const summary = await request.get('/api/v1/admin/dna-writing-styles/memory/summary', { headers: bearer(foreign) });
    expect(summary.status()).toBe(200);
    const rows = (await summary.json()) as Array<{ doctorId: string }>;
    expect(rows.some((r) => r.doctorId === SEEDED_ARCAAI_DOCTOR_ID)).toBe(false);

    const list = await request.get('/api/v1/admin/dna-writing-styles/memory', {
      headers: bearer(foreign),
      params: { doctorId: SEEDED_ARCAAI_DOCTOR_ID },
    });
    expect(list.status()).toBe(404);

    const del = await request.delete(`/api/v1/admin/dna-writing-styles/memory/${sampleId}`, { headers: bearer(foreign) });
    expect(del.status()).toBe(404);

    const ingest = await request.post('/api/v1/dna-writing-styles/ingest', {
      headers: bearer(foreign),
      data: {
        clinicianUserId: SEEDED_ARCAAI_DOCTOR_ID,
        generate: false,
        items: [{ text: `${marker} foreign`, writtenAt: '2026-09-01T09:00:00.000Z' }],
      },
    });
    expect(ingest.status()).toBe(404);
  });

  test('C4 — the owner deletes the sample', async ({ request }) => {
    const del = await request.delete(`/api/v1/admin/dna-writing-styles/memory/${sampleId}`, { headers: bearer(owner) });
    expect(del.status(), await del.text()).toBe(204);
    const list = await request.get('/api/v1/admin/dna-writing-styles/memory', {
      headers: bearer(owner),
      params: { doctorId: SEEDED_ARCAAI_DOCTOR_ID, source: 'INGEST', limit: 100 },
    });
    const page = await list.json();
    expect((page.data as Array<{ id: string }>).some((s) => s.id === sampleId)).toBe(false);
  });

  test('C5 — the schedule is answered per tenant with the declared shape', async ({ request }) => {
    for (const token of [owner, foreign]) {
      const res = await request.get('/api/v1/admin/dna-writing-styles/schedule', { headers: bearer(token) });
      expect(res.status(), await res.text()).toBe(200);
      const s = await res.json();
      expect(typeof s.enabled).toBe('boolean');
      expect(typeof s.cron).toBe('string');
      expect(typeof s.minNewSamples).toBe('number');
      expect(typeof s.timeZone).toBe('string');
    }
  });
});
