/**
 * Tools & MCP (`/tools-mcp`) against a RUNNING stack.
 *
 * WHY THIS FILE EXISTS. moved this screen from tier 10-19 (super-admin
 * only) to tier 20-29 (shared) and replaced the screen-wide `assertSuperAdmin()`
 * gate with a SYSTEM-vs-tenant-owned split gate enforced per ROW. All of that
 * shipped behind jsdom + vitest-axe unit tests only — there was no browser-level
 * proof for either role, and no proof at all for a tenant admin in a real
 * session (see
 * "Runtime verification NOT performed"). This spec is that proof.
 *
 * Skips with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

/**
 * Verbatim from `tools-mcp-screen.tsx`'s `lockedReason` — copied, not
 * retyped, so the em dash and wording can never silently drift from the
 * component under test.
 */
const LOCKED_REASON = 'Platform connector — managed by super administrators';

function lockedName(action: 'Edit' | 'Delete', serverName: string): string {
  return `${action} ${serverName} — unavailable: ${LOCKED_REASON}`;
}

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Tools & MCP' })).toBeVisible();
  const table = page.getByRole('table', { name: 'MCP servers' });
  const emptyState = page.getByText('No MCP servers registered yet');
  await expect(table.or(emptyState)).toBeVisible();
}

function serverRow(page: Page, name: string) {
  return page.getByRole('table', { name: 'MCP servers' }).locator('tbody tr').filter({ hasText: name });
}

/** Opens the create drawer (header trigger — always present, empty state or not) and registers a server. */
async function registerServer(page: Page, name: string, baseUrl = 'https://e2e-task-846.hope.internal/mcp') {
  await page.getByRole('button', { name: 'Register server' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Register MCP server' });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel(/^name/i).fill(name);
  await drawer.getByLabel(/^base url/i).fill(baseUrl);
  await drawer.getByRole('button', { name: 'Register server' }).click();
  await expect(page.getByText('Server registered').first()).toBeVisible();
  await expect(drawer).toBeHidden();
}

async function openEditDrawer(page: Page, name: string) {
  await serverRow(page, name)
    .getByRole('button', { name: `Edit ${name}`, exact: true })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Edit MCP server' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel(/^name/i)).toHaveValue(name);
  return drawer;
}

async function deleteServer(page: Page, name: string) {
  await serverRow(page, name)
    .getByRole('button', { name: `Delete ${name}`, exact: true })
    .click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete MCP server?' });
  await confirm.getByRole('button', { name: 'Delete server' }).click();
  await expect(page.getByText('Server deleted').first()).toBeVisible();
  await expect(serverRow(page, name)).toHaveCount(0);
}

/**
 * Best-effort cleanup for a row that may or may not still be on screen
 * (e.g. the assertion that would have deleted it via the happy path threw
 * first). Mirrors the try/finally shape `departments.spec.ts` uses for its
 * create-and-delete test.
 */
async function deleteServerIfPresent(page: Page, name: string) {
  const row = serverRow(page, name);
  if (await row.isVisible().catch(() => false)) {
    const del = row.getByRole('button', { name: `Delete ${name}`, exact: true });
    if (await del.isEnabled().catch(() => false)) {
      await deleteServer(page, name);
    }
  }
}

interface HarnessPolicySnapshot {
  version: number;
  etag: string;
  mcpToolsEnabled: boolean | null;
}

/** Reads the effective (already tenant→SYSTEM cascaded) MCP master gate — same endpoint the screen's banner reads. */
async function readHarnessPolicy(page: Page): Promise<HarnessPolicySnapshot> {
  return page.evaluate(async () => {
    const res = await fetch('/api/hope/admin/harness/policy');
    if (!res.ok) throw new Error(`GET admin/harness/policy failed (${res.status})`);
    const body = (await res.json()) as { version: number; mcpToolsEnabled?: boolean | null };
    const etag = res.headers.get('etag') ?? `"${body.version}"`;
    return { version: body.version, etag, mcpToolsEnabled: body.mcpToolsEnabled ?? null };
  });
}

/**
 * OCC PATCH of just `mcpToolsEnabled`. There is deliberately no UI
 * editor for this knob yet ( D-1 tracks adding one to
 * `/agentic-policy`), so this replicates the same If-Match mechanics
 * `tools-mcp/api/client.ts#updateMcpServer` uses for the sibling resource.
 */
async function patchMcpToolsEnabled(page: Page, value: boolean | null, current: HarnessPolicySnapshot): Promise<HarnessPolicySnapshot> {
  return page.evaluate(
    async ({ value, etag, version }) => {
      const res = await fetch('/api/hope/admin/harness/policy', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': etag },
        body: JSON.stringify({ mcpToolsEnabled: value, expectedVersion: version, reason: 'e2e:task-846-od-11-gate-check' }),
      });
      if (!res.ok) throw new Error(`PATCH admin/harness/policy failed (${res.status})`);
      const body = (await res.json()) as { version: number; mcpToolsEnabled?: boolean | null };
      const newEtag = res.headers.get('etag') ?? `"${body.version}"`;
      return { version: body.version, etag: newEtag, mcpToolsEnabled: body.mcpToolsEnabled ?? null };
    },
    { value, etag: current.etag, version: current.version },
  );
}

test.describe('tools & mcp — super admin (tier 20-29)', () => {
  test('sees the SYSTEM registry with no working tenant, and that tenant’s rows too once one is selected — every control stays writable', async ({
    page,
  }) => {
    const sysName = `E2E MCP SYS ${Date.now()}`;
    const tenantName = `E2E MCP TEN ${Date.now()}`;
    try {
      // No working tenant selected: the registry is the SYSTEM (platform) tier.
      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await expect(page.getByText('Platform + tenant registry')).toBeVisible();

      await registerServer(page, sysName);
      const sysRow = serverRow(page, sysName);
      await expect(sysRow.getByText('Platform', { exact: true })).toBeVisible();
      await expect(sysRow.getByRole('button', { name: `Edit ${sysName}`, exact: true })).toBeEnabled();
      await expect(sysRow.getByRole('button', { name: `Delete ${sysName}`, exact: true })).toBeEnabled();

      // Select a working tenant and reload — same page, fresh data (the
      // registry's react-query key carries no tenant dimension, so a plain
      // client-side re-render would keep serving the pre-selection cache;
      // `entitlements.spec.ts` uses the identical fetch-then-reload shape).
      await selectWorkingTenant(page);
      await page.reload();
      await waitForSettled(page);

      // The union still carries the SYSTEM row created above...
      await expect(serverRow(page, sysName)).toBeVisible();

      // ...plus a tenant-scoped row, also writable for an elevated caller.
      await registerServer(page, tenantName);
      const tenantRow = serverRow(page, tenantName);
      await expect(tenantRow.getByText('This tenant', { exact: true })).toBeVisible();
      await expect(tenantRow.getByRole('button', { name: `Edit ${tenantName}`, exact: true })).toBeEnabled();
      await expect(tenantRow.getByRole('button', { name: `Delete ${tenantName}`, exact: true })).toBeEnabled();

      // Both rows are reachable from this same (tenant-scoped) view.
      await deleteServer(page, tenantName);
      await deleteServer(page, sysName);
    } finally {
      await deleteServerIfPresent(page, tenantName);
      await deleteServerIfPresent(page, sysName);
    }
  });
});

test.describe('tools & mcp — tenant admin (tier 20-29, OD-7)', () => {
  test('sees its own connectors plus the read-only SYSTEM registry, with the lock reason stated in the accessible name', async ({ page }) => {
    const sysName = `E2E MCP SYS ${Date.now()}`;
    const ownName = `E2E MCP OWN ${Date.now()}`;
    let sysCreated = false;
    let impersonating = false;
    try {
      // A SYSTEM row for the tenant admin to see read-only, created while
      // still the real super admin (a tenant admin cannot write this tier).
      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await registerServer(page, sysName);
      sysCreated = true;

      await impersonateUser(page, 'tenant_admin');
      impersonating = true;
      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await expect(page.getByText('Your connectors + the shared platform registry')).toBeVisible();

      // Sees and can create its OWN connector.
      await registerServer(page, ownName);
      const ownRow = serverRow(page, ownName);
      await expect(ownRow.getByText('This tenant', { exact: true })).toBeVisible();
      await expect(ownRow.getByRole('button', { name: `Edit ${ownName}`, exact: true })).toBeEnabled();
      await expect(ownRow.getByRole('button', { name: `Delete ${ownName}`, exact: true })).toBeEnabled();

      // Sees the SYSTEM row too (read-only registry), but its controls are
      // disabled AND the reason is IN the accessible name — a screen-reader
      // user gets the "why", not just a mute control (rule 11 §5/§11).
      const sysRow = serverRow(page, sysName);
      await expect(sysRow.getByText('Platform', { exact: true })).toBeVisible();
      const lockedEdit = sysRow.getByRole('button', { name: lockedName('Edit', sysName), exact: true });
      const lockedDelete = sysRow.getByRole('button', { name: lockedName('Delete', sysName), exact: true });
      await expect(lockedEdit).toBeVisible();
      await expect(lockedEdit).toBeDisabled();
      await expect(lockedDelete).toBeVisible();
      await expect(lockedDelete).toBeDisabled();
      // Prove the plain (unqualified) name does NOT also match — the reason
      // is the whole story, not an aria-describedby aside.
      await expect(sysRow.getByRole('button', { name: `Edit ${sysName}`, exact: true })).toHaveCount(0);

      // Cleanup while still tenant admin: it owns this row.
      await deleteServer(page, ownName);
    } finally {
      await deleteServerIfPresent(page, ownName);
      if (impersonating) {
        await page.evaluate(() => fetch('/api/auth/revoke-impersonation', { method: 'POST' }));
      }
      if (sysCreated) {
        await page.goto('/tools-mcp');
        await waitForSettled(page);
        await deleteServerIfPresent(page, sysName);
      }
    }
  });

  test('can create, update, and delete its own connector end to end', async ({ page }) => {
    const name = `E2E MCP CRUD ${Date.now()}`;
    try {
      await impersonateUser(page, 'tenant_admin');
      await page.goto('/tools-mcp');
      await waitForSettled(page);

      // CREATE
      await registerServer(page, name, 'https://e2e-task-846-crud.hope.internal/mcp');
      const row = serverRow(page, name);
      await expect(row.getByText('This tenant', { exact: true })).toBeVisible();
      await expect(row.getByText('Disabled', { exact: true })).toBeVisible();

      // UPDATE — flip Enabled and change the description; both must land.
      const editDrawer = await openEditDrawer(page, name);
      await editDrawer.getByLabel('Description').fill('Updated by the e2e CRUD spec');
      await editDrawer.getByLabel(/^enabled/i).click();
      await editDrawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Server updated').first()).toBeVisible();
      await expect(editDrawer).toBeHidden();
      await expect(row.getByText('Enabled', { exact: true })).toBeVisible();
      await expect(row.getByText('Updated by the e2e CRUD spec')).toBeVisible();

      // DELETE
      await deleteServer(page, name);
    } finally {
      await deleteServerIfPresent(page, name);
    }
  });

  test('the OD-11 gate banner warns that connectors are configurable but NOT invocable while the tenant gate is off, and editing stays available', async ({
    page,
  }) => {
    await impersonateUser(page, 'tenant_admin');

    const original = await readHarnessPolicy(page);
    // Only force it off when it was actually ON — the common/default case
    // (no seed sets this true) already resolves OFF and needs no mutation.
    // See the restore step below for the one edge case this leaves open.
    const mustForceOff = original.mcpToolsEnabled === true;
    let latest = original;
    const name = `E2E MCP OD11 ${Date.now()}`;
    try {
      if (mustForceOff) {
        latest = await patchMcpToolsEnabled(page, false, original);
      }

      await page.goto('/tools-mcp');
      await waitForSettled(page);

      const banner = page.getByRole('alert').filter({ hasText: 'MCP tools are turned off for this tenant' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('mcpToolsEnabled');
      await expect(banner).toContainText(/will not call any of them/);
      await expect(banner).toContainText(/registered and edited/);

      // Editing stays available — prove it by actually registering and
      // removing a connector while the gate is off, not just by reading an
      // enabled attribute.
      await expect(page.getByRole('button', { name: 'Register server' }).first()).toBeEnabled();
      await registerServer(page, name);
      await expect(serverRow(page, name)).toBeVisible();
      await deleteServer(page, name);
    } finally {
      await deleteServerIfPresent(page, name);
      if (mustForceOff) {
        // Restore. NOTE: if the original TRUE came from an inherited SYSTEM
        // default (no tenant-owned row) rather than an explicit tenant
        // override, this intentionally pins an explicit tenant row rather
        // than leaving the tenant un-opinionated — the same trade-off
        // `entitlements.spec.ts` accepts for its enforcement-switch restore.
        // No seed sets this true, so in practice `mustForceOff` is false.
        latest = await readHarnessPolicy(page);
        await patchMcpToolsEnabled(page, true, latest);
      }
    }
  });
});

test.describe('tools & mcp — accessibility (WCAG 2.2 AA)', () => {
  test('has no violations for a super admin with a mixed SYSTEM + writable registry (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const name = `E2E MCP A11Y ${Date.now()}`;
    try {
      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await registerServer(page, name);
      await expectNoA11yViolations(page);
    } finally {
      await deleteServerIfPresent(page, name);
    }
  });

  test('has no violations for a super admin with a mixed SYSTEM + writable registry (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const name = `E2E MCP A11Y ${Date.now()}`;
    try {
      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await registerServer(page, name);
      await expectNoA11yViolations(page);
    } finally {
      await deleteServerIfPresent(page, name);
    }
  });

  /**
   * Scans the two a11y surfaces this ticket actually introduced: a locked
   * SYSTEM row (disabled controls with the reason in their name) and the
   * OD-11 gate banner, together, as a tenant admin.
   */
  test('has no violations for a tenant admin with a locked SYSTEM row and the OD-11 banner showing (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await runTenantA11yScan(page);
  });

  test('has no violations for a tenant admin with a locked SYSTEM row and the OD-11 banner showing (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await runTenantA11yScan(page);
  });

  async function runTenantA11yScan(page: Page) {
    const sysName = `E2E MCP A11Y SYS ${Date.now()}`;
    const ownName = `E2E MCP A11Y OWN ${Date.now()}`;
    let sysCreated = false;
    let impersonating = false;
    let mustForceOff = false;
    let latestGate: HarnessPolicySnapshot | null = null;
    try {
      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await registerServer(page, sysName);
      sysCreated = true;

      await impersonateUser(page, 'tenant_admin');
      impersonating = true;

      const original = await readHarnessPolicy(page);
      mustForceOff = original.mcpToolsEnabled === true;
      if (mustForceOff) latestGate = await patchMcpToolsEnabled(page, false, original);

      await page.goto('/tools-mcp');
      await waitForSettled(page);
      await registerServer(page, ownName);
      // Both the locked SYSTEM row and (when the gate happens to be off) the
      // OD-11 banner are now on screen for the same scan.
      await expect(serverRow(page, sysName)).toBeVisible();
      await expect(serverRow(page, ownName)).toBeVisible();

      await expectNoA11yViolations(page);
    } finally {
      await deleteServerIfPresent(page, ownName);
      if (impersonating) {
        if (mustForceOff && latestGate) {
          const current = await readHarnessPolicy(page);
          await patchMcpToolsEnabled(page, true, current);
        }
        await page.evaluate(() => fetch('/api/auth/revoke-impersonation', { method: 'POST' }));
      }
      if (sysCreated) {
        await page.goto('/tools-mcp');
        await waitForSettled(page);
        await deleteServerIfPresent(page, sysName);
      }
    }
  }
});
