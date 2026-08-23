import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable, serviceAvailable, serviceDownMessage } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  // This spec was the only one in the suite with no stack gate, so it failed
  // rather than skipped whenever the stack was absent — including on a bare
  // checkout. Gated like every sibling, plus the harness service it actually
  // drives (the gateway answers 200 while the service it proxies is down).
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  test.skip(!(await serviceAvailable('harness')), serviceDownMessage('harness'));
  await loginAsAdmin(page);
  await selectPipelinePolicyTenant(page);
});

async function selectPipelinePolicyTenant(page: Page) {
  const message = await page.evaluate(async () => {
    const list = await fetch('/api/hope/admin/tenants?page=0&limit=100');
    if (!list.ok) return `Could not list tenants (${list.status})`;
    const body = (await list.json()) as { data?: Array<{ id: string; name?: string }> };
    for (const tenant of body.data ?? []) {
      if (tenant.id.startsWith('00000000')) continue;
      const row = await fetch(`/api/hope/admin/harness/pipeline-policy/row?tenantId=${encodeURIComponent(tenant.id)}&scope=TENANT`);
      if (!row.ok) continue;
      const rowBody = (await row.json()) as { version?: number };
      if (!rowBody.version) continue;
      const set = await fetch('/api/auth/working-tenant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.id, tenantName: tenant.name }),
      });
      return set.ok ? null : `Could not select tenant "${tenant.name ?? tenant.id}" (${set.status})`;
    }
    return 'No tenant with a pipeline policy override is available';
  });
  // A missing override is an ENVIRONMENT gap, not a product defect: this screen
  // has nothing to render without one, so skip with the helper's own message
  // rather than failing three specs on absent data. A genuine failure to SELECT
  // a tenant that does have one still fails, because that is a real fault.
  test.skip(message === 'No tenant with a pipeline policy override is available', message ?? '');
  expect(message).toBeNull();
}

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Realtime Pipeline Policy' })).toBeVisible();
  // The screen settles into the cascade matrix, the no-overrides empty
  // state or the block error state. The alert must be narrowed to the
  // error-block copy — the shell always mounts empty role=alert regions
  // (route announcer, toaster), which would satisfy a bare getByRole and
  // let the helper resolve before the data actually settles.
  const matrix = page.getByRole('table', { name: 'Pipeline policy scope rows' });
  const emptyState = page.getByText('No scope overrides yet');
  const errorState = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
  await expect(matrix.first().or(emptyState.first()).or(errorState.first())).toBeVisible();
}

test.describe('realtime pipeline policy (frame 39)', () => {
  test('shows the header, the filter strip and the cascade panels', async ({ page }) => {
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    await expect(page.getByLabel('Scope:')).toBeVisible();
    await expect(page.getByLabel('Key:')).toBeVisible();
    await expect(page.getByLabel('Show effective:')).toBeVisible();
  });

  test('a matrix row click opens the scope-row editor panel', async ({ page }) => {
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    // Without seeded overrides the screen may open on the empty state —
    // its CTA opens the same TENANT editor. Race both entry points with an
    // auto-waiting assertion (isVisible alone doesn't wait, so checking it
    // straight after settle can take the wrong branch mid-render).
    const tenantRow = page.getByRole('table', { name: 'Pipeline policy scope rows' }).locator('tbody tr', { hasText: 'tenant' }).first();
    const addScopeRow = page.getByRole('button', { name: 'Add scope row' });
    await expect(tenantRow.or(addScopeRow)).toBeVisible();
    if (await tenantRow.isVisible()) {
      await tenantRow.click();
    } else {
      await addScopeRow.click();
    }
    await expect(page.getByRole('radiogroup', { name: 'Auto-summary' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Save row · PUT/ })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('realtime pipeline policy · scope filter and key select (frame 39)', () => {
  test('scope filter narrows the matrix to the selected tier', async ({ page }) => {
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    const matrix = page.getByRole('table', { name: 'Pipeline policy scope rows' });
    await expect(matrix).toBeVisible();
    await page.getByLabel('Scope:').click();
    await page.getByRole('option', { name: 'tenant' }).click();
    const rows = matrix.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('tenant');
  });

  test('key select switches the resolve card and matrix column', async ({ page }) => {
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    const resolveCard = page.getByRole('group', { name: 'Cascade resolve for auto-summary' });
    await expect(resolveCard).toBeVisible();
    await page.getByLabel('Key:').click();
    await page.getByRole('option', { name: 'auto-ner' }).click();
    await expect(page.getByRole('group', { name: 'Cascade resolve for auto-ner' })).toBeVisible();
    await expect(resolveCard).toHaveCount(0);
  });

  test('show-effective toggle switches inherited rows between dash and "· inh" suffix', async ({ page }) => {
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    const matrix = page.getByRole('table', { name: 'Pipeline policy scope rows' });
    await expect(matrix).toBeVisible();
    const inheritedCell = matrix.locator('tbody tr td').filter({ hasText: '\u00b7 inh' }).first();
    await expect(inheritedCell).toBeVisible();
    const effectiveSwitch = page.getByLabel('Show effective:');
    await expect(effectiveSwitch).toBeChecked();
    await effectiveSwitch.click();
    await expect(effectiveSwitch).not.toBeChecked();
    await expect(matrix.locator('tbody tr td').filter({ hasText: '\u00b7 inh' })).toHaveCount(0);
    await effectiveSwitch.click();
    await expect(effectiveSwitch).toBeChecked();
  });
});

test.describe('realtime pipeline policy · scope-row editor (frame 39)', () => {
  test('DOCTOR-scope row disables harnessEnabled with the max-scope note', async ({ page }) => {
    await page.goto('/harness/pipeline-policy?doctor=e2e-readonly-probe');
    await waitForSettled(page);
    const doctorRow = page.getByRole('table', { name: 'Pipeline policy scope rows' }).locator('tbody tr', { hasText: 'doctor' }).first();
    await expect(doctorRow).toBeVisible();
    await doctorRow.click();
    const routingGroup = page.getByRole('radiogroup', { name: 'Harness routing' });
    await expect(routingGroup).toBeVisible();
    for (const radio of await routingGroup.getByRole('radio').all()) {
      await expect(radio).toBeDisabled();
    }
    await expect(page.getByText('Routing cannot be pinned per-doctor (max scope DEPARTMENT).')).toBeVisible();
    await page.getByRole('button', { name: 'Close editor' }).click();
    await expect(routingGroup).toHaveCount(0);
  });

  test('close editor button unmounts the scope-row editor panel', async ({ page }) => {
    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    const tenantRow = page.getByRole('table', { name: 'Pipeline policy scope rows' }).locator('tbody tr', { hasText: 'tenant' }).first();
    const addScopeRow = page.getByRole('button', { name: 'Add scope row' });
    await expect(tenantRow.or(addScopeRow)).toBeVisible();
    if (await tenantRow.isVisible()) {
      await tenantRow.click();
    } else {
      await addScopeRow.click();
    }
    const closeButton = page.getByRole('button', { name: 'Close editor' });
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect(closeButton).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Save row · PUT/ })).toHaveCount(0);
  });

  test('toggle edit + save round-trip on a throwaway scoped row', async ({ page }) => {
    const scopeId = crypto.randomUUID();
    try {
      await page.goto(`/harness/pipeline-policy?department=${encodeURIComponent(scopeId)}`);
      await waitForSettled(page);
      const matrix = page.getByRole('table', { name: 'Pipeline policy scope rows' });
      const departmentRow = matrix.locator('tbody tr', { hasText: `dept ${scopeId}` }).first();
      await expect(departmentRow).toBeVisible();
      await departmentRow.click();

      const summaryGroup = page.getByRole('radiogroup', { name: 'Auto-summary' });
      await expect(summaryGroup).toBeVisible();
      await summaryGroup.getByText('off', { exact: true }).click();
      await page.getByLabel('Reason').fill('pipeline policy e2e round-trip');
      await expect(page.getByText('Unsaved changes')).toBeVisible();
      await page.getByRole('button', { name: /Save row · PUT/ }).click();
      await expect(page.getByText('Unsaved changes')).toHaveCount(0);
      await expect(page.getByText(`dept ${scopeId} · v1`, { exact: true })).toBeVisible();
    } finally {
      const cleanup = await page.evaluate(async (departmentId) => {
        const path = `/api/hope/admin/harness/pipeline-policy/row?scope=DEPARTMENT&scopeId=${encodeURIComponent(departmentId)}`;
        const read = await fetch(path);
        if (!read.ok) return `Could not read throwaway row (${read.status})`;
        const row = (await read.json()) as { version?: number };
        if (!row.version) return null;
        const response = await fetch(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-match': `"${row.version}"` },
          body: JSON.stringify({
            autoSummaryEnabled: null,
            autoNerEnabled: null,
            harnessEnabled: null,
            expectedVersion: row.version,
          }),
        });
        return response.ok ? null : `Could not reset throwaway row (${response.status})`;
      }, scopeId);
      expect(cleanup).toBeNull();
    }
  });

  test('error state renders ErrorState with a working Retry action', async ({ page }) => {
    let failEffectiveRequest = true;
    await page.route('**/api/hope/admin/harness/pipeline-policy**', async (route) => {
      const url = new URL(route.request().url());
      if (failEffectiveRequest && route.request().method() === 'GET' && url.pathname.endsWith('/pipeline-policy')) {
        failEffectiveRequest = false;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 400, message: 'pipeline policy e2e failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/harness/pipeline-policy');
    await waitForSettled(page);
    const errorState = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
    await expect(errorState).toContainText('Couldn’t load this data');
    const retryButton = errorState.getByRole('button', { name: 'Retry' });
    await expect(retryButton).toBeVisible();
    await retryButton.click();
    await expect(page.getByRole('table', { name: 'Pipeline policy scope rows' })).toBeVisible();
    await expect(errorState).toHaveCount(0);
  });
});
