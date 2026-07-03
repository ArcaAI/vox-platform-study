/**
 * TASK-383 — Platform Dashboard + Monitoring (frontend E2E).
 *
 * Browser-driven, full-stack checks for the two super-admin platform surfaces:
 *   - `/dashboard`     (frame 10) — headline + secondary KPIs, focal consultation
 *                       chart with Week/Month/Year + tenant-scope controls.
 *   - `/system-health` (frame 11) — throughput KPIs, request-volume chart (REAL
 *                       series since TASK-404, honest empty state when Prometheus
 *                       is absent), Services + Models & running-tasks tables.
 * Plus the KPI **1→2→4 reflow** across the desktop/tablet/mobile viewport projects.
 *
 * Scope notes (per TASK-383 review brief):
 *   - Generic responsive primitives (shell icon-rail/drawer, grid→card-list) are
 *     owned by TASK-384 and are deliberately NOT asserted here — only this
 *     surface's own KPI reflow is.
 *   - TARGET tiles (transcription-min/summaries/storage; requests-min/error-rate/
 *     sockets; P95; per-model running/latency) render an em-dash / empty-state
 *     and are asserted as present-but-target, never as fabricated numbers.
 *
 * Run requires a seeded stack (see e2e/README.md); discover without a stack via
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts --list
 */
import { test, expect } from './fixtures/auth';
import type { Locator } from '@playwright/test';

/** Two boxes share a row when their vertical centers are within half a card height. */
async function sameRow(a: Locator, b: Locator): Promise<boolean> {
  const [ba, bb] = [await a.boundingBox(), await b.boundingBox()];
  if (!ba || !bb) return false;
  return Math.abs(ba.y - bb.y) < ba.height / 2;
}

// DEF-1 RESOLVED by TASK-386 (Decision #4 / backend TD3). A super_admin with no
// tenant scope now gets cross-tenant consultations (200) instead of 400
// "Tenant ID is required" (regression-locked by the API e2e `PM7`), so the
// Platform Dashboard's cross-tenant ("All tenants") fan-out renders the KPIs +
// focal chart instead of an error card. The three frame-10 cases below are
// therefore un-`fixme`d and run live across all three viewport projects.
test.describe('TASK-383 — platform dashboard (frame 10)', () => {
  test.beforeEach(async ({ loginAs }) => {
    await loginAs('superAdmin');
  });

  test('headline + secondary KPIs and the consultation chart render', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Platform Dashboard', level: 2 })).toBeVisible();

    // Headline KPIs (REAL — sourced from tenants/sessions/health).
    for (const label of ['Active tenants', 'Live sessions', 'Processing jobs', 'Degraded services']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    // Secondary row — Total users is REAL; the other three are flagged TARGET.
    await expect(page.getByText('Total users', { exact: true })).toBeVisible();
    await expect(page.getByText('Transcription min · 24h')).toBeVisible();
    await expect(page.getByText('Storage used', { exact: true })).toBeVisible();

    // Focal chart renders as an accessible image (buckets exist even for 0 sessions).
    await expect(page.getByRole('img', { name: /Consultation sessions per day/i })).toBeVisible();
  });

  test('chart exposes Week/Month/Year presets + a super-admin tenant-scope filter', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('group', { name: /date range preset/i })).toBeVisible();
    // Super-admin-only cross-link: scope the view to a single tenant's overview.
    await expect(page.getByRole('combobox', { name: 'Scope to a tenant dashboard' })).toBeVisible();
  });

  test('headline KPI row reflows 1→2→4 across mobile/tablet/desktop', async ({ page }, testInfo) => {
    await page.goto('/dashboard');
    const cards = page.locator('[data-slot="stat-card"]');
    await expect(cards.first()).toBeVisible();

    const card0 = cards.nth(0); // Active tenants
    const card1 = cards.nth(1); // Live sessions
    const card3 = cards.nth(3); // Degraded services (4th headline tile)

    if (testInfo.project.name === 'mobile') {
      // 1-up (< 640): tile 1 sits BELOW tile 0.
      const [b0, b1] = [await card0.boundingBox(), await card1.boundingBox()];
      expect(b0 && b1).toBeTruthy();
      expect(b1!.y).toBeGreaterThan(b0!.y + b0!.height / 2);
    } else if (testInfo.project.name === 'tablet') {
      // 2-up (640–1279): tiles 0 & 1 share a row; tile 3 wraps to the next row.
      expect(await sameRow(card0, card1)).toBe(true);
      const [b0, b3] = [await card0.boundingBox(), await card3.boundingBox()];
      expect(b3!.y).toBeGreaterThan(b0!.y + b0!.height / 2);
    } else {
      // desktop (≥ 1280, project is 1280 wide): 4-up — tiles 0 & 3 share one row.
      expect(await sameRow(card0, card1)).toBe(true);
      expect(await sameRow(card0, card3)).toBe(true);
    }
  });
});

test.describe('TASK-383 — monitoring (frame 11)', () => {
  test.beforeEach(async ({ loginAs }) => {
    await loginAs('superAdmin');
  });

  test('throughput KPIs, Services + Models tables render; request-volume is series-or-honest-empty', async ({ page }) => {
    await page.goto('/system-health');
    await expect(page.getByRole('heading', { name: 'Service Monitoring', level: 2 })).toBeVisible();

    // Throughput KPIs are all TARGET — present as labels (values render em-dash).
    for (const label of ['Requests / min', 'Error rate', 'Sockets / min', 'Total sockets']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // REAL service-health + grounded model inventory tables.
    await expect(page.getByRole('table', { name: 'Service health' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Models and running tasks' })).toBeVisible();
    // Grounded model identity (REAL) — never fabricated runtime numbers.
    await expect(page.getByText('whisper-large-v3-turbo')).toBeVisible();

    // TASK-404 — request-volume is REAL (TASK-386 E1): renders the series chart
    // when Prometheus reports, else the honest empty state. Exactly one of the two.
    const realChart = page.getByRole('img', { name: /Requests and open sockets per minute/ });
    const emptyState = page.getByText('No request-volume samples');
    await expect(realChart.or(emptyState).first()).toBeVisible();
  });

  test('Services table lists the canonical microservices', async ({ page }) => {
    await page.goto('/system-health');
    const services = page.getByRole('table', { name: 'Service health' });
    await expect(services).toBeVisible();
    // Canonical order API · STT · SMR · NLP · Guardrail · Harness (buildServiceRows).
    for (const name of ['API', 'SMR', 'Guardrail', 'Harness']) {
      await expect(services.getByText(name, { exact: true })).toBeVisible();
    }
  });
});
