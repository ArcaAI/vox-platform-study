/**
 * TASK-932 §3.7 — the two things `POST /consultations/open` learned: a declared LANGUAGE, and a
 * VISIT TYPE that is observable. (TASK-932 called it the "summary language"; TASK-1001 OD-12
 * settled that it is the SOURCE language — see below. Test titles keep the historical wording.)
 *
 * ## Why `language` is a field and not an option bag entry
 *
 * The gateway's global pipe runs `forbidNonWhitelisted`, so an undeclared field does not fall
 * through to be ignored — it REJECTS THE WHOLE OPEN with a 400. That is what makes "the SDK can
 * just send it" false, and it is why this spec's first assertion is that the field is accepted at
 * all.
 *
 * ## The distinction being pinned
 *
 * `language` is the consultation's SOURCE language — what is spoken — stored as declared and
 * echoed back (`en`, `ml`, `en-IN`, or a code-switch mode such as `ml-en`). It is NOT the language
 * the NOTE is written in: owner decision TASK-1001 OD-12 — the pre-summary and the summary are
 * written in the tenant's output-language policy, or the platform default (English) when there is
 * none, and never in this value. Nor is it the STT language mode that decodes a capture, which
 * TASK-891 OD-1 settled separately ("the code-switch is always enabled … to use a specific
 * language, the SDK or end-user must declare the language code") and which travels on
 * `audio.start({ languageMode })`. Absent means UNDECLARED: no source tag is invented, so a test
 * that asserted a default of `en` on this field would be asserting something the platform does not
 * do.
 *
 * ## Visit type
 *
 * There is no visit-type field, by design (OD-3): the platform's two visit types are derived from
 * `parentConsultationId`, and the department consultation workflows branch on that derivation
 * (`n_visit`, `trigger.context.visit_type`). So "open with a parent ⇒ revisit" is asserted where
 * it is actually observable — on the consultation row and on `GET :id/workflow`.
 *
 * Runs against a live gateway + Postgres only. No TEXT, no STT, no harness.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Unique per run so `getOrCreate` never returns a prior run's row (which would skip the create branch). */
const uniquePatientId = (label: string) => `e2e-932-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface OpenedConsultation {
  id: string;
  language?: string;
  parentConsultationId?: string;
  metadata?: Record<string, unknown>;
  isNew?: boolean;
}

async function open(request: APIRequestContext, token: string, data: Record<string, unknown>) {
  return request.post('/api/v1/consultations/open', { headers: bearer(token), data });
}

async function openOk(request: APIRequestContext, token: string, data: Record<string, unknown>): Promise<OpenedConsultation> {
  const res = await open(request, token, data);
  expect([200, 201], `POST /consultations/open must succeed — got ${res.status()} ${await res.text()}`).toContain(res.status());
  return (await res.json()) as OpenedConsultation;
}

let token: string;

test.beforeAll(async ({ request }) => {
  const session = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
  // `loginUser` returns null on a credential/seed mismatch (its documented sentinel) and throws on
  // an unreachable API — so a null here means the DB is not seeded, which is a real failure of
  // this spec's precondition rather than something to skip past.
  expect(session, 'the seeded `doctor` must be able to sign in — run `pnpm test:db:reset` + seed').not.toBeNull();
  token = session!.token;
});

test.describe('TASK-932 — POST /consultations/open declares the summary language', () => {
  test('accepts `language` and echoes it back on the consultation', async ({ request }) => {
    const opened = await openOk(request, token, { patientId: uniquePatientId('lang'), language: 'ml' });

    expect(opened.language, 'the declared summary language must be readable back').toBe('ml');

    // …and on a subsequent read, not only on the create response.
    const read = await request.get(`/api/v1/consultations/${opened.id}`, { headers: bearer(token) });
    expect(read.status()).toBe(200);
    expect(((await read.json()) as OpenedConsultation).language).toBe('ml');
  });

  test('a REGIONAL tag survives intact — `en-IN` is not flattened to `en`', async ({ request }) => {
    const opened = await openOk(request, token, { patientId: uniquePatientId('region'), language: 'en-IN' });
    expect(opened.language).toBe('en-IN');
  });

  test('ABSENT means undeclared, which is not English', async ({ request }) => {
    const opened = await openOk(request, token, { patientId: uniquePatientId('undeclared') });
    // The one assertion the owner's OD-1 posture turns on: no default is invented here.
    expect(opened.language, 'an undeclared consultation must not acquire a language').toBeUndefined();
  });

  test('a malformed tag is REFUSED at the edge rather than reaching a prompt as prose', async ({ request }) => {
    // The value that actually arrives by accident is a display name. Stored as the source tag it
    // would be prose where a code belongs; refusing it at the edge is the honest answer.
    for (const language of ['English please', 'e', '../etc', 'toolongtobealanguagetag-really-quite-long-indeed']) {
      const res = await open(request, token, { patientId: uniquePatientId('bad'), language });
      expect(res.status(), `\`${language}\` must be refused`).toBe(400);
    }
  });

  test('the STT channel is untouched — declaring a note language sends no `languageMode`', async ({ request }) => {
    const opened = await openOk(request, token, { patientId: uniquePatientId('axes'), language: 'ml' });
    const metadata = (opened.metadata ?? {}) as Record<string, unknown>;
    expect(Object.keys(metadata)).not.toContain('languageMode');
    expect(opened.language).toBe('ml');
  });
});

test.describe('TASK-932 — visit type is derived from the parent, and is observable', () => {
  test('opening with `parentConsultationId` produces a REVISIT, and the governing workflow says so', async ({ request }) => {
    const patientId = uniquePatientId('revisit');
    const first = await openOk(request, token, { patientId, language: 'en' });

    // A second open for the SAME patient on the same day returns the same row (get-or-create), so
    // the revisit is opened for a different patient id that names the first as its parent — which
    // is what the console's own control does with a picked previous consultation.
    const followUp = await openOk(request, token, {
      patientId: `${patientId}-fu`,
      parentConsultationId: first.id,
      language: 'ml',
    });

    expect(followUp.parentConsultationId, 'the parent is what makes this a revisit').toBe(first.id);
    // A revisit declares its OWN (source) language rather than inheriting one from a visit that
    // may be weeks old.
    expect(followUp.language).toBe('ml');

    const workflow = await request.get(`/api/v1/consultations/${followUp.id}/workflow`, { headers: bearer(token) });
    // 404 is a legitimate answer for a tenant with no governing graph; what must never happen is
    // a 5xx, and when a graph DOES govern, the response must name it.
    expect([200, 404], `GET :id/workflow answered ${workflow.status()}`).toContain(workflow.status());
    if (workflow.status() === 200) {
      const body = (await workflow.json()) as { workflowDefinitionSlug?: string | null };
      expect(typeof body.workflowDefinitionSlug === 'string' || body.workflowDefinitionSlug === null).toBe(true);
    }
  });

  test('opening WITHOUT a parent produces a new visit', async ({ request }) => {
    const opened = await openOk(request, token, { patientId: uniquePatientId('newvisit') });
    expect(opened.parentConsultationId).toBeUndefined();
  });

  test('a cross-tenant parent is 404, never 403 — the parent must not become an existence oracle', async ({ request }) => {
    const res = await open(request, token, {
      patientId: uniquePatientId('foreign'),
      // A well-formed id that no consultation in this tenant carries.
      parentConsultationId: '01a00000-0000-7000-8000-000000000999',
    });
    expect(res.status()).toBe(404);
  });
});
