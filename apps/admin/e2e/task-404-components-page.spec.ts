/**
 * TASK-404 P2-2 — `/components` design-system reference page.
 *
 * Proves the `01 · Components` showcase surface:
 *   - super-admin opens `/components` and every showcase group renders
 *     (tokens · typography · shape · status grammar · primitives · metrics),
 *   - the six semantic role cards and core primitive specimens are present,
 *   - the section anchor nav shows on md+ viewports and hides on mobile,
 *   - a tenant-admin deep-linking to `/components` is bounced off it
 *     (`requireSuperAdmin`, same defense-in-depth as task-394).
 *
 * Non-destructive: navigation + rendering only, no mutations.
 */
import { test, expect } from './fixtures/auth';

const SECTION_HEADINGS = ['Color tokens', 'Typography', 'Shape & spacing', 'Status grammar', 'Primitives', 'Metrics primitives'] as const;

test.describe('TASK-404 P2-2 — components library page', () => {
  test('super-admin sees the full showcase (all six groups)', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/components');
    await page.waitForURL('**/components', { timeout: 15_000 });

    await expect(page.getByRole('heading', { name: 'Components', exact: true })).toBeVisible();
    for (const heading of SECTION_HEADINGS) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }

    // Six semantic role cards (primary/ai/hope/success/warning/destructive).
    await expect(page.locator('[data-slot="role-card"]')).toHaveCount(6);
    await expect(page.getByText('--primary', { exact: true })).toBeVisible();

    // Primitive specimens render.
    await expect(page.getByRole('button', { name: 'Primary', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Destructive', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();

    // Progress specimen — value forwarded to the Radix root (TASK-377 follow-up).
    const progress = page.getByRole('progressbar', { name: 'Sample progress' });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '64');

    // Metrics primitives: sample chart with its sr-only data table.
    await expect(page.getByRole('img', { name: 'Sample consultation volume bar chart' })).toBeVisible();
  });

  test('section anchor nav shows on md+ and hides on mobile', async ({ page, loginAs }, testInfo) => {
    await loginAs('superAdmin');
    await page.goto('/components');
    await page.waitForURL('**/components', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Components', exact: true })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Showcase sections' });
    if (testInfo.project.name === 'mobile') {
      await expect(nav).toBeHidden();
    } else {
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('link')).toHaveCount(6);
    }
  });

  test('tenant-admin deep-link is bounced off /components', async ({ page, loginAs }) => {
    await loginAs('tenantAdmin');
    await page.goto('/components');
    // Guard property: the non-super-admin never stays on the surface.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).not.toBe('/components');
    await expect(page.getByRole('heading', { name: 'Color tokens', exact: true })).toHaveCount(0);
  });
});
