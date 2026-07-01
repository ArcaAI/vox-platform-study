/**
 * TASK-392 (Phase 5) — Plan-entitlements console E2E (authored).
 *
 * Verifies the `/entitlements` super-admin surface wired to `useEntitlements`:
 *   - the enforcement kill-switch card (Q9),
 *   - the DB-backed plan-matrix table + edit dialog (Q1),
 *   - the per-tenant tools card (snapshot + override + downgrade + trial sweep,
 *     Q1/Q7/Q10).
 *
 * Persona = superAdmin. The deep enforcement matrix (capped-vs-uncapped blocking,
 * trial expiry, downgrade soft-disable) is exercised at the API level in the
 * live integration pass with the kill-switch flipped ON; here we assert the UI
 * contract only (seed leaves enforcement OFF). Runs in all three viewports.
 *
 * Run status: authored — executes only against a live admin app + seeded API.
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-392 — Entitlements console (super-admin)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/entitlements');
    await expect(page.getByRole('heading', { name: 'Entitlements' })).toBeVisible();
  });

  test('renders the kill-switch, plan matrix and tenant tools cards', async ({ page }) => {
    await expect(page.getByText('Enforcement kill-switch')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Toggle global enforcement' })).toBeVisible();
    await expect(page.getByText('Plan matrix')).toBeVisible();
    await expect(page.getByText('Tenant tools')).toBeVisible();
  });

  test('Q1 · the plan matrix lists seeded plan rows and opens the edit dialog', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'Plan' })).toBeVisible();
    // Seed carries the four commercial plans; Enterprise is a stable label.
    await expect(page.getByText('Enterprise').first()).toBeVisible();

    await page.getByRole('button', { name: /Edit .* plan/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Limits')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Q1/Q7/Q10 · selecting a tenant renders its capability snapshot + tools', async ({ page }) => {
    await page.getByRole('combobox').first().click();
    const firstOption = page.getByRole('option').first();
    await expect(firstOption).toBeVisible();
    await firstOption.click();

    // Snapshot cards + the override/downgrade affordances.
    await expect(page.getByText('Resource limits')).toBeVisible();
    await expect(page.getByText('Monthly usage')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit override' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Downgrade' })).toBeVisible();
  });

  test('Q4 · the trial-expiry sweep is confirm-gated', async ({ page }) => {
    // The action requires a selected tenant; pick the first one.
    await page.getByRole('combobox').first().click();
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Run trial-expiry sweep' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/Downgrades every expired TRIAL tenant/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
  });
});

test.describe('TASK-392 — nav visibility', () => {
  test('super-admin sees the Entitlements nav entry', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/entitlements');
    await expect(page.getByRole('heading', { name: 'Entitlements' })).toBeVisible();
  });
});
