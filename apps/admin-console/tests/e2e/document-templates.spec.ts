/**
 * Document Templates (TASK-810 task 14) against a RUNNING stack.
 *
 * WHY THIS FILE EXISTS. TASK-810 §7b "Outstanding verification" recorded that the
 * authoring screen had never been exercised logged-in against a live gateway —
 * its component tree was covered by jsdom tests only, and TASK-814's browser pass
 * covered the six PLAYGROUND screens, not this one. Every other tenant-scoped
 * screen in this suite has a spec; `/document-templates` was the gap.
 *
 * What it pins, beyond "the screen renders":
 *   - the tier 30–49 contract (rule 12 §5): no working tenant ⇒ the NoTenant gate,
 *     never a 400 or an empty grid pretending to be an empty catalog;
 *   - the head/version/pin triple end to end — publish mints, an IDENTICAL
 *     re-publish is a NO-OP (the §7b checksum short-circuit, previously proven
 *     only by unit test), and an older version can be re-pinned to roll back;
 *   - the axe gate in both themes (rule 11 §11).
 *
 * Slugs are unique per run, so the spec is re-runnable without a delete step and
 * without contending with a sibling worker.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const URL = '/document-templates';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

/** The catalog has landed when the heading and either a card or the empty state is up. */
async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Document Templates' })).toBeVisible();
  await expect(
    page
      .getByText('No document templates yet')
      .first()
      .or(page.getByRole('button', { name: 'New template' }).first())
      .first(),
  ).toBeVisible();
}

test.describe('document templates — screen', () => {
  test('without a working tenant it shows the NoTenant gate, not an empty catalog', async ({ page }) => {
    // Deliberately NO selectWorkingTenant(): tier 30–49 screens must refuse to
    // guess a tenant for an elevated session (rule 12 §5).
    await page.goto(URL);
    await expect(page.getByRole('heading', { level: 1, name: 'Document Templates' })).toBeVisible();
    await expect(page.getByText('Select a working tenant')).toBeVisible();
  });

  test('with a working tenant it shows the catalog and the New action', async ({ page }) => {
    await selectWorkingTenant(page);
    await page.goto(URL);
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'New template' }).first()).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await selectWorkingTenant(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(URL);
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips the
    // .dark class without touching client storage.
    await selectWorkingTenant(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(URL);
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('document templates — authoring', () => {
  test('creates, publishes, no-ops an identical re-publish, and re-pins an older version', async ({ page }) => {
    const stamp = Date.now();
    const slug = `e2e_doc_${stamp}`;
    const name = `E2E Doc ${stamp}`;

    await selectWorkingTenant(page);
    await page.goto(URL);
    await waitForSettled(page);

    // --- create -------------------------------------------------------------
    await page.getByRole('button', { name: 'New template' }).first().click();
    const createDrawer = page.getByRole('dialog');
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByRole('textbox', { name: /^Name/ }).fill(name);
    await createDrawer.getByRole('textbox', { name: /^Slug/ }).fill(slug);
    await createDrawer.getByRole('button', { name: 'Create template' }).click();

    // The drawer becomes the template's own detail surface: DRAFT, no version.
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('tab', { name: 'Shape' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Versions (0)' })).toBeVisible();

    // --- shape --------------------------------------------------------------
    await drawer.getByRole('tab', { name: 'Shape' }).click();
    await drawer.getByRole('button', { name: 'Start from SOAP' }).click();
    // A published version needs a title; "Start from SOAP" supplies the platform
    // one, which is NOT this document's name — see the §7b note this spec adds.
    await drawer.getByRole('textbox', { name: /^Document title/ }).fill(name);

    // --- publish v1 ---------------------------------------------------------
    await drawer.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(drawer.getByRole('tab', { name: 'Versions (1)' })).toBeVisible();

    // --- an IDENTICAL re-publish mints nothing (§7b checksum short-circuit) ---
    await drawer.getByRole('button', { name: 'Publish', exact: true }).click();
    // Give a mint, if one were wrongly happening, time to land before asserting.
    await page.waitForTimeout(1_500);
    await expect(drawer.getByRole('tab', { name: 'Versions (1)' })).toBeVisible();

    // --- a CHANGED shape does mint --------------------------------------------
    // The new section must be COMPLETED before it can be published: a section
    // is created with an empty key, and publish validates the shape. Filling it
    // is the real authoring path, not a convenience for the test.
    await drawer.getByRole('tab', { name: 'Shape' }).click();
    await drawer.getByRole('button', { name: 'Add section' }).first().click();
    // A new section is appended COLLAPSED; its editor mounts on disclosure.
    await drawer.getByRole('button', { name: /PROSE/ }).last().click();
    await drawer.getByRole('textbox', { name: /^Key/ }).fill('discharge_medications');
    await drawer.getByRole('textbox', { name: /^Title/ }).fill('Discharge Medications');
    await drawer.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(drawer.getByRole('tab', { name: 'Versions (2)' })).toBeVisible();

    // --- roll back by re-pinning v1 -------------------------------------------
    await drawer.getByRole('tab', { name: 'Versions (2)' }).click();
    await drawer.getByRole('button', { name: 'Pin version 1' }).click();
    await expect(drawer.getByRole('button', { name: 'Pin version 2' })).toBeVisible();
  });
});
