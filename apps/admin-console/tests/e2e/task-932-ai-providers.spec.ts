/**
 * `/ai-providers` — the working tenant decides the scope (TASK-932 R-3/R-11/R-12).
 *
 * WHAT THESE PIN THAT A UNIT TEST CANNOT. The unit suite stubs `fetch`, so it
 * proves the screen reacts correctly to a session and a payload. It cannot prove
 * that the SESSION COOKIE the shell actually writes produces the platform tier,
 * that the gateway serves the built-in engine rows to a platform admin and hides
 * them from a tenant, or that `POST …/reset` really restores the seeded
 * endpoint. Those are three separate systems agreeing, and the only place they
 * meet is a running stack.
 *
 * Skip-gated on the stack, like every spec in this suite.
 */

import { expect, test, type Page } from '@playwright/test';
import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

/**
 * Clear the elevated session's working tenant — the state that puts this screen
 * on the PLATFORM tier. No shared helper exists because no other spec needed
 * "no tenant selected" to be a meaningful state; here it is the subject.
 * Runs inside the page for the same cookie reason `selectWorkingTenant` does.
 */
async function clearWorkingTenant(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/auth/working-tenant', { method: 'DELETE' });
    return response.ok ? null : `Failed to clear the working tenant (${response.status})`;
  });
  if (result) throw new Error(result);
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

test.describe('AI providers — platform tier (no working tenant)', () => {
  test.beforeEach(async ({ page }) => {
    await clearWorkingTenant(page);
    await page.goto('/ai-providers');
    await expect(page.getByRole('heading', { level: 1, name: 'AI providers' })).toBeVisible();
  });

  test('shows the three platform sections and NO scope toggle', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 2, name: 'Built-in inference services' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Platform default cloud connections' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Model registry (built-in)' })).toBeVisible();

    // The R-12 removal: tenancy is answered in ONE place, the shell switcher.
    await expect(page.getByRole('radio', { name: /Platform default/ })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Configuration tier' })).toHaveCount(0);
  });

  test('renders the built-in engines and the weight store, with platform wording', async ({ page }) => {
    for (const engine of ['LM Studio', 'Ollama', 'vLLM', 'llama.cpp']) {
      await expect(page.getByRole('heading', { level: 3, name: engine })).toBeVisible();
    }

    const weightStore = page.getByRole('heading', { level: 3, name: 'S3 / MinIO weight store' });
    await expect(weightStore).toBeVisible();

    // R-11: the defect was tenant wording on a platform row. Whatever state the
    // row is in, it must never claim to be disabled "for this tenant".
    // `[aria-labelledby]` also matches the ANCESTOR `<section>` this card sits
    // in (itself labelled by its own h2) — `.last()` is the innermost match,
    // the card itself, in DOM order.
    const card = page.locator('[aria-labelledby]').filter({ has: weightStore }).last();
    await expect(card).not.toContainText('Disabled for this tenant');
  });

  test('saves an LM Studio endpoint and then resets it to the built-in default', async ({ page }) => {
    // `.last()`: the innermost `[aria-labelledby]` match is the card, not its
    // ancestor `<section>` (see the comment above).
    const card = page.locator('[aria-labelledby]').filter({ has: page.getByRole('heading', { level: 3, name: 'LM Studio' }) }).last();
    const endpoint = card.locator('input[id$="-baseUrl"]');
    await expect(endpoint).toBeVisible();

    const seeded = await endpoint.inputValue();

    // The local-development case from the owner's request: LM Studio on the
    // workstation rather than in the cluster.
    await endpoint.fill('http://localhost:1234/v1');
    await card.getByRole('button', { name: /^(Save|Save key|Rotate key & save) for LM Studio/ }).click();
    await expect(page.getByText('LM Studio connection saved')).toBeVisible();
    await expect(endpoint).toHaveValue('http://localhost:1234/v1');

    await card.getByRole('button', { name: 'Reset LM Studio to its built-in default' }).click();
    await card.getByRole('button', { name: 'Confirm reset' }).click();
    await expect(page.getByText('LM Studio restored to its built-in default')).toBeVisible();

    // Back to the SHIPPED default, which is the cluster Service address — and
    // therefore no longer whatever the operator typed.
    await expect(endpoint).not.toHaveValue('http://localhost:1234/v1');
    // Restore whatever the environment was seeded with, so this spec leaves the
    // dev stack usable for the specs that actually call an LLM.
    if (seeded && seeded !== (await endpoint.inputValue())) {
      await endpoint.fill(seeded);
      await card.getByRole('button', { name: /^(Save|Save key|Rotate key & save) for LM Studio/ }).click();
      await expect(page.getByText('LM Studio connection saved')).toBeVisible();
    }
  });
});

test.describe('AI providers — tenant tier (a working tenant selected)', () => {
  test('shows only bring-your-own cards, and no platform plane', async ({ page }) => {
    await selectWorkingTenant(page);
    await page.goto('/ai-providers');
    await expect(page.getByRole('heading', { level: 1, name: 'AI providers' })).toBeVisible();

    await expect(page.getByRole('heading', { level: 3, name: 'Azure OpenAI' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Built-in inference services' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'LM Studio' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'S3 / MinIO weight store' })).toHaveCount(0);

    // The capabilities with no vendor card are not offered as tabs either.
    await expect(page.getByRole('tab', { name: 'Model registry' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Rerank' })).toHaveCount(0);
  });

  test('an impersonated tenant admin sees the same tenant surface and no reset', async ({ page }) => {
    await selectWorkingTenant(page);
    await impersonateUser(page, 'arcaai_admin');
    await page.goto('/ai-providers');
    await expect(page.getByRole('heading', { level: 1, name: 'AI providers' })).toBeVisible();

    await expect(page.getByRole('heading', { level: 3, name: 'Azure OpenAI' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reset .* to its built-in default/ })).toHaveCount(0);
  });
});
