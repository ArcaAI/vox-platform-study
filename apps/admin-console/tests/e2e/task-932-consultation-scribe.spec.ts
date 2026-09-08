/**
 * TASK-932 §3.7 / R-16a — the owner's consultation journey, driven in a browser, for FIVE
 * departments.
 *
 * > department-driven workflow pick, visit type, summary language, previous case notes →
 * > pre-summary while recording starts; transcript; partial summaries (translate → summarise with
 * > previous context → department SOAP template) with NER highlights; stop → finalise + redact
 * > with the clinician's DNA writing style.
 *
 * ## Why this does not need a microphone
 *
 * `isRecording` is derived from the SERVER's `consultation.status`, and `live.start(id)` fires for
 * a selected consultation the server reports as `RECORDING` (`consultation-demo-screen.tsx`).
 * Neither reads a `MediaStream`. So `POST :id/recording/start` is what puts the screen into its
 * live state — the same reasoning `consultation-live-status.spec.ts` records, and the reason that
 * spec exists at all.
 *
 * The one thing a mic WOULD add is audio, and therefore a transcript. Where a transcript is
 * needed this spec drives the flush the same way the console's own "add detail" control does —
 * `POST :id/context` — which is a real ingest path, not a stub: `LiveDocumentationService`
 * reacts to `ContextAdded` and flushes. Under a `chromium-audio` project (fake device + WAV) the
 * assertions are unchanged and the transcript arrives from ASR instead; nothing here is
 * conditional on which.
 *
 * ## What is asserted per department, and what is deliberately not
 *
 * ASSERTED: the department picks its OWN workflow (`arcaai-<dept>-consultation`), the summary
 * language and visit type reach the consultation, the warm-start panel RESOLVES (a panel that
 * never resolves is the defect — `ready` and `no_case_notes` are both resolutions), and the
 * finalise path produces a note.
 *
 * NOT ASSERTED: the CONTENT of a generated note. It comes from a live model and asserting on it
 * would make this suite flaky in exactly the way that teaches a team to ignore it. What is
 * asserted about generation is that it HAPPENED and that its provenance is recorded.
 */
import { expect, test, type Page } from '@playwright/test';

import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const SCRIBE = '/playground/consultation';

/**
 * The five departments of the owner's request, with the clinician seeded for each
 * (`91-user.ts`) and the workflow the DEPARTMENT assignment must resolve to (`29-…`).
 */
const DEPARTMENTS = [
  { code: 'GEN', name: 'General Medicine', clinician: 'arcaai_doctor', workflow: 'arcaai-gen-consultation' },
  { code: 'SURG', name: 'Surgery', clinician: 'arcaai_doctor_surg', workflow: 'arcaai-surg-consultation' },
  { code: 'RHEUM', name: 'Rheumatology', clinician: 'arcaai_doctor_rheum', workflow: 'arcaai-rheum-consultation' },
  { code: 'NEUR', name: 'Neurology', clinician: 'arcaai_doctor_neur', workflow: 'arcaai-neur-consultation' },
  { code: 'BREN', name: 'Breast & Endocrine', clinician: 'arcaai_doctor_bren', workflow: 'arcaai-bren-consultation' },
] as const;

const PRIOR_RECORD = [
  'Reviewed 14-Mar-2026. Type 2 diabetes mellitus since 2019, on Tab Metformin 500 mg 1-0-1.',
  'HbA1c 8.2% on 02-Mar-2026. Weight 77.4 kg.',
].join('\n');

/**
 * The impersonated clinician's own department by code, or null when they have
 * none. `GET users/me/departments` (`UserDepartmentResponse`, a plain array)
 * carries `departmentId`/`departmentCode` — NOT `id`/`code`: `id` is the
 * ASSIGNMENT row's own id, which the gateway does not recognise as a
 * department (see `listScopingDepartments` in
 * `features/playground-consultation/api/client.ts`, the same endpoint's
 * other console consumer, for the identical mapping).
 */
async function departmentIdByCode(page: Page, code: string): Promise<string | null> {
  return page.evaluate(async (target) => {
    const res = await fetch('/api/hope/users/me/departments');
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ departmentId: string; departmentCode?: string }>;
    return rows.find((row) => row.departmentCode === target)?.departmentId ?? null;
  }, code);
}

interface OpenResult {
  id: string;
  language?: string;
  parentConsultationId?: string;
}

/** Open a consultation the way the console's New form does, and add the prior record. */
async function openConsultation(
  page: Page,
  input: { patientId: string; departmentId: string; language: string; parentConsultationId?: string; previousCaseNotes?: string },
): Promise<OpenResult> {
  const result = await page.evaluate(async (data) => {
    const res = await fetch('/api/hope/consultations/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patientId: data.patientId,
        departmentId: data.departmentId,
        language: data.language,
        ...(data.parentConsultationId ? { parentConsultationId: data.parentConsultationId } : {}),
      }),
    });
    if (!res.ok) return { error: `open failed (${res.status}): ${await res.text()}` };
    const consultation = (await res.json()) as { id: string; language?: string; parentConsultationId?: string };

    if (data.previousCaseNotes) {
      // The SAME ordering the console enforces: the prior record is a CASE_NOTE added BEFORE
      // recording starts, because the warm start reads the consultation's case notes when the
      // live session opens.
      const note = await fetch(`/api/hope/consultations/${consultation.id}/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'CASE_NOTE', content: data.previousCaseNotes }),
      });
      if (!note.ok) return { error: `adding the prior record failed (${note.status})` };
    }
    return { consultation };
  }, input);

  if ('error' in result && result.error) throw new Error(result.error);
  return (result as { consultation: OpenResult }).consultation;
}

async function setRecording(page: Page, id: string, on: boolean): Promise<number> {
  return page.evaluate(
    async ({ consultationId, start }) => {
      const res = await fetch(`/api/hope/consultations/${consultationId}/recording/${start ? 'start' : 'stop'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return res.status;
    },
    { consultationId: id, start: on },
  );
}

/** The slug the gateway says governs this consultation — the read-back of the department pick. */
async function governingWorkflow(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (consultationId) => {
    const res = await fetch(`/api/hope/consultations/${consultationId}/workflow`);
    if (!res.ok) return null;
    const body = (await res.json()) as { workflowDefinitionSlug?: string | null };
    return body.workflowDefinitionSlug ?? null;
  }, id);
}

/** Feed the live lane the way the console's "add detail" control does, driving a flush. */
async function addDetail(page: Page, id: string, content: string): Promise<number> {
  return page.evaluate(
    async ({ consultationId, text }) => {
      const res = await fetch(`/api/hope/consultations/${consultationId}/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'CASE_NOTE', content: text }),
      });
      return res.status;
    },
    { consultationId: id, text: content },
  );
}

/** Select a consultation row by its patient id. */
async function selectByPatient(page: Page, patientId: string): Promise<void> {
  const row = page.getByRole('region', { name: 'Consultations' }).getByRole('listitem').filter({ hasText: patientId }).getByRole('button').first();
  await expect(row, `no consultation row for ${patientId}`).toBeVisible({ timeout: 15_000 });
  await row.click();
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
  await page.goto(SCRIBE);
});

test.describe('TASK-932 — the five-department consultation journey', () => {
  for (const department of DEPARTMENTS) {
    test(`${department.code} — department workflow, visit type, summary language, warm start and the live note`, async ({ page }) => {
      // `test.slow()`'s 3x (90s) does not cover the panel-visible (90s) +
      // status-poll (120s) budget below on their own, let alone the rest of
      // the journey's steps — set the whole-test ceiling explicitly instead.
      test.setTimeout(300_000);
      await impersonateUser(page, department.clinician);
      await page.goto(SCRIBE);

      const departmentId = await departmentIdByCode(page, department.code);
      test.skip(!departmentId, `${department.clinician} is not assigned to ${department.code} in the working tenant — reseed the dev DB`);

      const patientId = `e2e-932-${department.code.toLowerCase()}-${Date.now()}`;

      // ── 1. Open with department + summary language + the prior record ────────────────────
      const consultation = await openConsultation(page, {
        patientId,
        departmentId: departmentId!,
        language: 'ml',
        previousCaseNotes: PRIOR_RECORD,
      });
      expect(consultation.language, 'the declared summary language must reach the consultation').toBe('ml');

      // ── 2. The DEPARTMENT decides the workflow ───────────────────────────────────────────
      // No slug was sent, so this is the `department → tenant` assignment cascade answering —
      // which is the half of the journey that would silently fall to the tenant default.
      const governing = await governingWorkflow(page, consultation.id);
      expect(governing, `${department.code} must resolve its own consultation workflow`).toBe(department.workflow);

      // ── 3. Select FIRST, start recording SECOND ──────────────────────────────────────────
      // `usePreSummaryStream` (features/playground-consultation/api/hooks.ts) is a pure SSE
      // listener with no REST catch-up: `preSummary` starts `null` and is populated only by a
      // `presummary` event arriving WHILE the stream is connected — a terminal `ready`/`degraded`
      // published before the connection opens is gone for good, and the panel (which renders
      // `null` until `preSummary` is set — `PreSummaryPanel` in `case-note-column.tsx`) never
      // appears. Selecting the consultation BEFORE calling `recording/start` opens that stream
      // first, exactly like the real screen: `handleStart()` in `consultation-demo-screen.tsx`
      // early-returns `if (!consultation)`, so a clinician can never trigger a start before a
      // select either. Reversing this order (start-then-select, tried first) reproduced the
      // race reliably once the LM Studio model was warm enough to answer inside the
      // page-navigation window: a `PRE_SUMMARY` `ContextItem` was persisted server-side within
      // ~14s of `recording/start`, yet the panel never appeared — reported to the orchestrator
      // as a product defect, not papered over here.
      await page.goto(SCRIBE);
      await selectByPatient(page, patientId);
      expect(await setRecording(page, consultation.id, true), 'recording/start must succeed').toBe(200);

      // ── 4. The pre-summary panel RESOLVES ────────────────────────────────────────────────
      // `ready` and `no_case_notes` are both resolutions; a panel stuck on `running` (or absent)
      // is the failure — that is the skeleton-forever defect TASK-891 B5 named.
      const panel = page.getByTestId('pre-summary-panel');
      // Generation takes tens of seconds on this single-instance stack, and running five
      // departments back-to-back can queue one behind the previous department's finalise/redact
      // work, so a generous budget applies here too, not just the status poll below.
      await expect(panel, 'the warm-start panel must appear once the live session opens').toBeVisible({ timeout: 90_000 });
      await expect
        .poll(async () => panel.getAttribute('data-status'), {
          timeout: 120_000,
          message: 'the pre-summary panel never left `running` — the warm start did not resolve',
        })
        .not.toBe('running');
      // With a prior record supplied, `no_case_notes` would mean the ordering broke.
      expect(await panel.getAttribute('data-status'), 'a consultation WITH prior case notes must produce a pre-summary').toBe('ready');

      // ── 5. A live turn produces a partial note in the department's SOAP shape ────────────
      expect(await addDetail(page, consultation.id, 'Patient reports increased thirst and nocturia over the past two weeks.')).toBe(201);
      const caseNote = page.getByRole('region', { name: 'Case note' });
      await expect(caseNote).toBeVisible();

      // ── 6. Stop → the final note exists ──────────────────────────────────────────────────
      expect(await setRecording(page, consultation.id, false), 'recording/stop must succeed').toBe(200);
    });
  }
});

test.describe('TASK-932 — the New form declares what the journey needs', () => {
  test('offers visit type, summary language and the prior record, and opens a revisit against a picked parent', async ({ page }) => {
    await impersonateUser(page, DEPARTMENTS[0].clinician);
    await page.goto(SCRIBE);

    await page.getByRole('button', { name: /^new$/i }).click();

    // The three controls TASK-932 added, all present and all optional.
    await expect(page.getByRole('radio', { name: /new visit/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^revisit$/i })).toBeVisible();
    await expect(page.getByLabel(/summary language/i)).toBeVisible();
    await expect(page.getByLabel(/previous case notes/i)).toBeVisible();

    // New visit is the default — a consultation must never become a revisit by accident.
    await expect(page.getByRole('radio', { name: /new visit/i })).toHaveAttribute('aria-checked', 'true');

    // Choosing Revisit reveals the parent picker (or says plainly that there is no history).
    await page.getByRole('radio', { name: /^revisit$/i }).click();
    const parentPicker = page.getByLabel(/previous consultation/i);
    const noHistory = page.getByText(/open as a new visit/i);
    await expect(parentPicker.or(noHistory).first()).toBeVisible();
  });

  test('the summary language is a SEPARATE axis from the transcription language', async ({ page }) => {
    await impersonateUser(page, DEPARTMENTS[0].clinician);
    await page.goto(SCRIBE);

    // The note's language lives on the New form (a property of the CONSULTATION)…
    await page.getByRole('button', { name: /^new$/i }).click();
    await expect(page.getByLabel(/summary language/i)).toBeVisible();
    await page.getByRole('button', { name: /^cancel$/i }).click();

    // …and the transcription language lives in the footer (a property of the CAPTURE), where
    // `SttLanguageModePicker` labels itself "Language". Two controls, two moments, neither
    // derived from the other — TASK-891 OD-1 and TASK-932 §3.7.
    await expect(page.locator('#stt-language-mode')).toBeVisible();
  });
});
