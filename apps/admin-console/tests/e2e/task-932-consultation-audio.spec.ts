/**
 * TASK-932 R-16a — the owner's journey with a REAL microphone, end to end in the browser.
 *
 * > "when the clinician selects stop, it must finalize and redact the summary based on the
 * > clinician's DNA writing style"
 *
 * `task-932-consultation-scribe.spec.ts` drives the live lane through `POST :id/context`, which
 * is a real ingest path but not the one a clinician uses. This spec drives the one they do: the
 * `chromium-audio` project replays `fixtures/audio/cardiology_consult_01.wav` through Chromium's
 * fake capture device, so clicking **Start** opens the SDK's audio session and the transcript
 * arrives from ASR. That matters here because it is the only configuration in which the whole
 * chain — capture → STT → the realtime lane's summary and NER → stop → the LIVE HANDOFF → the
 * durable finalizer → the persisted note — is exercised by the same actions a clinician performs.
 *
 * ## What it pins, in order
 *
 *  1. the UI **Start** button opens capture and a transcript appears, containing a word from the
 *     recording's own ground truth (`cardiology_consult_01.gt.txt`) — not merely "some text";
 *  2. the realtime lane produces a SOAP section and at least one NER chip while recording;
 *  3. the UI **Stop** button finalizes: a draft note appears in the case-note column;
 *  4. the note carries DNA provenance — `structuredData.dnaStyleId` equal to the impersonated
 *     clinician's own report id.
 *
 * (4) is the assertion the ticket exists for. Before this fix the durable finalizer resolved
 * `bound_inputs: {}` and degraded "core.agent: nothing bound on `in`/`context` to generate from"
 * on every consultation, so the column stayed empty and no `SummaryMeta` was ever written.
 *
 * ## Why it is skip-gated rather than allowed to fail
 *
 * It needs the console, the gateway, STT with a loaded model, TEXT, the harness worker and
 * Temporal. A missing one is a stack fact, not a regression, so the spec SKIPS with a named
 * reason — the same posture every other spec in this directory takes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const SCRIBE = '/playground/consultation';
const CLINICIAN = 'arcaai_doctor';
const DEPARTMENT_CODE = 'GEN';

/** The recording's own transcript, beside the WAV. Words come from HERE, never invented. */
const GROUND_TRUTH = readFileSync(path.resolve(__dirname, 'fixtures/audio/cardiology_consult_01.gt.txt'), 'utf8');

/**
 * Distinctive, clinically-specific words from that ground truth. Chosen so a match cannot be
 * satisfied by filler: an ASR that returns "the patient is" for any audio would fail this.
 */
const GROUND_TRUTH_WORDS = ['troponin', 'electrocardiogram', 'aspirin', 'angina', 'auscultation'].filter((word) =>
  GROUND_TRUTH.toLowerCase().includes(word),
);

const TRANSCRIPT_TIMEOUT_MS = 120_000;
const FINALIZE_TIMEOUT_MS = 180_000;

/** The impersonated clinician's own department id by code, or null. */
async function departmentIdByCode(page: Page, code: string): Promise<string | null> {
  return page.evaluate(async (target) => {
    const res = await fetch('/api/hope/users/me/departments');
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ departmentId: string; departmentCode?: string }>;
    return rows.find((row) => row.departmentCode === target)?.departmentId ?? null;
  }, code);
}

/** The clinician's OWN DNA report id, read as that clinician. */
async function myDnaReportId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch('/api/hope/dna-writing-styles/my-style');
    if (!res.ok) return null;
    return ((await res.json()) as { id?: string }).id ?? null;
  });
}

async function openConsultation(page: Page, input: { patientId: string; departmentId: string }): Promise<string> {
  const result = await page.evaluate(async (data) => {
    const res = await fetch('/api/hope/consultations/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patientId: data.patientId, departmentId: data.departmentId, language: 'en' }),
    });
    if (!res.ok) return { error: `open failed (${res.status}): ${await res.text()}` };
    return { id: ((await res.json()) as { id: string }).id };
  }, input);
  if ('error' in result && result.error) throw new Error(result.error);
  return (result as { id: string }).id;
}

interface LatestSummary {
  id: string;
  content: string;
  structuredData?: { dnaStyleId?: string };
}

async function latestSummary(page: Page, consultationId: string): Promise<LatestSummary | null> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/hope/consultations/${id}/summary/latest`);
    if (!res.ok) return null;
    return (await res.json()) as { id: string; content: string; structuredData?: { dnaStyleId?: string } };
  }, consultationId);
}

async function selectByPatient(page: Page, patientId: string): Promise<void> {
  const row = page.getByRole('region', { name: 'Consultations' }).getByRole('listitem').filter({ hasText: patientId }).getByRole('button').first();
  await expect(row, `no consultation row for ${patientId}`).toBeVisible({ timeout: 15_000 });
  await row.click();
}

test.describe('TASK-932 R-16a — stop finalizes, with a real microphone', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    await selectWorkingTenant(page);
    await page.goto(SCRIBE);
  });

  test('capture → transcript → SOAP + entities → stop → a finalized note with DNA provenance', async ({ page }) => {
    test.setTimeout(420_000);

    await impersonateUser(page, CLINICIAN);
    await page.goto(SCRIBE);

    const departmentId = await departmentIdByCode(page, DEPARTMENT_CODE);
    test.skip(!departmentId, `${CLINICIAN} is not assigned to ${DEPARTMENT_CODE} in the working tenant — reseed the dev DB`);

    const dnaReportId = await myDnaReportId(page);
    test.skip(!dnaReportId, `${CLINICIAN} has no DNA writing-style report — reseed the dev DB`);
    expect(GROUND_TRUTH_WORDS.length, 'the ground-truth fixture must supply at least one distinctive word').toBeGreaterThan(0);

    const patientId = `e2e-932-audio-${Date.now()}`;
    const consultationId = await openConsultation(page, { patientId, departmentId: departmentId! });

    // Select BEFORE starting — the same ordering the real screen enforces (`handleStart()`
    // early-returns without a consultation) and the one that keeps the live SSE streams open
    // from the first event.
    await page.goto(SCRIBE);
    await selectByPatient(page, patientId);

    // ── 1. The UI Start button. This, not `POST :id/recording/start`, is what opens the SDK
    // audio session on the fake device — the difference this spec exists for.
    const start = page.getByRole('button', { name: /^start$/i });
    await expect(start, 'the Start control must be enabled for a selected, open consultation').toBeEnabled({ timeout: 15_000 });
    await start.click();
    await expect(page.getByRole('button', { name: /^stop$/i }), 'the session must enter its recording state').toBeVisible({ timeout: 30_000 });

    // ── 2. A transcript, carrying the recording's own words.
    const transcript = page.getByRole('log', { name: /live consultation transcript/i });
    await expect(transcript).toBeVisible();
    await expect
      .poll(
        async () => {
          const text = ((await transcript.textContent()) ?? '').toLowerCase();
          return GROUND_TRUTH_WORDS.some((word) => text.includes(word));
        },
        {
          timeout: TRANSCRIPT_TIMEOUT_MS,
          message: `no transcript row containing any of ${GROUND_TRUTH_WORDS.join(', ')} within ${TRANSCRIPT_TIMEOUT_MS}ms — is STT running with a loaded model?`,
        },
      )
      .toBe(true);

    // ── 3. The realtime lane: at least one SOAP section, and at least one NER chip.
    const caseNote = page.getByRole('region', { name: 'Case note' });
    await expect(caseNote).toBeVisible();
    const sections = caseNote.locator('[aria-label="Live documents"]').or(caseNote.getByRole('group', { name: 'Live running summary' }));
    await expect(sections.first(), 'the realtime lane must produce at least one SOAP section').toBeVisible({ timeout: TRANSCRIPT_TIMEOUT_MS });

    const entities = caseNote.getByRole('group', { name: /detected entities/i });
    await expect(entities.first(), 'the realtime lane must produce at least one NER chip').toBeVisible({ timeout: TRANSCRIPT_TIMEOUT_MS });

    // ── 4. Stop. Everything below is what R-16a asks for and what used to never happen.
    await page.getByRole('button', { name: /^stop$/i }).click();

    await expect
      .poll(async () => (await latestSummary(page, consultationId))?.content?.trim()?.length ?? 0, {
        timeout: FINALIZE_TIMEOUT_MS,
        message: `no finalized note within ${FINALIZE_TIMEOUT_MS}ms of stop — the consultation is stuck with an empty final note`,
      })
      .toBeGreaterThan(0);

    // ── 5. The note is the clinician's own, styled by their own report.
    const summary = await latestSummary(page, consultationId);
    expect(summary?.structuredData?.dnaStyleId, "the finalized note must name the clinician's own DNA report").toBe(dnaReportId);

    // And it is visible where a clinician reads it.
    await expect(caseNote.getByRole('article', { name: 'Personalized draft note' }), 'the finalized draft must render in the case-note column').toBeVisible({
      timeout: 60_000,
    });
  });
});
