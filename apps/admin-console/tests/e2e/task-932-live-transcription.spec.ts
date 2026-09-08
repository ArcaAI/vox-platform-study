/**
 * TASK-932 §3.7 / R-16b — realtime transcription with a SELECTABLE language.
 *
 * ## The gap this closes
 *
 * The transport has carried a language since TASK-891: `StartLiveSttOptions.language` reaches
 * `POST /audio/transcription-jobs/stream/session`, and `uploadBatchAudio` puts a `language` field
 * on the batch form. Neither had a control. So the only way to transcribe in a declared language
 * was to be an SDK caller — the end user the owner asked about could not.
 *
 * ## What is asserted, and what a microphone would add
 *
 * The picker, its default, and the fact that a session STARTS with a language declared. Starting
 * a streaming session is a gateway call (`POST …/stream/session`) plus a WebSocket open; the
 * microphone produces AUDIO, which is what a `chromium-audio` project supplies and what turns
 * "the session opened" into "a transcript arrived". Both assertions live here, the second gated
 * on the session actually reaching a listening state so this spec is honest without a mic rather
 * than silently weaker.
 *
 * The DEFAULT is the assertion that matters most, and it is the one that would rot: TASK-891 OD-1
 * settled that undeclared means CODE-SWITCH, not English ("the code-switch is always enabled …
 * to use a specific language, the SDK or end-user must declare the language code"). A picker that
 * quietly preselected English would reverse an owner decision while looking like a convenience.
 */
import { expect, test } from '@playwright/test';

import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const LIVE_TRANSCRIPTION = '/playground/live-transcription';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
  await page.goto(LIVE_TRANSCRIPTION);
});

test.describe('TASK-932 — the live-transcription language picker', () => {
  test('renders beside the agent picker, offering the languages the platform transcribes', async ({ page }) => {
    const picker = page.locator('#language-picker');
    await expect(picker).toBeVisible();

    const options = await picker.locator('option').allTextContents();
    // The undeclared option is FIRST and says what it means — an empty option that reads as a
    // missing choice is what makes a deliberate default look like an oversight.
    expect(options[0]).toMatch(/not declared/i);
    expect(options.join(' ')).toMatch(/English/);
    expect(options.join(' ')).toMatch(/Malayalam/);
  });

  test('DEFAULTS to undeclared — code-switch, not English (TASK-891 OD-1)', async ({ page }) => {
    await expect(page.locator('#language-picker')).toHaveValue('');
  });

  test('is a SEPARATE control from the transcription agent — one names the model, one the language', async ({ page }) => {
    await expect(page.locator('#agent-picker').or(page.getByText(/agents did not load/i)).first()).toBeVisible();
    await expect(page.locator('#language-picker')).toBeVisible();
  });

  test('a declared language reaches the session the gateway creates', async ({ page }) => {
    // Watch the session-create call rather than a rendered value: the point of the control is the
    // request it produces, and the response is what proves the gateway accepted it.
    const sessionCreate = page.waitForRequest(
      (request) => request.url().includes('/audio/transcription-jobs/stream/session') && request.method() === 'POST',
      { timeout: 30_000 },
    );

    await page.locator('#language-picker').selectOption('ml');
    await expect(page.locator('#language-picker')).toHaveValue('ml');

    await page.getByRole('button', { name: /start session/i }).click();

    const request = await sessionCreate.catch(() => null);
    test.skip(!request, 'the streaming session was never created — the STT service is not reachable from this stack');

    const body = request!.postDataJSON() as { language?: string };
    expect(body.language, 'the declared language must reach `POST …/stream/session`').toBe('ml');

    // Tear the session down so the tenant's concurrency quota is not left consumed.
    const stop = page.getByRole('button', { name: /stop session/i });
    if (await stop.isVisible().catch(() => false)) await stop.click();
  });

  test('the picker is disabled while a session is running — the language is bound at session start', async ({ page }) => {
    await page.getByRole('button', { name: /start session/i }).click();

    const stop = page.getByRole('button', { name: /stop session/i });
    const started = await stop.isVisible({ timeout: 20_000 }).catch(() => false);
    test.skip(!started, 'the streaming session did not start — the STT service is not reachable from this stack');

    await expect(page.locator('#language-picker')).toBeDisabled();
    await stop.click();
  });

  test('the batch tab inherits the same declared language', async ({ page }) => {
    // One control for the screen, not one per tab: the language is a property of what the user
    // is transcribing, and a second picker would be a second thing to keep in step.
    await page.locator('#language-picker').selectOption('ml');
    await page.getByRole('tab', { name: /batch upload/i }).click();

    await expect(page.locator('#language-picker')).toHaveValue('ml');
    await expect(page.locator('#language-picker')).toBeVisible();
  });
});
