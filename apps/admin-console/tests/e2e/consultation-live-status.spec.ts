/**
 * + DD-3 — the LIVE surface of the Consultation Scribe, against a
 * RUNNING gateway.
 *
 * WHY THIS FILE EXISTS. recorded D-18 (live status/error surfacing)
 * and DD-3 (N documents from `section.patch`) as unverifiable without "a
 * microphone-capable browser". That is not what the code does, and the
 * distinction matters because it is the reason these two sat unverified:
 *
 *   `isRecording` is derived from the SERVER's `consultation.status` —
 *   `(consultation?.status ?? '').toUpperCase() === 'RECORDING'`
 *   (`consultation-demo-screen.tsx`), and `live.start(id)` is called when a
 *   SELECTED consultation reports `RECORDING` (same file). Neither reads a
 *   `MediaStream`. `POST :id/recording/start` is therefore sufficient to put the
 *   screen into its live state, with no getUserMedia and no `apps/stt`.
 *
 * The mic is needed to produce AUDIO, which is a different claim from putting the
 * UI into its recording state. These specs exercise the latter, which is what
 * D-18 and DD-3 are about.
 */

import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const SCRIBE = '/playground/consultation';

/** A seeded clinician who owns consultations in the default working tenant. */
const CLINICIAN = 'doctor2';

/**
 * Impersonate by EXACT username.
 *
 * Deliberately not `helpers/auth.impersonateUser`: that helper searches with
 * `limit=1` and then requires an exact match, so any username that is a strict
 * prefix of another (`doctor` -> `doctor_med`) can never be found. Widening the
 * page size here keeps this spec honest without changing shared behaviour.
 */
async function impersonateExact(page: Page, username: string): Promise<void> {
  const failure = await page.evaluate(async (target) => {
    const search = await fetch(`/api/hope/admin/users?search=${encodeURIComponent(target)}&searchFields=username&limit=100`);
    if (!search.ok) return `Could not search users (${search.status})`;
    const body = (await search.json()) as { data?: Array<{ id: string; username: string }> };
    const user = body.data?.find((u) => u.username === target);
    if (!user) return `No seeded user named "${target}"`;
    const impersonate = await fetch('/api/auth/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    return impersonate.ok ? null : `Failed to impersonate (${impersonate.status})`;
  }, username);
  if (failure) throw new Error(failure);
}

/** The impersonated clinician's first consultation, or null when they have none. */
async function firstConsultationId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch('/api/hope/consultations?page=1&limit=1');
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return body.data?.[0]?.id ?? null;
  });
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

/** Click the consultation row the server has marked RECORDING. */
async function selectRecordingConsultation(page: Page): Promise<void> {
  const row = page
    .getByRole('region', { name: 'Consultations' })
    .getByRole('listitem')
    .filter({ hasText: 'Recording' })
    .getByRole('button')
    .first();
  await expect(row).toBeVisible();
  await row.click();
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
  await page.goto(SCRIBE);
  await impersonateExact(page, CLINICIAN);
});

test.describe('consultation scribe — live status surfacing (D-18)', () => {
  test('a RECORDING consultation opens the live surface before any snapshot has arrived', async ({ page }) => {
    await page.goto(SCRIBE);
    const id = await firstConsultationId(page);
    test.skip(!id, `${CLINICIAN} owns no consultation in this tenant — nothing to drive`);

    expect(await setRecording(page, id!, true)).toBe(201);
    await page.goto(SCRIBE);

    // Select it — the screen calls live.start() for a RECORDING consultation.
    // Target the LIST ITEM, not the region's first button (that is the
    // New/Cancel toggle), and pick the row the server marked Recording.
    await selectRecordingConsultation(page);

    // THE EMPTY-FIRST-FLUSH STATE: showLive is true (isRecording), the snapshot
    // is still null, and the header must say so rather than showing nothing.
    await expect(page.getByText('Note assistant drafting')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Case note' })).toContainText('Running SOAP');

    await setRecording(page, id!, false);
  });

  test('a DROPPED live stream surfaces the connection error, distinct from a generation failure', async ({ page }) => {
    await page.goto(SCRIBE);
    const id = await firstConsultationId(page);
    test.skip(!id, `${CLINICIAN} owns no consultation in this tenant — nothing to drive`);

    expect(await setRecording(page, id!, true)).toBe(201);

    // Break the SSE transport only — the gateway, the note assistant and every
    // other request stay healthy, which is exactly the case D-18 exists to
    // distinguish from `live.textFailed`.
    await page.route('**/live-summary/stream**', (route) => route.abort('failed'));

    await page.goto(SCRIBE);
    await selectRecordingConsultation(page);

    await expect(page.getByText(/Live update connection lost/)).toBeVisible({ timeout: 20_000 });

    await page.unroute('**/live-summary/stream**');
    await setRecording(page, id!, false);
  });
});

test.describe('consultation scribe — N documents from section.patch (DD-3)', () => {
  test('a flush renders the per-document, per-section live view with state badges', async ({ page }) => {
    // A flush calls the note assistant (a real LLM hop), so this case needs far
    // more than the 30s suite default — which otherwise caps the wait below and
    // reports a model that was merely slow as a missing element.
    test.setTimeout(150_000);
    // Read the gate BEFORE impersonating away from the admin session.
    await page.goto(SCRIBE);
    const id = await firstConsultationId(page);
    test.skip(!id, `${CLINICIAN} owns no consultation in this tenant — nothing to drive`);

    expect(await setRecording(page, id!, true)).toBe(201);
    await page.goto(SCRIBE);
    await selectRecordingConsultation(page);

    // A context item of a live-doc kind schedules a flush server-side — the
    // HTTP path into the same `flush()` the STT lane drives, with no audio.
    const contextStatus = await page.evaluate(async (consultationId) => {
      const res = await fetch(`/api/hope/consultations/${consultationId}/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'CASE_NOTE',
          content: 'Patient reports a persistent dry cough for three weeks, worse at night. Takes aspirin 75mg daily. BP 138/86. No fever.',
        }),
      });
      return res.status;
    }, id!);
    expect(contextStatus).toBe(201);

    // The flush calls the note assistant, so allow a generous budget.
    const liveDocuments = page.getByLabel('Live documents');
    const legacyLive = page.getByRole('group', { name: 'Live running summary' });
    await expect(liveDocuments.or(legacyLive).first()).toBeVisible({ timeout: 90_000 });

    if (await liveDocuments.isVisible()) {
      // DD-3 proper: per-section state, rendered as icon + text (never colour alone).
      await expect(liveDocuments.getByText(/provisional|confirmed|locked/i).first()).toBeVisible();
    } else {
      // The graph executor is the ONLY producer of section.patch; without it the
      // legacy single-document view is correct and DD-3 has nothing to assert.
      test.skip(true, 'graph executor is OFF for this tenant — section.patch is not emitted, so the legacy live view is what renders');
    }

    await setRecording(page, id!, false);
  });
});
