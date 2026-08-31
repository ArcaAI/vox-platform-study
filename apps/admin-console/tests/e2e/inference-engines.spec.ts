/**
 * LM Studio / vLLM / MLflow — the three platform AI-backend screens.
 *
 * These specs are written against the state the cluster is ACTUALLY in: all
 * three backends are undeployed (LM Studio and vLLM at zero replicas, MLflow
 * with no Ingress), so every assertion below must hold for an unreachable
 * backend. That is the point — a screen whose only tested path needs a running
 * engine is a screen nobody can verify today.
 *
 * The axe gate runs in BOTH themes per rule 11 §11, exactly as
 * `ai-models.spec.ts` does.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
});

const ENGINES = [
  { route: '/ai-services/lm-studio', heading: 'LM Studio' },
  { route: '/ai-services/vllm', heading: 'vLLM' },
] as const;

for (const engine of ENGINES) {
  test.describe(`${engine.heading} screen`, () => {
    test('renders the heading, the stat strip and the three operational tabs', async ({ page }) => {
      await page.goto(engine.route);
      await expect(page.getByRole('heading', { level: 1, name: engine.heading })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Server' })).toBeVisible();
      await expect(page.getByRole('tab', { name: /Models on server/ })).toBeVisible();
      await expect(page.getByRole('tab', { name: /Artifacts/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Probe now' })).toBeVisible();
    });

    test('states what it deliberately does not do, and offers no lifecycle control', async ({ page }) => {
      await page.goto(engine.route);
      await expect(page.getByText('Start / stop / restart is not available here')).toBeVisible();
      for (const name of [/^Start$/, /^Stop$/, /^Restart$/, /^Scale$/]) {
        await expect(page.getByRole('button', { name })).toHaveCount(0);
      }
    });

    test('resolves an unreachable engine into information, not a stuck screen', async ({ page }) => {
      await page.goto(engine.route);
      // Whatever the engine is doing, the screen must SETTLE: either it is
      // reachable, or the status region says why it is not. What must never
      // happen is a permanent loading state.
      await expect(page.getByRole('heading', { level: 1, name: engine.heading })).toBeVisible();
      const settled = page.getByRole('status', { name: 'Engine status' }).or(page.getByText('Reachable').first());
      await expect(settled.first()).toBeVisible();
    });

    test('lists model rows or an explicit empty state — never a blank panel', async ({ page }) => {
      await page.goto(`${engine.route}?tab=models`);
      const explained = page
        .getByText('The engine did not answer the probe')
        .or(page.getByText('This engine reported no models'))
        .or(page.getByRole('list'));
      await expect(explained.first()).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(engine.route);
      await expect(page.getByRole('heading', { level: 1, name: engine.heading })).toBeVisible();
      await expect(page.getByText('Start / stop / restart is not available here')).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(engine.route);
      await expect(page.getByRole('heading', { level: 1, name: engine.heading })).toBeVisible();
      await expect(page.getByText('Start / stop / restart is not available here')).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test('the Artifacts tab has no WCAG 2.2 AA violations', async ({ page }) => {
      await page.goto(`${engine.route}?tab=artifacts`);
      await expect(page.getByRole('tab', { name: /Artifacts/, selected: true })).toBeVisible();
      await expectNoA11yViolations(page);
    });
  });
}

test.describe('MLflow screen', () => {
  test('renders the heading and the four tabs', async ({ page }) => {
    await page.goto('/ai-services/mlflow');
    await expect(page.getByRole('heading', { level: 1, name: 'MLflow' })).toBeVisible();
    for (const name of [/Registered models/, /Model versions/, /Experiments/, /Access/]) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
  });

  /**
   * The load-bearing assertion of this file. MLflow frame-denies by default and
   * has no browser-reachable URL, so a frame must not be on the page — and the
   * screen must SAY why rather than leaving an empty box.
   */
  test('renders no iframe while the deployment blocks framing', async ({ page }) => {
    await page.goto('/ai-services/mlflow?tab=access');
    await expect(page.getByRole('region', { name: 'Embedding the MLflow interface' })).toBeVisible();
    await expect(page.getByText(/no authentication of its own/)).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('offers no destructive control — erasure belongs to the gc CronJob', async ({ page }) => {
    await page.goto('/ai-services/mlflow?tab=model-versions');
    for (const name of [/^Delete/, /^Archive/, /^Transition/, /^Promote/]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/ai-services/mlflow?tab=access');
    await expect(page.getByRole('region', { name: 'Embedding the MLflow interface' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/ai-services/mlflow?tab=access');
    await expect(page.getByRole('region', { name: 'Embedding the MLflow interface' })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
