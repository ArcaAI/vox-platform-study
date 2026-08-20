/**
 * F-10 — audit snapshots must not persist PHI plaintext.
 *
 * A PHI entity carries its DECRYPTED value as a TRANSIENT property beside the
 * `encrypted*` ciphertext column (`PHI_CIPHERTEXT_FIELDS` in
 * `packages/domains/src/common/phi-read-decrypt.ts`). The audit snapshot
 * serialized the whole entity, so `AuditLog.data` held BOTH halves:
 *
 *   data ->> 'encryptedContent' = {"type":"Buffer","data":[…]}
 *   data ->> 'content'          = "<the clinical note, in the clear>"
 *
 * Those columns are envelope-encrypted precisely because the database alone is
 * not sufficient protection for PHI, and the audit table has its own retention
 * profile plus a CSV export endpoint — so the copy defeated the encryption for
 * every audited clinical edit.
 *
 * This spec mutates a ContextItem through the real routes and asserts the
 * resulting audit rows carry neither the plaintext nor the raw ciphertext,
 * while still recording WHICH fields the mutation wrote.
 *
 * Environment: test API at `process.env.API_URL` (default http://localhost:8968)
 * and a seeded test database. Audit rows are written asynchronously through a
 * BullMQ queue, so the reads below poll.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Distinctive strings that must never appear in an audit payload. */
const PHI_CREATE = `f10-phi-create-${Date.now()}-chest-pain-radiating-to-jaw`;
const PHI_UPDATE = `f10-phi-update-${Date.now()}-started-on-metoprolol-25mg`;

interface ContextItemBody {
  id: string;
  version: number;
  content?: string;
}

interface AuditRow {
  id: string;
  action: string;
  resourceId: string | null;
  data: unknown;
  previousData: unknown;
}

/**
 * Poll the audit read API until at least `min` rows exist for the resource.
 * The audit write is queued, so a first read can legitimately be empty.
 */
async function fetchAuditRows(request: APIRequestContext, token: string, contextId: string, min: number): Promise<AuditRow[]> {
  let rows: AuditRow[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request.get(`/api/v1/admin/audit-logs/resource/ContextItem/${contextId}?limit=50&page=1`, {
      headers: bearer(token),
    });
    expect(res.status(), 'GET /admin/audit-logs/resource/ContextItem/:id').toBe(200);
    const body = (await res.json()) as { data?: AuditRow[] };
    rows = body.data ?? [];
    if (rows.length >= min) return rows;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return rows;
}

// SERIAL: `beforeAll` performs stateful writes that every test reads back by id.
test.describe.configure({ mode: 'serial' });

test.describe('F-10 — AuditLog carries no PHI plaintext', () => {
  let doctorToken: string;
  let adminToken: string;
  let consultationId: string;
  let contextId: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login failed').toBeTruthy();
    doctorToken = doctor!.token;

    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant_admin login failed').toBeTruthy();
    adminToken = admin!.token;

    const opened = await request.post('/api/v1/consultations/open', {
      headers: bearer(doctorToken),
      data: { patientId: `f10-audit-phi-${Date.now()}` },
    });
    expect([200, 201], 'POST /consultations/open').toContain(opened.status());
    consultationId = ((await opened.json()) as { id: string }).id;

    const created = await request.post(`/api/v1/consultations/${consultationId}/context`, {
      headers: bearer(doctorToken),
      data: { type: 'CASE_NOTE', content: PHI_CREATE },
    });
    expect([200, 201], 'POST :id/context').toContain(created.status());
    const item = (await created.json()) as ContextItemBody;
    contextId = item.id;

    // A second write, so the UPDATE row's `data` AND `previousData` both hold a
    // PHI snapshot.
    const patched = await request.patch(`/api/v1/consultations/${consultationId}/context/${contextId}`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${item.version}"` },
      data: { content: PHI_UPDATE, expectedVersion: item.version },
    });
    expect([200, 412], 'PATCH :id/context/:contextId').toContain(patched.status());
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v1/consultations/${consultationId}`, { headers: bearer(doctorToken) }).catch(() => undefined);
  });

  test('audit rows for the ContextItem exist', async ({ request }) => {
    const rows = await fetchAuditRows(request, adminToken, contextId, 1);
    expect(rows.length, 'the mutation must have produced at least one audit row').toBeGreaterThan(0);
  });

  test('no audit row carries the note plaintext', async ({ request }) => {
    const rows = await fetchAuditRows(request, adminToken, contextId, 1);
    const serialized = JSON.stringify(rows);

    expect(serialized, 'created note plaintext leaked into AuditLog').not.toContain(PHI_CREATE);
    expect(serialized, 'updated note plaintext leaked into AuditLog').not.toContain(PHI_UPDATE);
  });

  test('no audit row carries the raw ciphertext buffer', async ({ request }) => {
    const rows = await fetchAuditRows(request, adminToken, contextId, 1);
    const serialized = JSON.stringify(rows);

    expect(serialized, 'ciphertext Buffer leaked into AuditLog').not.toContain('"type":"Buffer"');
  });

  test('the audit trail still records WHICH fields the mutation wrote', async ({ request }) => {
    const rows = await fetchAuditRows(request, adminToken, contextId, 1);
    const withContentKey = rows.filter((row) => {
      const data = row.data as Record<string, unknown> | null;
      return data !== null && typeof data === 'object' && 'content' in data;
    });

    expect(withContentKey.length, 'the `content` field name must survive redaction').toBeGreaterThan(0);
    for (const row of withContentKey) {
      expect((row.data as Record<string, unknown>).content).toBe('[REDACTED:PHI]');
    }
  });
});
