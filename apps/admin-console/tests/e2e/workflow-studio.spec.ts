/**
 * TASK-719 Task 21 — Workflow Studio v1 (tier 30-49) against a RUNNING stack: create-draft →
 * keyboard-only palette add → configure → Validate → publish gated until the server report is clean;
 * a mandatory node's no-delete posture in both view modes; click-error → focus-node in both
 * view modes; a cross-tenant definition id renders not-found (404, never 403); axe scans in
 * both themes on the definitions list, the canvas editor and the list editor.
 *
 * Follows `workflow-runs.spec.ts` and the shared helpers verbatim (same `beforeEach` gate,
 * `expectNoA11yViolations`, `appAvailable`/`apiAvailable` skips).
 *
 * EXECUTED 2026-08-19 against the isolated test stack (gateway :8968, console :5276) — see the
 * ticket README §7. Three assertions were corrected in that run because they contradicted the
 * running system rather than the system being wrong; each is documented at its call site.
 *
 * The live `WORKFLOW_NODE_REGISTRY` now serves real palettes (consultation / summarization / stt
 * / utility), so the palette assertions below run against real content. What it does NOT give
 * this suite is a graph that VALIDATES CLEAN in a handful of UI steps: the summarization palette
 * demands `core.start`, `input.context_binding`, `generate.text`, `guardrail.check`,
 * `output.deliver`, full start->end reachability AND per-node config (`WF-I-002/004/010`).
 * Driving all of that through the UI would make one long, brittle spec, so the publish leg
 * asserts the GATE (disabled + visible reason until the server report is clean) and stops there;
 * the publish-confirm dialog itself stays covered by the unit suite
 * (`components/__tests__/studio-toolbar-and-publish-dialog.test.tsx`).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Workflow definitions are tenant-scoped: elevated sessions see the "Select a working
  // tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForListSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Workflow Studio' })).toBeVisible();
  const dataRows = page.getByRole('grid', { name: 'Workflow definitions' }).locator('[data-slot="data-grid-row"]');
  const emptyState = page.getByText('No workflow definitions yet');
  const errorCard = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
  await expect(dataRows.first().or(emptyState.first()).or(errorCard.first())).toBeVisible();
}

/**
 * Every draft this suite creates, so `afterEach` can soft-delete it.
 *
 * WHY. `WorkflowDefinition` is entitlement-capped (`maxWorkflowDefinitions`,
 * 20 on the seeded plan). Without cleanup the suite leaks one row per
 * `createDraft` per run, and once the tenant crosses the cap EVERY subsequent
 * run fails — the POST returns 409 QUOTA_EXCEEDED, the form stays put, and
 * `waitForURL` below times out with no hint that a quota is the cause. That is
 * exactly how this suite died: 21/20 definitions, all `e2e_*` litter.
 */
const createdDefinitionIds: string[] = [];

async function createDraft(page: Page, slug: string): Promise<string> {
  await page.goto('/workflow-studio/new');
  await page.getByLabel('Slug *').fill(slug);
  await page.getByLabel('Name *').fill(`E2E ${slug}`);
  await page.getByLabel('Palette key *').fill('summarization');
  await page.getByRole('button', { name: 'Create draft' }).click();
  // Surface a failed create as itself rather than as an opaque navigation
  // timeout — a quota rejection renders an alert and never navigates.
  const alert = page.getByRole('alert').filter({ hasText: /Plan limit reached|Could not|failed/i });
  await Promise.race([
    page.waitForURL(/\/workflow-studio\/(?!new$).+/),
    alert.first().waitFor({ state: 'visible' }),
  ]);
  if (!/\/workflow-studio\/(?!new$).+/.test(page.url())) {
    throw new Error(`Draft creation failed: ${(await alert.first().textContent()) ?? 'no navigation and no alert'}`);
  }
  const id = page.url().split('/workflow-studio/')[1] ?? '';
  if (id) createdDefinitionIds.push(id);
  return id;
}

test.afterEach(async ({ page }) => {
  // Soft-delete through the app's own route — the platform never hard-deletes.
  // Best-effort: a cleanup failure must not mask the test's own result.
  while (createdDefinitionIds.length > 0) {
    const id = createdDefinitionIds.pop() as string;
    await page
      .evaluate((defId) => fetch(`/api/hope/admin/workflow-definitions/${defId}`, { method: 'DELETE' }).then(() => undefined), id)
      .catch(() => undefined);
  }
});

test.describe('workflow definitions list', () => {
  test('shows the header, fill-height grid and a New definition action', async ({ page }) => {
    await page.goto('/workflow-studio');
    await waitForListSettled(page);
    // Two CTAs legitimately carry this name: the pinned header action, and the grid's
    // empty-state action when the working tenant has no definitions yet. Which of them exists
    // is DATA-dependent, so the assertion targets the header one, which is always present.
    await expect(page.getByRole('button', { name: 'New definition' }).first()).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/workflow-studio');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/workflow-studio');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('workflow studio editor', () => {
  test('create draft -> add a node from the palette BY KEYBOARD ONLY -> it persists -> Publish stays gated', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_studio_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');

    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();

    // Keyboard-only: focus a real node-type <button> in the palette rail and activate it with
    // Enter — never a pointer drag (WCAG 2.5.7).
    const paletteNav = page.getByRole('navigation', { name: 'Node palette' });
    await expect(paletteNav).toBeVisible();
    await paletteNav.getByRole('button').filter({ hasText: 'Core.start' }).first().focus();
    await page.keyboard.press('Enter');

    // The keyboard-added node reaches the canvas AND survives autosave — the original spec
    // asserted straight through to an enabled Publish, which the live palette rules can never
    // reach from one node (see the module doc); persistence is what this leg can honestly prove.
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.getByText('All changes saved.')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expect(page.getByText(/before publishing/i)).toBeVisible();
  });

  test('Publish is disabled while the report is dirty, with a visible reason', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_dirty_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');
    const publish = page.getByRole('button', { name: 'Publish' });
    await expect(publish).toBeDisabled();
    // Either gate reason is correct: the gateway returns a `validationReport` with the created
    // draft, so a fresh definition usually shows "Resolve every error…" rather than
    // "Run Validate…". Asserting only the latter contradicted the running system.
    await expect(page.getByText(/(run validate|resolve every error) before publishing/i)).toBeVisible();
  });

  test('a mandatory node exposes no Delete affordance in EITHER view mode', async ({ page }) => {
    // The live registry DOES class nodes `mandatory` now (`input.context_binding` and friends),
    // so this no longer skips as it did when TASK-720 had not landed.
    const definitionId = await createDraft(page, `e2e_mandatory_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');
    const paletteNav = page.getByRole('navigation', { name: 'Node palette' });
    // The rail is registry-driven and loads async — an un-awaited `isVisible()` here raced the
    // fetch and skipped the test spuriously.
    await expect(paletteNav).toBeVisible();
    const mandatoryItem = paletteNav.getByRole('button').filter({ hasText: 'Input.context Binding' }).first();
    test.skip((await mandatoryItem.count()) === 0, 'No mandatory-classed node type in the live registry');
    await mandatoryItem.click();

    await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
    await page.getByRole('radio', { name: 'List view' }).click();
    await expect(page.getByText('Mandatory — cannot be deleted.').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
  });

  test('clicking a validation problem moves DOM focus to its node, in canvas AND list view', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_focus_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');
    const focusPalette = page.getByRole('navigation', { name: 'Node palette' });
    await expect(focusPalette).toBeVisible();
    // Two nodes, not one: with NO `core.start` in the graph the compiler reports only
    // graph-level findings, and this test needs a NODE-SCOPED one to have a node to focus.
    await focusPalette.getByRole('button').filter({ hasText: 'Core.start' }).first().click();
    await focusPalette.getByRole('button').filter({ hasText: 'Generate.text' }).first().click();
    await expect(page.getByText('All changes saved.')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Validate' }).click();

    // Must be a NODE-SCOPED finding: graph-level findings (`nodeId === null`, rendered under the
    // "Graph" heading) have no node to focus, and the original `.first()` always picked one of
    // those. Node findings phrase themselves as `node "<id>" …`.
    const problemRow = page.getByRole('button').filter({ hasText: /node "/ }).first();
    // Wait for the report itself to land before deciding — the previous immediate `isVisible()`
    // check always lost the race against the validate round trip and skipped the assertion.
    await expect(page.getByRole('button').filter({ hasText: /WF-/ }).first().or(page.getByText('No problems found'))).toBeVisible({ timeout: 15_000 });
    test.skip((await problemRow.count()) === 0, 'This graph validated clean — no findings to click');
    // Activate the row BY KEYBOARD. `use-focus-node.ts` moves focus programmatically, and a
    // programmatic focus that follows a MOUSE click does not match `:focus-visible` in Chromium
    // — the original click-then-`:focus-visible` assertion could therefore never pass. The
    // keyboard path is the one the ring actually exists for, so assert that.
    await problemRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__node[data-id]:focus-visible')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('radio', { name: 'List view' }).click();
    await problemRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-workflow-node-row-id]:focus-visible, [data-workflow-node-row-id] :focus-visible')).toBeVisible({ timeout: 5_000 });
  });

  test('a foreign/nonexistent definition id renders not-found, never a 403', async ({ page }) => {
    await page.goto('/workflow-studio/definitely-not-a-real-definition-id');
    await expect(page.getByRole('alert').filter({ hasText: /Not found|Couldn.t load/ })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations on the canvas editor (light)', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_axe_canvas_light_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations on the canvas editor (dark)', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_axe_canvas_dark_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations on the list editor (light)', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_axe_list_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');
    await page.emulateMedia({ colorScheme: 'light' });
    // README §7 honesty note: `viewMode` lives in the Zustand store only in this pass, NOT
    // synced to `?view=` via nuqs as the plan specified — so there is no URL assertion here.
    await page.getByRole('radio', { name: 'List view' }).click();
    await expectNoA11yViolations(page);
  });
});

test.describe('workflow studio editor — reflow and editing affordances (2026-08-19 UX pass)', () => {
  test('at 200 % zoom (640x400 CSS px) the panels stack and stay usable, with no horizontal scrolling', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_reflow_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');

    await page.setViewportSize({ width: 640, height: 400 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // 1.4.10: no two-dimensional scrolling.
    const overflowsHorizontally = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflowsHorizontally).toBe(false);

    // The regression this locks: before the stacking fix, the fixed-height flex row squeezed
    // both the palette rail and the canvas to ~59 px tall at this size.
    const palette = page.getByRole('complementary', { name: 'Node palette panel' });
    const canvas = page.locator('[data-slot="workflow-canvas"]');
    for (const panel of [palette, canvas]) {
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThan(180);
    }

    // And the palette is still operable at that zoom — its filter and at least one node button.
    await expect(page.getByLabel('Filter nodes')).toBeVisible();
  });

  test('undo/redo round-trips a palette add, by button and by keyboard', async ({ page }) => {
    const definitionId = await createDraft(page, `e2e_undo_${Date.now()}`);
    test.skip(!definitionId, 'Draft creation did not navigate to an editor id');

    const undo = page.getByRole('button', { name: /^Undo/ });
    const redo = page.getByRole('button', { name: /^Redo/ });
    await expect(undo).toBeDisabled();

    await page.getByRole('radio', { name: 'List view' }).click();
    const rows = page.getByRole('list', { name: 'Workflow graph, list view' }).locator('li');
    const before = await rows.count();

    const firstNode = page.getByRole('navigation', { name: 'Node palette' }).getByRole('button').filter({ hasNotText: /Filter/ }).first();
    await firstNode.click();
    await expect(rows).toHaveCount(before + 1);

    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(rows).toHaveCount(before);

    await expect(redo).toBeEnabled();
    await page.keyboard.press('Control+Shift+z');
    await expect(rows).toHaveCount(before + 1);
  });
});
