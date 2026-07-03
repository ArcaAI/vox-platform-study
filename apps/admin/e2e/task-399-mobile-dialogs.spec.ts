/**
 * TASK-399 — Mobile full-screen dialogs · long tail (D6 / RSP-04.7).
 *
 * TASK-384 established the mobile dialog pattern (`MOBILE_DIALOG_CONTENT` +
 * footer fragments in `src/lib/responsive.ts`) and applied it to the
 * high-traffic mutation dialogs, deferring the long tail (§7). This ticket
 * applies the SAME pattern to the remaining dialogs/sheets — role & policy
 * forms, `AlertDialog` confirms, entitlement dialogs, agent dialogs, settings /
 * API-keys dialogs, the role-policies sheet — and bumps in-form `Input`/`Select`
 * controls to ≥44px touch targets on mobile.
 *
 * This spec drives the REAL UI (dev server :5174 → API :8868) across the three
 * viewport projects and asserts, per tier:
 *   - mobile  → the treated dialog/sheet fills the viewport (the fragment's
 *               full-bleed geometry), footer actions ≥44px, in-form controls ≥44px
 *   - desktop/tablet → the centered, width-capped modal is UNCHANGED
 *
 * Non-destructive: dialogs are opened and dismissed (Cancel/Escape) — nothing
 * is ever submitted; no data is written. Mobile runs also drop screenshot
 * evidence into `.uxu-verify/task-399-*.png`.
 *
 * RUN (stack already up; never rebuilds/restarts the API):
 *   SKIP_DB_PRECHECK=true pnpm --filter @arcaai/admin exec playwright test task-399
 *
 * @see docs/implementation/TASK-399-Mobile-Dialogs-Long-Tail/README.md
 */
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/auth';

type Tier = 'desktop' | 'tablet' | 'mobile';

function tierOf(name: string): Tier {
  if (name === 'mobile' || name === 'tablet' || name === 'desktop') return name;
  return 'desktop';
}

const MIN_TOUCH_TARGET = 44; // WCAG 2.2 AA · 2.5.8 Target Size (Minimum)
/** Open animations scale from 95% — tolerate sub-pixel rounding at full bleed. */
const FULL_BLEED_TOLERANCE = 4;

/** Seeded non-system, ENABLED customer tenant (cross-tenant E2E anchor). */
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';

/**
 * Assert the treated modal follows the responsive contract: full-bleed on
 * mobile (`MOBILE_DIALOG_CONTENT` geometry), centered + width-capped otherwise.
 * Polls because the open animation (`zoom-in-95` / slide) settles asynchronously.
 */
async function expectResponsiveModal(page: Page, modal: Locator, tier: Tier): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await expect(modal).toBeVisible();

  if (tier === 'mobile') {
    // Poll on position + size so this only passes once the enter animation
    // (zoom/slide transforms) has fully settled at true full-bleed.
    await expect
      .poll(async () => {
        const box = await modal.boundingBox();
        if (!box) return false;
        return (
          Math.abs(box.x) <= FULL_BLEED_TOLERANCE &&
          box.width >= viewport!.width - FULL_BLEED_TOLERANCE &&
          box.height >= viewport!.height - FULL_BLEED_TOLERANCE
        );
      })
      .toBe(true);
  } else {
    await expect.poll(async () => (await modal.boundingBox())?.width ?? 0).toBeGreaterThan(0);
    const box = await modal.boundingBox();
    expect(box!.width).toBeLessThan(viewport!.width);
    expect(box!.height).toBeLessThanOrEqual(viewport!.height);
  }
}

/**
 * Assert a control meets the ≥44px mobile touch-target (and stays compact on
 * desktop). Polls: while the open animation runs (`zoom-in-95`, sheet slide)
 * `getBoundingClientRect` reports transform-scaled transient heights.
 */
async function expectTouchHeight(control: Locator, tier: Tier): Promise<void> {
  await expect(control).toBeVisible();
  const height = async () => (await control.boundingBox())?.height ?? 0;
  if (tier === 'mobile') {
    // Half-pixel tolerance: device-pixel snapping (e.g. DPR 2.75) can report
    // 44 CSS px as ~43.88.
    await expect.poll(height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 0.5);
  } else {
    // Desktop/tablet presentation is unchanged: default h-9 (36px) / h-8 (32px).
    await expect.poll(height).toBeGreaterThan(0);
    expect(await height()).toBeLessThan(40);
  }
}

/** Mobile-only screenshot evidence into the repo-root `.uxu-verify/` convention. */
async function snapMobile(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (tierOf(testInfo.project.name) !== 'mobile') return;
  const configFile = testInfo.config.configFile;
  const repoRoot = configFile ? path.resolve(path.dirname(configFile), '../..') : path.resolve(process.cwd(), '../..');
  await page.screenshot({ path: path.join(repoRoot, '.uxu-verify', `${name}.png`) });
}

test.describe('TASK-399 — mobile full-screen dialogs (long tail)', () => {
  test('role form dialog: full-screen + 44px controls on mobile, centered otherwise', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/roles');

    await page.getByRole('button', { name: 'New role' }).click();
    const dialog = page.getByRole('dialog');
    await expectResponsiveModal(page, dialog, tier);

    // In-form Input + Select trigger carry the ≥44px mobile bump.
    await expectTouchHeight(dialog.locator('#role-name'), tier);
    await expectTouchHeight(dialog.locator('#role-parent'), tier);
    // Footer actions carry the ≥44px mobile bump.
    await expectTouchHeight(dialog.getByRole('button', { name: 'Cancel' }), tier);
    await expectTouchHeight(dialog.getByRole('button', { name: 'Create role' }), tier);

    await snapMobile(page, testInfo, 'task-399-mobile-role-form-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('policy form dialog (large editor): full-screen on mobile, 70vw/80vh otherwise', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/roles');

    await page.getByRole('tab', { name: 'Policies' }).click();
    await page.getByRole('button', { name: 'New policy' }).click();
    const dialog = page.getByRole('dialog');
    await expectResponsiveModal(page, dialog, tier);

    await expectTouchHeight(dialog.locator('#policy-name'), tier);
    await expectTouchHeight(dialog.getByRole('button', { name: 'Cancel' }), tier);
    await expectTouchHeight(dialog.getByRole('button', { name: 'Create policy' }), tier);

    await snapMobile(page, testInfo, 'task-399-mobile-policy-form-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('AlertDialog confirm (tenant Disable): full-screen on mobile, centered otherwise', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    // Deep-link to the seeded ENABLED, non-system ArcaAI tenant detail.
    await page.goto(`/tenants/${ARCAAI_TENANT_ID}`);

    const disable = page.getByRole('button', { name: 'Disable', exact: true });
    await expect(disable).toBeVisible();
    await disable.click();

    const confirm = page.getByRole('alertdialog');
    await expectResponsiveModal(page, confirm, tier);
    await expectTouchHeight(confirm.getByRole('button', { name: 'Cancel' }), tier);
    await expectTouchHeight(confirm.getByRole('button', { name: 'Disable tenant' }), tier);

    await snapMobile(page, testInfo, 'task-399-mobile-alertdialog-confirm');
    // NON-DESTRUCTIVE: always back out — the tenant is never disabled. Escape
    // (not a coordinate click): the tenant detail page has a pre-existing
    // horizontal overflow (sr-only table wider than the device) that makes
    // mobile Chrome expand the layout viewport, skewing touch coordinates.
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
  });

  test('role policies sheet: full-screen + 44px search on mobile', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/roles');

    await page
      .getByRole('button', { name: /^Manage policies for / })
      .first()
      .click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (tier === 'mobile') {
      // Edge-to-edge on mobile (w-full, h-full). Poll on x too — the sheet
      // slides in from the right, so width alone passes mid-animation.
      await expect
        .poll(async () => {
          const box = await sheet.boundingBox();
          if (!box) return false;
          return (
            Math.abs(box.x) <= FULL_BLEED_TOLERANCE &&
            box.width >= viewport!.width - FULL_BLEED_TOLERANCE &&
            box.height >= viewport!.height - FULL_BLEED_TOLERANCE
          );
        })
        .toBe(true);
    } else {
      // Desktop/tablet keep the width-capped side sheet (sm:max-w-md ≈ 448px).
      await expect.poll(async () => (await sheet.boundingBox())?.width ?? 0).toBeGreaterThan(0);
      expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(460);
    }
    await expectTouchHeight(sheet.getByRole('textbox', { name: 'Search available policies' }), tier);

    await snapMobile(page, testInfo, 'task-399-mobile-role-policies-sheet');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('settings create dialog: full-screen + 44px in-form controls on mobile', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/settings');

    await page.getByRole('button', { name: 'New setting' }).click();
    const dialog = page.getByRole('dialog');
    await expectResponsiveModal(page, dialog, tier);

    // The in-form bump covers both Input and Select triggers.
    await expectTouchHeight(dialog.locator('#setting-key'), tier);
    await expectTouchHeight(dialog.locator('#setting-type'), tier);
    await expectTouchHeight(dialog.getByRole('button', { name: 'Cancel' }), tier);

    await snapMobile(page, testInfo, 'task-399-mobile-settings-create-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('API keys create dialog: full-screen on mobile, centered otherwise', async ({ page, loginAs }, testInfo) => {
    const tier = tierOf(testInfo.project.name);
    await loginAs('superAdmin');
    await page.goto('/api-keys');

    await page.getByRole('button', { name: 'New API key' }).click();
    const dialog = page.getByRole('dialog');
    await expectResponsiveModal(page, dialog, tier);

    await expectTouchHeight(dialog.locator('#key-name'), tier);
    await expectTouchHeight(dialog.getByRole('button', { name: 'Cancel' }), tier);
    await expectTouchHeight(dialog.getByRole('button', { name: 'Create key' }), tier);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
