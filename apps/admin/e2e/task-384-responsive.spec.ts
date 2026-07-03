/**
 * TASK-384 — Responsive Admin Surfaces (frontend E2E).
 *
 * This ticket OWNS the responsive-primitive assertions: it proves the approved
 * Desktop / Tablet / Mobile transformations (foundation `07 · Responsive`
 * `62:1082`) are wired across the real admin UI. The single spec runs under all
 * three Playwright PROJECTS declared in `apps/admin/playwright.config.ts`
 * (desktop 1280×800 · tablet 834×1112 · mobile 390×844); each test branches its
 * expectations on `testInfo.project.name`.
 *
 * What's asserted per tier:
 *   - SHELL    sidebar full (desktop) · icon-rail (tablet) · hidden + drawer (mobile)
 *   - GRID     `VirtualizedDataGrid` table (desktop/tablet) · card-list + FAB (mobile)
 *   - DETAIL   horizontal underline tabs (desktop/tablet) · `Select` (mobile)
 *   - DIALOG   centered modal (desktop/tablet) · full-screen (mobile)
 *   - A11Y     mobile primary targets ≥ 44px (WCAG 2.2 AA · 2.5.8)
 *
 * RUN (needs a seeded stack — see e2e/README.md):
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts task-384-responsive
 * DISCOVER WITHOUT A STACK (authored-spec gate):
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts --list
 */
import { test, expect } from './fixtures/auth';

type Tier = 'desktop' | 'tablet' | 'mobile';

/** Map the running Playwright project to a responsive tier. */
function tierOf(name: string): Tier {
  if (name === 'mobile' || name === 'tablet' || name === 'desktop') return name;
  return 'desktop';
}

const MIN_TOUCH_TARGET = 44; // WCAG 2.2 AA · 2.5.8 Target Size (Minimum)

test.describe('TASK-384 — responsive admin surfaces', () => {
  test('app shell: full sidebar (desktop) · icon-rail (tablet) · drawer (mobile)', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin'); // lands on /tenants

    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    const primaryNav = page.getByRole('navigation', { name: 'Primary' });
    const brandSubtitle = page.getByText('Admin Console', { exact: true });

    if (tier === 'mobile') {
      // Sidebar is off-canvas; an app-bar hamburger reveals the modal drawer.
      await expect(hamburger).toBeVisible();

      // The hamburger is a ≥44px touch target.
      const box = await hamburger.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

      await hamburger.click();
      await expect(primaryNav).toBeVisible();
      // The drawer pins the working-tenant switcher at its bottom.
      await expect(page.getByRole('button', { name: /Switch working tenant/i })).toBeVisible();
    } else {
      // Tablet + desktop keep a persistent sidebar (no hamburger).
      await expect(hamburger).toBeHidden();
      await expect(primaryNav).toBeVisible();

      if (tier === 'desktop') {
        // Full sidebar shows the brand label.
        await expect(brandSubtitle).toBeVisible();
      } else {
        // Icon-rail hides the brand/nav labels (kept accessible via aria-label).
        await expect(brandSubtitle).toBeHidden();
      }
    }
  });

  test('tenants: data-grid table (desktop/tablet) vs card-list + FAB (mobile)', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/tenants');

    const grid = page.locator('[data-slot="virtualized-data-grid"]');
    const cardList = page.locator('[data-slot="responsive-card-list"]');
    const newTenant = page.getByRole('button', { name: 'New tenant' });

    if (tier === 'mobile') {
      // Table collapses to a tap-through card-list with a FAB primary action.
      await expect(cardList).toBeVisible();
      await expect(grid).toHaveCount(0);

      // The mobile card-list owns its own search field.
      await expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible();

      // The "New tenant" CTA is the FAB (the desktop header button is max-md:hidden).
      await expect(newTenant).toBeVisible();
      const fab = await newTenant.boundingBox();
      expect(fab).not.toBeNull();
      expect(fab!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(fab!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    } else {
      // Desktop + tablet render the grid (tablet just drops low-priority columns).
      await expect(grid).toBeVisible();
      await expect(cardList).toHaveCount(0);
      // The primary action is the header button, not a FAB.
      await expect(newTenant).toBeVisible();
    }
  });

  test('tenant detail: underline tabs (desktop/tablet) vs Select (mobile)', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/tenants');

    // Open the first tenant — grid row on desktop/tablet, card on mobile.
    if (tier === 'mobile') {
      await page.locator('[data-slot="responsive-card-list"] li button').first().click();
    } else {
      await page.locator('[data-slot="data-grid-row"]').first().click();
    }
    await page.waitForURL('**/tenants/**');

    const sectionSelect = page.getByRole('combobox', { name: 'Tenant section' });
    const tabNav = page.getByRole('navigation', { name: 'Tenant sections' });

    if (tier === 'mobile') {
      await expect(sectionSelect).toBeVisible();
      await expect(tabNav).toBeHidden();
    } else {
      await expect(tabNav).toBeVisible();
      await expect(sectionSelect).toBeHidden();
    }
  });

  test('mutation dialog: full-screen on mobile, centered otherwise', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/tenants');

    // Open the create-tenant dialog (FAB on mobile, header button otherwise —
    // both expose the accessible name "New tenant").
    await page.getByRole('button', { name: 'New tenant' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    if (tier === 'mobile') {
      // `MOBILE_DIALOG_CONTENT` makes the modal fill the viewport width. The dialog
      // animates in (zoom-in-95), so an early boundingBox catches it mid-scale
      // (~95% ≈ full − 1); poll until the open animation settles full-bleed.
      await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(viewport!.width - 4);
    } else {
      // Desktop/tablet keep the centered, width-capped modal.
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThan(viewport!.width);
    }
  });
});
